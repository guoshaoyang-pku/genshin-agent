import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RealtimeDispatcher, UnsupportedRealtimeOperation, processPickText, doNotPick, filterDialogueOcr, selectHangoutOption, parseExpeditionCards, selectExpeditionCard, runOneKeyExpedition, runLegacyExpedition } from './realtime.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (text = '', x = 1250, y = 500, width = 150, height = 30) => ({ text, x, y, width, height });
const pickRegion = region('', 1100, 500, 30, 30);
function fixture({ find = () => [], lines = () => [], pickText = '甜甜花', scene = {}, pixel = () => [0, 0, 0], orange = () => false, controller, onInput, onCapture, width = 1920, height = 1080 } = {}) {
  let clock = 0, handle = 0, frames = 0;
  const calls = [], images = new Map();
  const host = {
    sourceRoot, calls, images, signal: controller?.signal, now: () => clock,
    advance(ms) { clock += ms; },
    async sleep(ms) { clock += ms; },
    async input(method, args = []) { calls.push({ method, args, at: clock }); await onInput?.(method, args); },
    async capture() { frames++; await onCapture?.(); const image = { handle: ++handle, width, height, frame: frames }; images.set(handle, image); return image; },
    async vision(op, args) {
      if (op === 'recognition.load') {
        const json = JSON.parse(await readFile(args.path, 'utf8')); assert.ok(json.objects[args.objectName], args.objectName);
        const group = args.path.split('/GameTask/')[1].split('/Assets/')[0];
        const ro = { ...json.objects[args.objectName], name: args.objectName, group };
        if (ro.template) ro.template_path = path.join(path.dirname(args.path), '1920x1080', ro.template);
        return ro;
      }
      if (op === 'image.dispose') { images.delete(args.handle); return; }
      const image = images.get(args.handle); assert.ok(image, op + ' handle ' + args.handle);
      if (op === 'image.find' || op === 'image.findMulti') { const values = await find(args.recognition.name, image.frame, args.recognition); return op === 'image.findMulti' ? values : values[0] ?? empty; }
      if (op === 'image.ocr') return lines(image.frame, args.recognition.roi);
      if (op === 'realtime.pickText') return { text: typeof pickText === 'function' ? pickText(image.frame, args) : pickText, alreadyPicking: false };
      if (op === 'realtime.skipScene') return { blackRate: 0, bottomTriangle: null, characterPopup: null, goodsRects: [], ...(typeof scene === 'function' ? scene(image.frame) : scene) };
      if (op === 'image.crop') { const result = { ...image, handle: ++handle, x: args.x, y: args.y, width: args.width, height: args.height }; images.set(handle, result); return result; }
      if (op === 'image.mat') {
        if (args.method === 'At') return pixel(args.args[0], args.args[1], image.frame);
        if (args.method === 'CountNonZero') return orange(image.y) ? image.width * image.height : 0;
        if (args.method === 'CvtColor' || args.method === 'InRange') { const result = { ...image, handle: ++handle }; images.set(handle, result); return result; }
      }
      throw new Error('Unexpected operation ' + op + ' ' + (args.method ?? ''));
    },
    get frameCount() { return frames; },
  };
  return host;
}
const inputs = host => host.calls.filter(call => call.method !== 'releaseAll');
async function tick(host, dispatcher, ms = 250) { host.advance(ms); return dispatcher.tick(); }

// These are original source texts/list entries, not generated mirrors of the filtering implementation.
test('pick OCR cleanup and dynamic exclusions preserve upstream Chinese boundaries', () => {
  for (const [raw, expected] of [[' F 甜 甜花 1', '甜甜花'], ['【调查 123', '「调查」'], ['调查]!', '「调查」'], ['123 abc', ''], ['领取奖励！ 9', '领取奖励！']]) assert.equal(processPickText(raw), expected);
  for (const text of ['长时间', '我在回声之子声望', '霜月工坊', '聚所', '叮铃', '眶螂', '蛋卷工坊', '西风成垒', '望崖营壁', '魔女的花园', '月谕圣牌']) assert.equal(doNotPick(text), true, text);
  assert.equal(doNotPick('甜甜花'), false);
});

test('source whitelist and user subtraction take effect; NPC exclusion precedes even a whitelisted text', async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), 'bgi-realtime-'));
  try {
    const host = fixture({ find: name => name === 'F' ? [pickRegion] : [] });
    const dispatcher = new RealtimeDispatcher(host, { userRoot }); dispatcher.addTrigger({ name: 'AutoPick' });
    await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.args), [['F']]);
    await writeFile(path.join(userRoot, 'pick_whitelist_mode_do_not_pick_lists.txt'), '甜甜花'); dispatcher.reloadLists();
    await tick(host, dispatcher); assert.equal(inputs(host).length, 1); assert.equal(host.images.size, 0);
    await dispatcher.close();
    const npcHost = fixture({ find: name => name === 'F' ? [pickRegion] : name === 'ChatIcon' ? [region()] : [] });
    const npc = new RealtimeDispatcher(npcHost); npc.addTrigger({ name: 'AutoPick' }); await npc.tick(); assert.equal(inputs(npcHost).length, 0); await npc.close();
  } finally { await rm(userRoot, { recursive: true, force: true }); }
});

