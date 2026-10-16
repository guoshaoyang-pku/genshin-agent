import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoBossTask, bossParameters, loadBossCatalog, requiredBossRouteFiles, runAutoBoss } from './boss.mjs';
import { BossResinTasks, normalizeBossResinText, parseBossResinRecovery, supplementalTargetQuantity,
  parseBossQuickUseAvailable, parseBossQuickUseQuantity } from './boss-resin.mjs';
import { NavigationTasks, loadPathingTask } from './navigation.mjs';
import { AutoFightTask } from './fight.mjs';
import { parseKeyMouseScript } from './native.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const assetRoot = path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoBoss/Assets/Pathing');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (text = '', x = 900, y = 745, width = 180, height = 25) => ({ text, x, y, width, height });
const stop = () => new Error('test canceled');

function fixture(options = {}) {
  let clock = 0, sequence = 0, captures = 0;
  const images = new Map(), inputs = [], calls = [], logs = [], keys = new Set();
  const host = {
    sourceRoot, signal: options.controller?.signal, images, inputs, calls, logs, keys,
    now: () => clock,
    log(level, text) { logs.push({ level, text }); },
    async capture() {
      this.signal?.throwIfAborted();
      clock += options.captureStep ?? 10;
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080, frame: ++captures };
      images.set(frame.handle, frame); await options.onCapture?.(frame, host); return frame;
    },
    async input(method, args = []) {
      this.signal?.throwIfAborted(); inputs.push({ method, args, at: clock, signal: this.signal });
      if (method === 'keyDown') keys.add(args[0]);
      if (method === 'keyUp') keys.delete(args[0]);
      if (method === 'releaseAll') keys.clear();
      await options.onInput?.(method, args, host);
    },
    async sleep(ms) {
      this.signal?.throwIfAborted(); clock += ms; calls.push({ op: 'sleep', ms, at: clock });
      await options.onSleep?.(ms, host);
      await new Promise(resolve => setImmediate(resolve));
    },
    async navigation(op, args) { this.signal?.throwIfAborted(); calls.push({ op: 'navigation.' + op, args, signal: this.signal }); return true; },
    async genshin(op, args) { this.signal?.throwIfAborted(); calls.push({ op: 'genshin.' + op, args }); return true; },
    async vision(op, args) {
      this.signal?.throwIfAborted(); calls.push({ op, args, at: clock, signal: this.signal });
      if (op === 'image.dispose') {
        assert.ok(images.has(args.handle), 'dispose owned image ' + args.handle);
        images.delete(args.handle); await options.onDispose?.(args.handle, host); return;
      }
      if (op === 'recognition.load') {
        const definitions = JSON.parse(await readFile(args.path, 'utf8'));
        const definition = definitions.objects[args.objectName]; assert.ok(definition, args.objectName);
        if (definition.template) assert.ok((await readFile(path.join(path.dirname(args.path), '1920x1080', definition.template))).length);
        return { ...definition, name: args.objectName };
      }
      const frame = images.get(args.handle); assert.ok(frame, 'owned frame for ' + op);
      if (op === 'image.crop' || op === 'image.mat') {
        const result = { ...frame, handle: ++sequence }; images.set(result.handle, result);
        await options.onAllocated?.(op, result, host); return result;
      }
      const override = await options.observe?.(op, args, frame, host);
      if (override !== undefined) return override;
      if (op === 'image.find') return ['PaimonMenu', 'MapScaleButton'].includes(args.recognition.name) ? region() : empty;
      if (op === 'image.ocr') return [];
      if (op === 'image.ocrWithoutDetector') return { text: '' };
      throw new Error('Unexpected vision operation ' + op);
    },
  };
  return host;
}
function task(host, taskConfig = {}, extra = {}) {
  return new AutoBossTask(host, { taskConfig: { BossName: '急冻树', SpecifyRunCount: true, RunCount: 1, ...taskConfig }, ...extra });
}
function released(host) {
  assert.equal(host.images.size, 0, 'no live images'); assert.equal(host.keys.size, 0, 'no held keys');
  assert.ok(host.inputs.some(call => call.method === 'releaseAll'));
  assert.equal(host.inputs.at(-1).method, 'leftButtonUp');
  for (const call of host.inputs.filter(call => /releaseAll|ButtonUp|keyUp/.test(call.method))) assert.equal(call.signal, null);
}
function loopFixture(host, taskConfig = {}, overrides = {}) {
  const run = task(host, taskConfig), events = [];
  run.validate = async () => {};
  for (const name of ['prepare', 'navigateToBoss', 'repositionAfterFight']) run[name] = async () => { events.push(name); };
  run.ensureResinBeforeRound = async () => { events.push('resin'); return true; };
  run.runFight = async () => { events.push('fight'); return { ended: true, timedOut: false }; };
  run.navigateToReward = async () => { events.push('flower'); return { evidence: 'rewardResinPanelObserved' }; };
  run.takeReward = async () => { events.push('claim'); return true; };
  Object.assign(run, overrides); return { run, events };
}