test('original keyword lists accept comments and trailing commas without changing quoted strings', async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'bgi-keywords-'));
  const words = ['https://example.test/原神', '包含/*不是注释*/文本', '逗号,]文本', '包含"引号"与\\路径'];
  try {
    const folder = path.join(configRoot, 'Skip'); await mkdir(folder);
    await writeFile(path.join(folder, 'default_pause_options.json'), '[]');
    await writeFile(path.join(folder, 'select_options.json'), '[]');
    await writeFile(path.join(folder, 'pause_options.json'), '\uFEFF[\n// 原始名单允许注释\n' + words.map(JSON.stringify).join(',\n') + ', /* 尾逗号 */\n]');
    for (const word of words) {
      const host = fixture({ find: name => ['DisabledUiButton', 'OptionIcon'].includes(name) ? [region()] : [], lines: () => [region(word)] });
      const dispatcher = new RealtimeDispatcher(host, { configRoot, config: { AutoSkip: { quicklySkipConversationsEnabled: false } } });
      dispatcher.addTrigger({ name: 'AutoSkip' }); await dispatcher.tick(); assert.deepEqual(inputs(host), [], word); await dispatcher.close();
    }
  } finally { await rm(configRoot, { recursive: true, force: true }); }
});

test('blacklist white rules override excluded icon while fuzzy blacklist and dynamic exclusions still block', async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), 'bgi-pick-'));
  try {
    await writeFile(path.join(userRoot, 'pick_white_lists.txt'), '自定义调查'); await writeFile(path.join(userRoot, 'pick_fuzzy_black_lists.txt'), '机关');
    let text = '自定义调查';
    const host = fixture({ pickText: () => text, find: name => name === 'F' ? [pickRegion] : name === 'SettingsIcon' ? [region()] : [] });
    const dispatcher = new RealtimeDispatcher(host, { userRoot, config: { AutoPick: { mode: 'Blacklist', blacklistModePickEnabled: true } } }); dispatcher.addTrigger({ name: 'AutoPick' });
    await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.args), [['F']]);
    text = '另一调查'; await tick(host, dispatcher); assert.equal(inputs(host).length, 1);
    const noIconHost = fixture({ pickText: () => text, find: name => name === 'F' ? [pickRegion] : [] });
    const noIcon = new RealtimeDispatcher(noIconHost, { userRoot, config: { AutoPick: { mode: 0 } } }); noIcon.addTrigger({ name: 'AutoPick' });
    text = '可拾取物'; await noIcon.tick(); text = '测试机关'; await tick(noIconHost, noIcon); text = '霜月工坊'; await tick(noIconHost, noIcon);
    assert.equal(inputs(noIconHost).length, 1); await dispatcher.close(); await noIcon.close();
  } finally { await rm(userRoot, { recursive: true, force: true }); }
});

test('timer clear-first, latest lease, original trigger priority, and one shared capture per due tick', async () => {
  const host = fixture({ find: name => name === 'F' ? [pickRegion] : [] });
  const dispatcher = new RealtimeDispatcher(host);
  const old = dispatcher.addTrigger({ Name: 'AutoPick', Interval: 500, Config: { ForceInteraction: false } });
  const latest = dispatcher.addTrigger({ name: 'AutoPick', interval: 100, config: { forceInteraction: true } });
  dispatcher.addTrigger({ name: 'AutoEat' }); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
  const result = await dispatcher.tick(); assert.deepEqual(result.triggers, ['AutoPick', 'AutoEat', 'AutoSkip']); assert.equal(host.frameCount, 1); assert.equal(host.images.size, 0);
  assert.equal((await dispatcher.tick()).reason, 'notDue'); latest.dispose(); await tick(host, dispatcher); assert.equal(host.frameCount, 2);
  old.dispose(); dispatcher.addTimer({ name: 'AutoEat' }); assert.equal(dispatcher.leases.length, 1); await dispatcher.close();
  assert.throws(() => dispatcher.addTrigger({ name: 'AutoPick' }), /closed/);
});

test('route trigger scope restores script leases and rejects unknown names and unavailable process-audio features', async () => {
  const host = fixture(), dispatcher = new RealtimeDispatcher(host); const lease = dispatcher.addTrigger({ name: 'AutoSkip' });
  const route = dispatcher.beginRoute({ config: { realtimeTriggers: { AutoPick: true, AutoEat: true } } }); assert.deepEqual(dispatcher.leases.map(l => l.name), ['AutoPick', 'AutoEat']);
  route.dispose(); assert.equal(dispatcher.leases[0], lease);
  assert.throws(() => dispatcher.addTrigger({ name: 'Unknown' }), UnsupportedRealtimeOperation);
  assert.throws(() => dispatcher.addTrigger({ name: 'constructor' }), UnsupportedRealtimeOperation);
  assert.throws(() => dispatcher.addTrigger({ name: 'AutoSkip', config: { autoWaitDialogueOptionVoiceEnabled: true } }), /DialogueOptionAudioWaiter/);
  assert.throws(() => dispatcher.addTrigger({ name: 'AutoSkip', config: { dialogueOptionVoiceVadDiagnosticEnabled: true } }), /Silero VAD diagnostics/);
  await dispatcher.close();
});

test('AutoEat retains Recovery cache and separate eating/resurrection cooldowns with configured gadget key', async () => {
  let low = true, resurrection = false;
  const host = fixture({ pixel: () => low ? [90, 90, 255] : [0, 0, 0], find: (name, frame) => name === 'RecoveryIcon' && frame === 1 || name === 'ResurrectionIcon' && resurrection ? [region()] : [] });
  const dispatcher = new RealtimeDispatcher(host, { gadgetKey: 'X' }); dispatcher.addTrigger({ name: 'AutoEat' });
  await dispatcher.tick(); await tick(host, dispatcher, 500); await tick(host, dispatcher, 500); assert.equal(inputs(host).length, 2);
  low = false; resurrection = true; await tick(host, dispatcher, 200); await tick(host, dispatcher, 1000); await tick(host, dispatcher, 1000);
  assert.equal(inputs(host).length, 4); assert.ok(inputs(host).every(c => c.args[0] === 'X')); await dispatcher.close();
});

test('AutoEat follows original minimum AssetScale on short captures', async () => {
  let sampled;
  const host = fixture({ width: 960, height: 360, pixel: (y, x) => { sampled = [y, x]; return [90, 90, 255]; }, find: name => name === 'RecoveryIcon' ? [region()] : [] });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoEat' }); await dispatcher.tick();
  assert.deepEqual(sampled, [336, 269]); assert.deepEqual(inputs(host).map(c => c.args), [['Z']]); await dispatcher.close();
});

test('dialogue OCR filters and custom priority precede built-in pause/default options', async () => {
  const lines = [region('ABC', 1280, 100), region('远处干扰', 1280, 160), region('卡牌商店', 1280, 400), region('我要领取', 1280, 500)];
  assert.deepEqual(filterDialogueOcr(lines).map(r => r.text), ['卡牌商店', '我要领取']);
  const host = fixture({ find: name => name === 'DisabledUiButton' || name === 'OptionIcon' ? [region()] : [], lines: () => lines });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, customPriorityOptionsEnabled: true, customPriorityOptions: '领取；另一个' } });
  await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.args), [[1355, 515]]); assert.equal(host.images.size, 0); await dispatcher.close();
  const pausedHost = fixture({ find: name => name === 'DisabledUiButton' || name === 'OptionIcon' ? [region()] : [], lines: () => [region('卡牌商店')] });
  const paused = new RealtimeDispatcher(pausedHost, { config: { AutoSkip: { quicklySkipConversationsEnabled: false } } }); paused.addTrigger({ name: 'AutoSkip' }); await paused.tick(); assert.equal(inputs(pausedHost).length, 0); await paused.close();
});

test('option delay refreshes recognition on the next frame and cancels when dialogue ends', async () => {
  let playing = true;
  const host = fixture({ find: (name, frame) => name === 'DisabledUiButton' && playing || name === 'OptionIcon' && playing ? [region('', 1250, 500)] : [], lines: frame => [region('第' + frame + '选项', 1280, 500)] });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, afterChooseOptionSleepDelay: 500 } });
  await dispatcher.tick(); assert.equal(inputs(host).length, 0);
  await tick(host, dispatcher, 500); assert.equal(inputs(host).length, 0);
  await tick(host, dispatcher); assert.equal(inputs(host).length, 1);
  host.advance(1300); await dispatcher.tick(); playing = false; await tick(host, dispatcher); playing = true; await tick(host, dispatcher); assert.equal(inputs(host).length, 1); await dispatcher.close();
});