test('source catalog and every original boss route/macro load without replacement data', async t => {
  const catalog = await loadBossCatalog(sourceRoot);
  assert.equal(catalog.bosses.length, 44); assert.equal(Object.keys(catalog.countries).length, 8);
  assert.equal(catalog.talkToStart.size, 4); assert.equal(catalog.noPathing.size, 3); assert.equal(catalog.rerunRoute.size, 1);
  const required = new Set(catalog.bosses.flatMap(name => requiredBossRouteFiles(name, catalog)));
  assert.deepEqual([...required].sort(), (await readdir(assetRoot)).sort());
  let routes = 0, macros = 0, points = 0, events = 0;
  for (const filename of required) {
    const full = path.join(assetRoot, filename);
    if (filename.endsWith('键鼠前往.json')) {
      const macro = parseKeyMouseScript(await readFile(full, 'utf8'), { width: 1920, height: 1080, dpi: 1 });
      assert.ok(macro.events.length); macros++; events += macro.events.length;
    } else {
      const route = await loadPathingTask(full, { sourceRoot });
      assert.equal(route.coordinates, 'map-image'); assert.ok(route.positions.length, filename);
      assert.ok(route.diagnostics.every(item => item.kind !== 'unknown_action'), filename);
      routes++; points += route.positions.length;
    }
  }
  assert.equal(routes, 48); assert.equal(macros, 3);
  t.diagnostic(JSON.stringify({ bosses: catalog.bosses.length, routes, macros, points, events }));
});

test('boss params retain original defaults, customized JSON paths and lower-case dispatch', () => {
  const param = bossParameters({ AutoBossConfig: { BossName: '纯水精灵', SpecifyRunCount: true, RunCount: 4, Timeout: 99 } },
    { bossname: '急冻树', strategyname: '例子', combatstrategypath: '/tmp/test-strategy.JSON', reviveRetryCount: 0 }, sourceRoot);
  assert.equal(param.BossName, '急冻树'); assert.equal(param.RunCount, 4); assert.equal(param.Timeout, 99);
  assert.equal(param.StrategyName, '例子'); assert.equal(param.CombatStrategyPath, '/tmp/test-strategy.JSON'); assert.equal(param.ReviveRetryCount, 0);
  assert.throws(() => bossParameters({}, { SpecifyRunCount: true, RunCount: 0 }), /讨伐次数/);
  assert.throws(() => bossParameters({}, { ReviveRetryCount: -1 }), /重试次数/);
  assert.throws(() => bossParameters({}, { UseFragileResin: true }), /指定讨伐次数/);
});

test('recovery OCR handles full-width digits, last upper limit, ceiling and invalid evidence', () => {
  assert.equal(normalizeBossResinText(' １：０２ ：０３\n'), '1:02:03');
  assert.equal(parseBossResinRecovery('50/200', '原粹树脂已完全恢复').Count, 200);
  assert.equal(parseBossResinRecovery('２００', '全部恢复００：０８：００').Count, 199);
  assert.equal(parseBossResinRecovery('/200', '全部恢复00:08:01').Count, 198);
  assert.equal(parseBossResinRecovery('/200', '下次恢复00:01:00 全部恢复00:40:01').Count, 194);
  assert.equal(parseBossResinRecovery('/200', '下次00:01:00总计00:16:00').Count, 198);
  assert.throws(() => parseBossResinRecovery('20', '原粹树脂已完全恢复'), /上限/);
  assert.throws(() => parseBossResinRecovery('/200', '全部恢复00:61:00'), /格式/);
  assert.throws(() => parseBossResinRecovery('/200', '全部恢复30:00:00'), /超过/);
  assert.throws(() => parseBossResinRecovery('/200', 'unknown'), /恢复时间/);
  assert.equal(supplementalTargetQuantity({ Count: 21, Limit: 200 }), 2);
  assert.equal(supplementalTargetQuantity({ Count: 190, Limit: 200 }), 0);
  assert.equal(parseBossQuickUseAvailable('1/３５'), 20);
  assert.equal(parseBossQuickUseAvailable('1/2147483648/4'), 4);
  assert.equal(parseBossQuickUseQuantity('使用数量 ３'), 3);
  assert.equal(parseBossQuickUseQuantity('３\n使用数量'), 3);
  assert.equal(parseBossQuickUseQuantity('３'), null);
});