test('orange daily option enters confirm/Primogem state across distinct captures and releases temporary Mats', async () => {
  const host = fixture({ find: (name, frame) => name === 'DisabledUiButton' || name === 'OptionIcon' ? [region()] : name === 'BtnBlackConfirm' && frame === 2 || name === 'Primogem' && frame === 3 ? [region()] : [], lines: () => [region('每日委托奖励')], orange: () => true });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
  await dispatcher.tick(); assert.equal(host.frameCount, 1); assert.equal(host.images.size, 0);
  await tick(host, dispatcher, 800); await tick(host, dispatcher); assert.deepEqual(inputs(host).map(c => c.args), [[1325, 515], [1325, 515], [960, 900]]); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('Primogem dismissal preserves 1080P reference coordinates on short captures', async () => {
  const host = fixture({ width: 960, height: 360, find: (name, frame) => ['DisabledUiButton', 'OptionIcon'].includes(name) && frame === 1 || name === 'BtnBlackConfirm' && frame === 2 || name === 'Primogem' && frame === 3 ? [region('', 400, 200, 60, 20)] : [], lines: () => [region('每日委托奖励', 450, 200, 100, 20)], orange: () => true });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
  await dispatcher.tick(); await tick(host, dispatcher, 800); await tick(host, dispatcher);
  assert.deepEqual(inputs(host).at(-1).args, [320, 300]); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('hangout branch exact/longest keyword priority includes previously selected options', () => {
  const selected = { text: '我觉得，可以先回酒会！', selected: true, icon: { y: 400 } }, unselected = { text: '静观其变', selected: false, icon: { y: 300 } };
  assert.equal(selectHangoutOption([selected, unselected], ['回酒会', '我觉得可以先回酒会']), selected);
  assert.equal(selectHangoutOption([selected, unselected], ['不匹配']), unselected);
});

test('one-key expedition retries original templates and verifies page departure, failures never report success', async () => {
  const host = fixture({ find: (name, frame) => name === 'Collect' && frame === 2 || name === 'Re' && frame === 4 ? [region()] : [] });
  const result = await runOneKeyExpedition(host); assert.equal(result.verified, true); assert.equal(result.pageExited, true); assert.equal(host.frameCount, 6); assert.equal(host.images.size, 0); assert.equal(host.calls.at(-1).method, 'releaseAll');
  const missing = fixture(); await assert.rejects(runOneKeyExpedition(missing), /未找到领取按钮/); assert.equal(missing.frameCount, 2); assert.equal(missing.calls.at(-1).method, 'releaseAll');
});

test('legacy expedition card grouping keeps OCR order preference and excludes characters already away', () => {
  const cards = parseExpeditionCards([region('菲谢尔', 100, 100, 100, 20), region('时间缩短', 100, 130, 100, 20), region('班尼特/探险中', 400, 200, 150, 20), region('奖励增加', 400, 230, 100, 20), region('九条裟罗', 100, 300, 100, 20), region('暂无加成', 100, 330, 100, 20), region('右半屏', 1200, 300, 100, 20)]);
  assert.deepEqual(cards.map(c => [c.name, c.idle]), [['菲谢尔', true], ['班尼特', false], ['九条裟罗', true]]);
  assert.equal(selectExpeditionCard(cards, '九条裟罗，菲谢尔').name, '菲谢尔'); assert.equal(selectExpeditionCard(cards, ['班尼特']).name, '菲谢尔'); assert.equal(selectExpeditionCard(cards.map(c => ({ ...c, idle: false }))), null);
});

test('cancellation and reentrancy release inputs and every owned frame', async () => {
  const controller = new AbortController();
  const host = fixture({ controller, find: name => name === 'F' ? [pickRegion] : [], onInput: method => { if (method === 'keyPress') controller.abort(new Error('stop trigger')); } });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoPick', config: { forceInteraction: true } }); dispatcher.addTrigger({ name: 'AutoEat' });
  await assert.rejects(dispatcher.tick(), /stop trigger/); assert.equal(host.images.size, 0); assert.equal(host.calls.at(-1).method, 'releaseAll'); await dispatcher.close();
  let nested, reentrant;
  const reentrantHost = fixture({ onCapture: async () => { reentrant = await nested.tick(); } }); nested = new RealtimeDispatcher(reentrantHost); nested.addTrigger({ name: 'AutoEat' }); await nested.tick(); assert.equal(reentrant.reason, 'reentrant'); assert.equal(reentrantHost.frameCount, 1); await nested.close();
});

test('closing or clearing during recognition cancels pending input and waits for owned frame disposal', async () => {
  for (const action of ['close', 'clear']) {
    let enter, resume;
    const entered = new Promise(resolve => { enter = resolve; });
    const waiting = new Promise(resolve => { resume = resolve; });
    const host = fixture({ find: async name => { if (name !== 'F') return []; enter(); await waiting; return [pickRegion]; } });
    const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoPick', config: { forceInteraction: true } });
    const pending = dispatcher.tick(); await entered;
    const stopped = action === 'close' ? dispatcher.close() : dispatcher.clearAllTriggers(); resume();
    assert.equal((await pending).reason, action === 'close' ? 'closed' : 'changed'); await stopped;
    assert.equal(inputs(host).length, 0); assert.equal(host.images.size, 0); assert.equal(host.calls.at(-1).method, 'releaseAll'); await dispatcher.close();
  }
  const controller = new AbortController(), host = fixture({ controller, find: name => name === 'F' ? [pickRegion] : [], onInput: method => { if (method === 'keyPress') controller.abort(new Error('last-input abort')); } });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoPick', config: { forceInteraction: true } });
  await assert.rejects(dispatcher.tick(), /last-input abort/); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('inherited host methods receive the trigger signal and clearing aborts raw sleep', { timeout: 1000 }, async () => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const controller = new AbortController(), host = fixture({ controller, find: name => name === 'DisabledUiButton' ? [region()] : [] });
  const vision = host.vision, signals = [];
  host.vision = function (op, args) { if (op !== 'image.dispose') signals.push(this.signal); return vision.call(this, op, args); };
  host.sleep = function () {
    assert.notEqual(this.signal, controller.signal); enter();
    return new Promise((resolve, reject) => this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true }));
  };
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { beforeClickConfirmDelay: 500 } });
  const pending = dispatcher.tick(); await entered; dispatcher.clearAllTriggers();
  assert.equal((await pending).reason, 'changed'); assert.ok(signals.length > 0);
  assert.ok(signals.every(signal => signal instanceof AbortSignal && signal !== controller.signal && signal.aborted));
  assert.equal(inputs(host).length, 0); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('per-tick cancellation reaches raw sleep without retiring the trigger or global host', { timeout: 1000 }, async () => {
  let enter, wait = true; const entered = new Promise(resolve => { enter = resolve; });
  const global = new AbortController(), scoped = new AbortController();
  const host = fixture({ controller: global, find: name => name === 'DisabledUiButton' ? [region()] : [] });
  host.sleep = function () {
    if (!wait) return;
    assert.notEqual(this.signal, global.signal); enter();
    return new Promise((resolve, reject) => this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true }));
  };
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { beforeClickConfirmDelay: 500 } });
  const frame = await host.capture(), pending = dispatcher.tick(frame, scoped.signal); await entered; scoped.abort(new Error('scoped tick stop'));
  await assert.rejects(pending, /scoped tick stop/); assert.equal(host.images.size, 1); assert.equal(global.signal.aborted, false); assert.equal(dispatcher.leases.length, 1); assert.equal(host.calls.at(-1).method, 'releaseAll');
  wait = false; host.advance(250); await dispatcher.tick(frame, new AbortController().signal); assert.deepEqual(inputs(host).map(c => c.args), [['SPACE']]);
  await host.vision('image.dispose', { handle: frame.handle }); await dispatcher.close();
});