test('empty template results wait for an observed icon and timeout when none appears', async () => {
  let attempts = 0;
  const host = fixture({ observe: (op, args) => op === 'image.find' && args.recognition.name === 'RewardBox' ? ++attempts < 3 ? empty : region() : undefined });
  const run = new BossResinTasks(host);
  assert.ok(await run.poll(() => run.bossIcon('RewardBox'), 2000)); assert.equal(attempts, 3); assert.equal(host.images.size, 0);
  const absent = new BossResinTasks(fixture());
  assert.equal(await absent.poll(() => absent.bossIcon('RewardBox'), 500), null);
});

test('pre-round resin estimate clicks original map icon, sorts text and frees crops', async () => {
  let clicked = false;
  const host = fixture({ onInput: method => { if (method === 'click') clicked = true; }, observe: (op, args) => {
    if (op === 'image.find' && args.recognition.name === 'OriginalResinTopIcon') return region('', 1320, 30, 20, 25);
    if (op === 'image.ocrWithoutDetector') return { text: '35/200' };
    if (op === 'image.ocr') return clicked ? [region('00:24:00', 1400, 130), region('全部恢复', 1300, 100)] : [];
  } });
  const run = new BossResinTasks(host), result = await run.originalResinInfo();
  assert.equal(result.Count, 197); assert.equal(result.Limit, 200); assert.equal(result.evidence, 'sourceRecoveryTimeOcrEstimate');
  assert.equal(host.images.size, 0); assert.equal(run.resinEvidence.length, 1);
  const crop = host.calls.find(call => call.op === 'image.crop'); assert.deepEqual(crop.args, { handle: crop.args.handle, x: 1365, y: 37, width: 120, height: 24 });
  const ocr = host.calls.filter(call => call.op === 'image.ocr').at(-1); assert.deepEqual(ocr.args.recognition.roi, [1307, 84, 220, 150]);
});

test('precheck failure falls back to reward UI; observed insufficiency stops without permitted supplement', async () => {
  for (const mode of ['failed', 'empty', 'enough']) {
    const run = new BossResinTasks(fixture(), { SpecifyRunCount: false }); let returns = 0;
    run.returnMainUi = async () => { returns++; };
    run.originalResinInfo = async () => { if (mode === 'failed') throw new Error('OCR unavailable'); return { Count: mode === 'enough' ? 40 : 39, Limit: 200 }; };
    assert.equal(await run.ensureResinBeforeRound(), mode !== 'empty'); assert.equal(returns, 2);
    if (mode === 'failed') assert.equal(run.resinEvidence[0].evidence, 'precheckFailed');
  }
});

test('supplement prioritizes transient, skips unavailable options and re-observes resin', async () => {
  const run = new BossResinTasks(fixture(), { UseTransientResin: true, UseFragileResin: true }), selected = [], quantities = [];
  run.openSupplementPane = async () => true;
  run.selectSupplement = async option => { selected.push(option.name); return option.name === '脆弱树脂'; };
  run.useSelectedSupplement = async target => { quantities.push(target); return 2; };
  let rescans = 0; run.originalResinInfo = async () => ({ Count: ++rescans === 1 ? 20 : 140, Limit: 200 });
  assert.equal(await run.supplementResin({ Count: 0, Limit: 200 }), true);
  assert.deepEqual(selected, ['须臾树脂', '脆弱树脂', '脆弱树脂']); assert.deepEqual(quantities, [3, 3]); assert.equal(rescans, 2);
  assert.ok(run.resinEvidence.every(item => item.evidence === 'supplementObtainDialogObserved' && item.inventoryVerified === false));
});