test('per-tick cancellation during owned capture disposes the frame and pre-abort avoids capture', async () => {
  const scoped = new AbortController(), host = fixture({ onCapture: () => scoped.abort(new Error('capture stop')) });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoEat' });
  await assert.rejects(dispatcher.tick(undefined, scoped.signal), /capture stop/); assert.equal(host.images.size, 0); assert.equal(host.frameCount, 1);
  await assert.rejects(dispatcher.tick(undefined, scoped.signal), /capture stop/); assert.equal(host.frameCount, 1); await dispatcher.close();
});

test('route scopes are idempotent, unwind out of order, and restore leases on invalid route config', async () => {
  const dispatcher = new RealtimeDispatcher(fixture()), base = dispatcher.addTrigger({ name: 'AutoSkip' });
  const first = dispatcher.beginRoute(), second = dispatcher.beginRoute({ realtimeTriggers: { AutoEat: true } });
  first.dispose(); first.dispose(); assert.deepEqual(dispatcher.leases.map(l => l.name), ['AutoEat']);
  second.dispose(); second.dispose(); assert.deepEqual(dispatcher.leases, [base]);
  assert.throws(() => dispatcher.beginRoute({ realtimeTriggers: { Unknown: true } }), UnsupportedRealtimeOperation); assert.deepEqual(dispatcher.leases, [base]);
  const removed = dispatcher.beginRoute(); base.dispose(); removed.dispose(); assert.deepEqual(dispatcher.leases, []); await dispatcher.close();
});

test('route trigger scope accepts native realtime_triggers and preserves explicit empty or disabled maps', async () => {
  const dispatcher = new RealtimeDispatcher(fixture()); const base = dispatcher.addTrigger({ name: 'AutoSkip' });
  for (const config of [{ realtime_triggers: {} }, { realtime_triggers: { AutoPick: false } }, { realtime_triggers: { AutoEat: true, AutoPick: false } }]) {
    const route = dispatcher.beginRoute({ config }); assert.deepEqual(dispatcher.leases.map(l => l.name), config.realtime_triggers.AutoEat ? ['AutoEat'] : []); route.dispose(); assert.deepEqual(dispatcher.leases, [base]);
  }
  const direct = dispatcher.beginRoute({ realtime_triggers: { AutoEat: true } }); assert.deepEqual(dispatcher.leases.map(l => l.name), ['AutoEat']); direct.dispose(); await dispatcher.close();
});