test('supplement stops on missing obtain evidence, rescan failure, or no capacity', async () => {
  for (const mode of ['noObtain', 'noRescan', 'noCapacity']) {
    const run = new BossResinTasks(fixture(), { UseTransientResin: true }); let uses = 0;
    run.openSupplementPane = async () => true; run.selectSupplement = async () => true;
    run.useSelectedSupplement = async () => { uses++; return mode === 'noObtain' ? 0 : 1; };
    run.originalResinInfo = async () => { throw new Error('rescan failed'); };
    assert.equal(await run.supplementResin({ Count: 0, Limit: mode === 'noCapacity' ? 20 : 200 }), false);
    assert.equal(uses, mode === 'noCapacity' ? 0 : 1);
  }
});

test('quick use caps quantity by inventory, requires obtain and rejects OCR overshoot', async () => {
  for (const mode of ['ok', 'missingObtain', 'overshoot', 'single']) {
    const run = new BossResinTasks(fixture()); const clicks = [];
    run.clickText = async (text, rect) => { clicks.push(rect); return true; };
    run.textAt = async text => text === '快捷使用' && mode !== 'single' ? region(text) : null;
    run.countAt = async () => '1/2';
    run.adjustQuickQuantity = async target => { assert.equal(target, 2); return mode === 'overshoot' ? 3 : 2; };
    run.closeObtainDialog = async () => mode !== 'missingObtain';
    const quantity = await run.useSelectedSupplement(3);
    assert.equal(quantity, mode === 'ok' ? 2 : mode === 'single' ? 1 : 0);
    assert.equal(clicks.length, ['single', 'overshoot'].includes(mode) ? 1 : 2);
  }
});

test('quick quantity increment stops at target, missing plus or three unchanged reads', async () => {
  for (const mode of ['increment', 'missingPlus', 'stalled']) {
    const run = new BossResinTasks(fixture()); let quantity = 1, clicks = 0;
    run.sortedOcr = async () => '使用数量' + quantity;
    run.bossIcon = async () => mode === 'missingPlus' ? null : region();
    run.click = async () => { clicks++; if (mode === 'increment') quantity++; };
    assert.equal(await run.adjustQuickQuantity(3), mode === 'increment' ? 3 : 1);
    assert.equal(clicks, mode === 'increment' ? 2 : mode === 'stalled' ? 3 : 0);
  }
});

test('specified success count survives death retry; timeout is retained as unverified fight evidence', async () => {
  const host = fixture(); let fights = 0, callbacks = 0;
  const { run, events } = loopFixture(host, { RunCount: 3, ReviveRetryCount: 1, RewardClaimedCallback: () => { callbacks++; } }, {
    runFight: async () => { if (++fights === 2) throw Object.assign(new Error('角色阵亡'), { code: 'PATH_RETRY' }); return { ended: false, timedOut: true, completion: 'timeout' }; },
  });
  const result = await run.start();
  assert.equal(result.successfulRewardCount, 3); assert.equal(callbacks, 3); assert.equal(result.completed, true);
  assert.equal(result.retries.length, 1); assert.equal(result.retries[0].successfulRewardCount, 1);
  assert.equal(events.filter(event => event === 'prepare').length, 2); assert.equal(events.filter(event => event === 'navigateToBoss').length, 2);
  assert.ok(result.rounds.every(round => round.fight.timedOut && !round.fight.ended));
  assert.equal(result.verified, false); assert.equal(result.inventoryVerified, false); released(host);
});

test('retries exhaust and preserve primary error while always releasing both input groups', async () => {
  const primary = Object.assign(new Error('dead again'), { code: 'PATH_RETRY' });
  const host = fixture({ onInput: method => { if (method === 'releaseAll') throw new Error('cleanup failed'); } });
  const { run } = loopFixture(host, { ReviveRetryCount: 1 }, { runFight: async () => { throw primary; } });
  await assert.rejects(run.start(), error => error === primary); assert.equal(run.receipt.retries.length, 1);
  released(host); assert.ok(host.logs.some(log => log.text.includes('cleanup failed')));
});

test('insufficient resin and unavailable rewards never count a requested round', async () => {
  for (const mode of ['resin', 'reward']) {
    const host = fixture(), { run, events } = loopFixture(host, {}, mode === 'resin' ? { ensureResinBeforeRound: async () => false } : { takeReward: async () => false });
    const result = await run.start();
    assert.equal(result.successfulRewardCount, 0); assert.equal(result.rounds.length, 0); assert.equal(result.completed, false);
    assert.equal(result.reason, mode === 'resin' ? 'insufficientResin' : 'rewardUnavailable');
    if (mode === 'resin') assert.deepEqual(events, ['prepare']); released(host);
  }
});