test('borrowed frames survive tick and global pause keeps leases; invalid delay fails at configuration', async () => {
  const host = fixture({ find: name => name === 'F' ? [pickRegion] : [] }), dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoPick' });
  const frame = await host.capture(); await dispatcher.tick(frame); assert.equal(host.images.size, 1); assert.equal(host.frameCount, 1);
  host.realtimePauseCount = 1; host.advance(250); assert.equal((await dispatcher.tick()).reason, 'paused'); assert.equal(host.frameCount, 1);
  host.realtimePauseCount = 0; await dispatcher.tick(); assert.equal(host.frameCount, 2); assert.equal(host.images.size, 1);
  await host.vision('image.dispose', { handle: frame.handle }); await dispatcher.close();
  assert.throws(() => new RealtimeDispatcher(fixture(), { config: { AutoSkip: { afterChooseOptionSleepDelay: Infinity } } }), /Invalid BetterGI config/);
});

test('AutoPick preserves raw scroll pixels and original custom-key assets; Yap selection reaches vision', async () => {
  const scrolling = fixture({ pixel: (y, x) => x === 1062 && y === 537 ? [44, 233, 255] : x === 1062 && (y === 524 || y === 554) ? [255, 255, 255] : [0, 0, 0] });
  const scroll = new RealtimeDispatcher(scrolling); scroll.addTrigger({ name: 'AutoPick' }); await scroll.tick(); assert.deepEqual(inputs(scrolling).map(c => [c.method, c.args]), [['verticalScroll', [2]]]); await scroll.close();
  for (const [configured, used] of [['E', 'E'], ['Q', 'F']]) {
    const host = fixture({ find: name => name === used ? [pickRegion] : [] }), dispatcher = new RealtimeDispatcher(host, { config: { AutoPick: { pickKey: configured } } });
    dispatcher.addTrigger({ name: 'AutoPick', config: { forceInteraction: true } }); await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.args), [[used]]); await dispatcher.close();
  }
  let engine;
  const host = fixture({ pickText: (_, args) => { engine = args.ocrEngine; return '甜甜花'; }, find: name => name === 'F' ? [pickRegion] : [] }), dispatcher = new RealtimeDispatcher(host, { config: { AutoPick: { ocrEngine: 'Yap' } } }); dispatcher.addTrigger({ name: 'AutoPick' });
  await dispatcher.tick(); assert.equal(engine, 'Yap'); assert.deepEqual(inputs(host).map(c => c.args), [['F']]); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('custom pickup and chat-key regions use the source width-only asset scale', async () => {
  const observed = [];
  const host = fixture({ width: 960, height: 360, find: (name, _, ro) => {
    if (name === 'E' || name === 'chatPickE') observed.push([name, ro.roi]);
    return name === 'E' || name === 'DisabledUiButton' ? [region('', 550, 200, 15, 15)] : [];
  } });
  const dispatcher = new RealtimeDispatcher(host, { config: { AutoPick: { pickKey: 'E' } } });
  dispatcher.addTrigger({ name: 'AutoPick', config: { forceInteraction: true } }); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } }); await dispatcher.tick();
  assert.deepEqual(observed, [['E', [545, 165, 30, 210]], ['chatPickE', [600, 175, 25, 75]]]); await dispatcher.close();
});

test('popup page close requires stable recognition and excludes original guide, chat, chronicles and map pages', async () => {
  for (const exclusion of ['', 'GuidingNotes', 'ChatHistory', 'ValiantChronicles', 'MapSettingsButton']) {
    const host = fixture({ find: (name, frame) => name === 'DisabledUiButton' && frame === 1 || name === 'PageClose' && frame > 1 || name === exclusion ? [region()] : [] });
    const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
    await dispatcher.tick(); await tick(host, dispatcher); assert.equal(inputs(host).length, 0); await tick(host, dispatcher);
    assert.deepEqual(inputs(host).map(c => c.args), exclusion ? [] : [['ESCAPE']], exclusion); await dispatcher.close();
  }
});

test('item and character popup clicks preserve source raw pixel coordinates', async () => {
  for (const [scene, expected] of [[{ bottomTriangle: region('', 400, 300, 20, 15) }, [410, 307.5]], [{ characterPopup: region() }, [100, 100]]]) {
    const host = fixture({ width: 960, height: 360, scene, find: (name, frame) => name === 'DisabledUiButton' && frame === 1 ? [region()] : [] });
    const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } }); await dispatcher.tick(); await tick(host, dispatcher);
    assert.equal(inputs(host).length, 1); for (let i = 0; i < 2; i++) assert.ok(Math.abs(inputs(host)[0].args[i] - expected[i]) < 1e-9); await dispatcher.close();
  }
});

test('background option keys apply only when the host reports the game inactive', async () => {
  for (const active of [true, false]) {
    const host = fixture({ find: name => ['DisabledUiButton', 'OptionIcon'].includes(name) ? [region()] : [], lines: () => [region('继续')] });
    host.isGameActive = async () => active;
    const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, runBackgroundEnabled: true } });
    await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.method), [active ? 'click' : 'keyPress']);
    assert.deepEqual(inputs(host)[0].args, active ? [1325, 515] : ['F']); await dispatcher.close();
  }
});

test('character popup uses its detected center only during background operation', async () => {
  for (const active of [true, false]) {
    const host = fixture({ scene: { characterPopup: region('', 500, 400, 300, 45) }, find: (name, frame) => name === 'DisabledUiButton' && frame === 1 ? [region()] : [] });
    host.isGameActive = async () => active;
    const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, runBackgroundEnabled: true } });
    await dispatcher.tick(); await tick(host, dispatcher);
    assert.deepEqual(inputs(host).map(c => c.args), [active ? [100, 100] : [650, 422.5]]); await dispatcher.close();
  }
});

test('revive prompt exclusion follows the host culture text', async () => {
  const host = fixture({ scene: { bottomTriangle: region('', 600, 800, 20, 20) }, lines: () => [region('Revive')], find: (name, frame) => name === 'DisabledUiButton' && frame === 1 || ['PaimonMenu', 'Confirm'].includes(name) && frame === 2 ? [region()] : [] });
  host.revivalText = 'Revive';
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
  await dispatcher.tick(); await tick(host, dispatcher); assert.deepEqual(inputs(host).map(c => c.args), [[610, 810]]); await dispatcher.close();
});

test('legacy expedition reuses scanned metrics and source integer rectangles on non-16:9 captures', async () => {
  const host = fixture({ width: 960, height: 360 }); const result = await runLegacyExpedition(host);
  assert.equal(result.dispatched, 0); assert.equal(result.verified, false); assert.equal(host.frameCount, 6); assert.equal(host.images.size, 0);
  assert.deepEqual(inputs(host).map(c => c.args), [[46, 53.5], [46, 76.5], [46, 100.5], [46, 123.5], [46, 146.5]]); assert.equal(host.calls.at(-1).method, 'releaseAll');
});

test('goods submission stages every item and requires fresh original confirm templates', async () => {
  const goods = [region('', 200, 300, 120, 25), region('', 400, 300, 120, 25)];
  const host = fixture({ scene: { goodsRects: goods }, find: (name, frame) => name === 'DisabledUiButton' && frame === 1 || name === 'SubmitExclamationIcon' && frame === 2 || name === 'BtnBlackConfirm' && [3, 5].includes(frame) || name === 'BtnWhiteConfirm' && frame >= 6 ? [region('', 1500, 900, 100, 40)] : [] });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, closePopupPagedEnabled: false } });
  await dispatcher.tick(); await tick(host, dispatcher); await tick(host, dispatcher, 800); await tick(host, dispatcher, 200); await tick(host, dispatcher, 800); await tick(host, dispatcher, 500);
  assert.equal(inputs(host).length, 4); await tick(host, dispatcher, 200);
  assert.deepEqual(inputs(host).map(c => c.args), [[260, 312.5], [1550, 920], [460, 312.5], [1550, 920], [1550, 920]]); assert.equal(host.frameCount, 7); assert.equal(inputs(host).at(-1).at - inputs(host).at(-2).at, 700); assert.equal(host.images.size, 0); await dispatcher.close();
  const missing = fixture({ scene: { goodsRects: goods }, find: (name, frame) => name === 'DisabledUiButton' && frame === 1 || name === 'SubmitExclamationIcon' && frame === 2 ? [region()] : [] });
  const failed = new RealtimeDispatcher(missing); failed.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, closePopupPagedEnabled: false } }); await failed.tick(); await tick(missing, failed);
  await assert.rejects(tick(missing, failed, 800), /放入按钮未观察到/); assert.equal(missing.images.size, 0); assert.equal(missing.calls.at(-1).method, 'releaseAll'); await failed.close();
});

test('AutoSkip dispatches original one-key expedition flow across bounded single-frame ticks', async () => {
  const host = fixture({ orange: () => true, lines: () => [region('探索派遣')], find: (name, frame) => ['DisabledUiButton', 'OptionIcon'].includes(name) && frame === 1 || name === 'Collect' && frame === 2 || name === 'Re' && frame === 3 ? [region()] : [] });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false } });
  await dispatcher.tick(); await tick(host, dispatcher, 800); await tick(host, dispatcher, 1101); await tick(host, dispatcher, 500); await tick(host, dispatcher, 500);
  assert.equal(dispatcher.lastExpedition.verified, true); assert.equal(dispatcher.lastExpedition.pageExited, true); assert.equal(host.frameCount, 5); assert.deepEqual(inputs(host).map(c => c.method), ['click', 'click', 'click', 'keyPress']); assert.equal(host.images.size, 0); await dispatcher.close();
});