test('return statue is observed between rounds and triggers full navigation', async () => {
  const host = fixture(), { run, events } = loopFixture(host, { RunCount: 2, ReturnToStatueAfterEachRound: true });
  const result = await run.start(); assert.equal(result.successfulRewardCount, 2);
  assert.equal(host.calls.filter(call => call.op === 'genshin.tpToStatueOfTheSeven').length, 1);
  assert.equal(events.filter(event => event === 'navigateToBoss').length, 2); assert.ok(!events.includes('repositionAfterFight'));
  assert.ok(host.calls.some(call => call.op === 'sleep' && call.ms === 3000)); released(host);
});

test('ordinary boss repeats only source final point; talk/special/rerun dispatch original routes', async () => {
  const host = fixture(), run = task(host); run.catalog = await loadBossCatalog(sourceRoot);
  let final; run.runRoute = async route => { final = route; };
  await run.repositionAfterFight();
  const original = await loadPathingTask(path.join(assetRoot, '急冻树前往.json'), { sourceRoot });
  assert.deepEqual(final.positions, [original.positions.at(-1)]);
  assert.ok(host.calls.some(call => call.op === 'sleep' && call.ms === 4000));
  const files = [], special = [];
  run.runRouteFile = async filename => { files.push(filename); }; run.navigateToBoss = async () => { special.push(run.param.BossName); };
  for (const name of ['纯水精灵', '蕴光月守宫', '不灭衍生造物']) { run.param.BossName = name; await run.repositionAfterFight(); }
  assert.deepEqual(files, ['纯水精灵战斗后快速前往.json', '不灭衍生造物前往.json']); assert.deepEqual(special, ['蕴光月守宫']);
});

test('boss route uses shared navigation with party-switch and auto-fight disabled', async t => {
  const host = fixture(), run = task(host), observed = [];
  t.mock.method(NavigationTasks.prototype, 'execute', async function (route) { observed.push({ route, party: this.options.partyConfig }); return { completed: true }; });
  await run.runRouteFile('急冻树前往.json'); assert.equal(observed.length, 1);
  assert.equal(observed[0].route.coordinates, 'map-image');
  assert.equal(observed[0].party.SkipPartySwitch, true); assert.equal(observed[0].party.AutoFightEnabled, false);
  assert.equal(run.receipt.routes[0].filename, '急冻树前往.json'); assert.equal(host.images.size, 0);
});

test('boss fight composes shared text/JSON engines, switches text first avatar and disables pickup', async t => {
  const host = fixture(), switches = [], starts = [];
  t.mock.method(AutoFightTask.prototype, 'initializeTeam', async () => [{ name: '钟离', index: 1 }]);
  t.mock.method(AutoFightTask.prototype, 'switchAvatar', async args => { switches.push(args.name); });
  t.mock.method(AutoFightTask.prototype, 'start', async function () { starts.push(this.options); return { ended: false, timedOut: true, completion: 'timeout' }; });
  for (const kind of ['text', 'json']) {
    const strategy = { kind, avatarNames: ['钟离'], commands: [{ name: '钟离', method: 'wait', args: [1] }] };
    const run = task(host, { Timeout: 5 }, { strategies: [strategy] });
    assert.equal((await run.runFight()).timedOut, true);
  }
  assert.deepEqual(switches, ['钟离']); assert.equal(starts.length, 2);
  for (const config of starts) {
    assert.equal(config.FightFinishDetectEnabled, true); assert.equal(config.PickDropsAfterFightEnabled, false);
    assert.equal(config.ExpBasedPickupEnabled, false); assert.equal(config.KazuhaPickupEnabled, false); assert.equal(config.Timeout, 5);
  }
});

test('reward use requires an observed click and disappearance; an absent button never succeeds', async () => {
  for (const mode of ['clicked', 'absent', 'stuck']) {
    let clicked = false;
    const host = fixture({ onInput: method => { if (method === 'click') clicked = true; }, observe: op => op === 'image.ocr' ? mode !== 'absent' && (mode === 'stuck' || !clicked) ? [region('使用原粹树脂')] : [] : undefined });
    const run = task(host); assert.equal(await run.useOriginalResinOnRewardPrompt(), mode === 'clicked');
    assert.equal(clicked, mode !== 'absent'); assert.equal(host.images.size, 0);
  }
});