test('hangout reuses original branch resource and selected/unselected recognition assets', async () => {
  const host = fixture({ find: name => name === 'DisabledUiButton' ? [region()] : name === 'HangoutSelected' ? [region('', 1200, 300, 20, 30)] : name === 'HangoutUnselected' ? [region('', 1200, 500, 20, 30)] : [], lines: (_, roi) => [region(roi[1] < 300 ? '我觉得，可以先回酒会！' : '静观事态发展')] });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, autoHangoutEventEnabled: true, autoHangoutEndChoose: '琳妮特结局1:大成功!' } });
  await dispatcher.tick(); assert.deepEqual(inputs(host).map(c => c.args), [[1210, 315]]); await dispatcher.close();
});

test('hangout OCR uses C# integer division for uneven icon heights', async () => {
  const rois = [];
  const host = fixture({ find: name => name === 'DisabledUiButton' ? [region()] : name === 'HangoutUnselected' ? [region('', 1200, 300, 20, 31)] : [], lines: (_, roi) => { rois.push(roi); return [region('静观事态发展')]; } });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoSkip', config: { quicklySkipConversationsEnabled: false, autoHangoutEventEnabled: true } });
  await dispatcher.tick(); assert.deepEqual(rois, [[1220, 280, 690, 72]]); assert.deepEqual(inputs(host).map(c => c.args), [[1210, 315.5]]); await dispatcher.close();
});

test('semi-auto fishing follows source priority, keeps exclusivity between due ticks and closes with dispatcher', async () => {
  const host = fixture({ find: name => name === 'F' ? [pickRegion] : [] });
  const fishing = { enabled: true, exclusive: false, ticks: [], async tick(frame, signal) { signal?.throwIfAborted(); this.ticks.push(frame.handle); this.exclusive = true; return { exclusive: true, reason: this.ticks.length === 1 ? 'enteredFishingUi' : 'interval' }; }, async close() { this.closed = true; this.enabled = false; } };
  const dispatcher = new RealtimeDispatcher(host, { fishing, useGlobalConfig: true, config: { AutoSkip: { enabled: false } } });
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoPick', 'AutoFishing']);
  assert.deepEqual(inputs(host).map(c => c.args), [['F']]);
  host.advance(500);
  const exclusive = await dispatcher.tick(); assert.deepEqual(exclusive.triggers, ['AutoFishing']); assert.equal(exclusive.fishing.reason, 'interval');
  assert.equal(inputs(host).length, 1); assert.equal(host.images.size, 0);
  host.realtimePauseCount = 1; assert.equal((await dispatcher.tick()).reason, 'paused'); assert.equal(fishing.ticks.length, 2);
  host.realtimePauseCount = 0; fishing.enabled = false;
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoPick']); assert.equal(inputs(host).length, 2);
  assert.throws(() => dispatcher.addTrigger({ name: 'AutoFishing' }), UnsupportedRealtimeOperation);
  await dispatcher.close(); assert.equal(fishing.closed, true); assert.equal(host.calls.at(-1).method, 'releaseAll');
});

test('closing cancels an in-flight fishing tick and joins borrowed-frame cleanup', async () => {
  let enter, cancel; const entered = new Promise(resolve => { enter = resolve; });
  const host = fixture();
  const fishing = { enabled: true, exclusive: true, async tick() { enter(); await new Promise((_, reject) => { cancel = reject; }); }, async close() { cancel(new Error('fishing stopped')); } };
  const dispatcher = new RealtimeDispatcher(host, { fishing, inTask: false });
  const pending = dispatcher.tick(); await entered;
  const closing = dispatcher.close(); assert.equal((await pending).reason, 'closed'); await closing;
  assert.equal(host.images.size, 0); assert.equal(host.calls.at(-1).method, 'releaseAll');
});

test('source BeginTask and EndTask isolate script leases and restore global configuration', async () => {
  const host = fixture({ find: name => name === 'F' ? [pickRegion] : [] });
  const fishing = { enabled: true, ticks: 0, async tick() { this.ticks++; return {}; }, async close() {} };
  const dispatcher = new RealtimeDispatcher(host, { fishing, useGlobalConfig: true, config: { AutoSkip: { enabled: false } } });
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoPick', 'AutoFishing']);
  dispatcher.beginTask(); host.advance(100);
  assert.equal((await dispatcher.tick()).reason, 'notDue');
  dispatcher.addTrigger({ name: 'AutoEat' });
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoEat']);
  assert.equal(fishing.ticks, 1);
  dispatcher.endTask(); host.advance(100);
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoPick', 'AutoFishing']);
  assert.deepEqual(dispatcher.leases, []);
  await dispatcher.close();
});