test('reward cannot succeed until return to main UI is observed', async () => {
  const run = task(fixture()); run.useOriginalResinOnRewardPrompt = async () => true;
  run.isInMainUi = async () => false; run.textAt = async () => null;
  await assert.rejects(run.takeReward(), /未成功回到主界面/);
  assert.equal(run.receipt.rewardObservations.length, 0);
});

test('parallel reward navigation cancels and joins workers before final neutral releases', async () => {
  let scans = 0;
  const host = fixture({ observe: (op, args) => op === 'image.ocr' && args.recognition.roi?.[1] === 740 && ++scans >= 3 ? [region('使用原粹树脂')] : undefined });
  const run = task(host), result = await run.navigateToReward();
  assert.equal(result.evidence, 'rewardResinPanelObserved'); assert.equal(host.images.size, 0); assert.equal(host.keys.size, 0);
  const count = host.inputs.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(host.inputs.length, count);
  assert.deepEqual(host.inputs.slice(-3).map(call => [call.method, call.args]), [['keyUp', ['W']], ['keyUp', ['A']], ['keyUp', ['D']]]);
  assert.ok(host.inputs.slice(-3).every(call => call.signal === null));
});

test('reward navigation timeout is failure and leaves no pending input or image', async () => {
  const host = fixture(), run = task(host);
  await assert.rejects(run.navigateToReward(), /超时未找到/);
  assert.equal(host.images.size, 0); assert.equal(host.keys.size, 0);
  const count = host.inputs.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(host.inputs.length, count);
});

test('worker cleanup failure prevents successful reward navigation', async () => {
  let failed = false;
  const host = fixture({ onInput: (method, args) => { if (!failed && method === 'keyUp' && args[0] === 'A') { failed = true; throw new Error('worker release failed'); } },
    observe: (op, args) => op === 'image.ocr' && args.recognition.roi?.[1] === 740 ? [region('使用原粹树脂')] : undefined });
  await assert.rejects(task(host).navigateToReward(), /worker release failed/); assert.equal(host.images.size, 0); assert.equal(host.keys.size, 0);
});

test('cancellation during image allocation disposes every owned handle with uncanceled transport', async () => {
  for (const mode of ['capture', 'crop']) {
    const controller = new AbortController(), reason = stop();
    const host = fixture({ controller, onCapture: () => { if (mode === 'capture') controller.abort(reason); }, onAllocated: () => { controller.abort(reason); } });
    const run = task(host);
    await assert.rejects(mode === 'capture' ? run.captured(() => true) : run.countAt([0, 0, 100, 20]), error => error === reason);
    assert.equal(host.images.size, 0); assert.ok(host.calls.filter(call => call.op === 'image.dispose').every(call => call.signal === null));
  }
});

test('parent cancellation joins reward navigation and preserves cancellation over cleanup error', async () => {
  const controller = new AbortController(), reason = stop(); let canceled = false;
  const host = fixture({ controller, onInput: (method, args) => {
    if (method === 'keyDown' && !canceled) { canceled = true; controller.abort(reason); }
    if (method === 'keyUp' && args[0] === 'A') throw new Error('cleanup after cancellation');
  } });
  const run = task(host); await assert.rejects(run.navigateToReward(), error => error === reason);
  assert.equal(host.images.size, 0); assert.equal(host.keys.size, 0);
  const count = host.inputs.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(host.inputs.length, count);
});

test('start cancellation preserves reason through all releases; cleanup-only failure rejects success', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(), reason = stop();
    const host = fixture({ controller, onInput: method => { if (method === 'releaseAll') throw new Error('final release failed'); } });
    const { run } = loopFixture(host, {}, { validate: async () => { if (cancel) controller.abort(reason); } });
    await assert.rejects(run.start(), cancel ? error => error === reason : /final release failed/); released(host);
  }
});

test('public wrapper preserves original summary return and opt-in detailed receipt', async t => {
  const receipt = { rewardSummary: { 摩拉: 20000 }, completed: true, successfulRewardCount: 1 };
  t.mock.method(AutoBossTask.prototype, 'start', async () => receipt);
  assert.deepEqual(await runAutoBoss(fixture()), { 摩拉: 20000 });
  assert.equal(await runAutoBoss(fixture(), { detailed: true }), receipt);
});
