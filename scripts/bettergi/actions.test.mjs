import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PathingActions, PathingActionError, circularMotion, loadPathingActionResources } from './actions.mjs';
import { LinneaMiningJob, ScanPickJob, clusterMinerals, nearestMineralCluster, parseLinneaParams } from './action-jobs.mjs';
import { loadAvatarCatalog, parseCombatScript, UnsupportedNativeOperation } from './native.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const resources = await loadPathingActionResources(sourceRoot), { aliases } = await loadAvatarCatalog(sourceRoot);
const region = { x: 20, y: 30, width: 40, height: 20 }, empty = { x: 0, y: 0, width: 0, height: 0 };
const box = (x, y, width = 40, height = 45, confidence = 0.9, name = 'ore') => ({ name: { name, id: 0 }, confidence, bounds: { x, y, width, height } });

function host(options = {}) {
  let clock = 0, nextHandle = 1, nextPredictor = 1, captures = 0;
  const images = new Map(), predictors = new Set(), calls = [], combats = [], visions = [], keys = new Set(), buttons = new Set();
  const team = (options.team ?? ['纳西妲', '枫原万叶', '钟离', '莉奈娅']).map((name, index) => ({ name, index: index + 1 }));
  const put = (width, height, parent) => { const descriptor = { handle: nextHandle++, width, height, parent }; images.set(descriptor.handle, descriptor); return descriptor; };
  return {
    sourceRoot, signal: options.controller?.signal, images, predictors, calls, combats, visions, keys, buttons,
    now: () => clock,
    async sleep(ms) { clock += ms; await options.onSleep?.(ms, this); },
    async input(method, args = []) {
      calls.push({ at: clock, method, args });
      if (method.toLowerCase() === 'keydown') keys.add(args[0]);
      if (method.toLowerCase() === 'keyup') keys.delete(args[0]);
      const button = /^(left|right|middle)button(down|up)$/i.exec(method);
      if (button?.[2].toLowerCase() === 'down') buttons.add(button[1].toLowerCase());
      if (button?.[2].toLowerCase() === 'up') buttons.delete(button[1].toLowerCase());
      if (method.toLowerCase() === 'releaseall') { keys.clear(); buttons.clear(); }
      await options.onInput?.(method, args, this);
    },
    async combat(operation, args) {
      combats.push({ at: clock, operation, args });
      if (options.onCombat) { const result = await options.onCombat(operation, args, this); if (result !== undefined) return result; }
      if (operation === 'initializeTeam') return team;
      if (operation === 'switchAvatar') return options.switchResult ?? true;
      if (operation === 'currentAvatar') return team[0]?.name;
      if (operation === 'isSkillReady') return true;
      return {};
    },
    async capture() {
      captures++; const frame = put(options.width ?? 1920, options.height ?? 1080); frame.number = captures;
      await options.onCapture?.(frame, this); return frame;
    },
    async vision(operation, args) {
      visions.push({ at: clock, operation, args });
      if (operation === 'recognition.load') return { objectName: args.objectName };
      if (operation === 'image.dispose') { assert.ok(images.delete(args.handle), 'Image disposed exactly once'); return; }
      if (operation === 'yolo.create') { const predictor = nextPredictor++; predictors.add(predictor); return { predictor }; }
      if (operation === 'yolo.dispose') { assert.ok(predictors.delete(args.predictor), 'Predictor disposed exactly once'); return; }
      if (operation === 'yolo.predict') { assert.ok(predictors.has(args.predictor)); return options.onDetect?.(images.get(args.handle), this) ?? []; }
      const image = images.get(args.handle); assert.ok(image, 'Vision requires a live image handle');
      if (operation === 'image.find') return await options.onFind?.(args.recognition.objectName, image, this) || empty;
      if (operation === 'image.crop') return put(args.width, args.height, image.handle);
      if (operation === 'image.ocrWithoutDetector') return options.onOcr ? options.onOcr(image, this) : { text: options.cooldown ?? '0', score: 0.8 };
      if (operation === 'image.mat') {
        if (args.method.toLowerCase() === 'at') return options.onPixel?.(args.args, image, this) ?? [0, 0, 0];
        return put(image.width, image.height, image.handle);
      }
      throw new Error('Unimplemented test vision: ' + operation);
    },
  };
}
function actions(value, options = {}) { return new PathingActions(value, { resources, ...options }); }
function released(value) {
  assert.equal(value.calls.at(-1).method, 'releaseAll'); assert.equal(value.keys.size, 0); assert.equal(value.buttons.size, 0);
  assert.equal(value.images.size, 0); assert.equal(value.predictors.size, 0);
}
function findQueues(values) {
  const queues = Object.fromEntries(Object.entries(values).map(([name, entries]) => [name, [...entries]]));
  return name => { assert.ok(queues[name]?.length, 'Expected template observation ' + name); return queues[name].shift() ? region : empty; };
}

test('original embedded resources load unchanged, concatenate C# literals, and all strategies parse', async t => {
  assert.deepEqual([resources.mining.length, resources.pickup.length, resources.elemental.length], [22, 4, 48]);
  assert.equal(resources.pickup[3].length, 1084);
  assert.equal(resources.pickup[3].includes('+'), false);
  assert.equal(resources.mining[0].startsWith('莉奈娅 '), true);
  assert.equal(resources.mining.at(-1), '钟离 e(hold,wait)');
  assert.deepEqual(Object.fromEntries(['Hydro', 'Electro', 'Anemo', 'Pyro'].map(element => [element, resources.elemental.filter(item => item.element === element).length])), { Hydro: 13, Electro: 9, Anemo: 13, Pyro: 13 });
  for (const [filename, hash] of Object.entries(resources.provenance.files)) assert.equal(createHash('sha256').update(await readFile(path.join(sourceRoot, filename), 'utf8')).digest('hex'), hash);
  let commands = 0;
  for (const text of resources.mining) commands += parseCombatScript(text, { aliases }).commands.length;
  for (const text of resources.pickup) commands += parseCombatScript(text.replace(/-\S+(?= )/, ''), { aliases }).commands.length;
  t.diagnostic('26 unchanged embedded strategies parsed, ' + commands + ' original commands; 48 unchanged elemental configs');
});

test('unknown action, absent team and absent collection avatar fail explicitly with input cleanup', async () => {
  for (const [value, action, expected] of [[host(), 'invented', UnsupportedNativeOperation], [host({ team: [] }), 'nahida_collect', PathingActionError], [host({ team: ['钟离'] }), 'nahida_collect', PathingActionError]]) {
    await assert.rejects(actions(value).run(action), expected); assert.equal(value.calls.length, 1); released(value);
  }
  const missing = host(); delete missing.combat;
  await assert.rejects(actions(missing).run('mining'), UnsupportedNativeOperation); released(missing);
});

test('failed and undefined avatar switch receipts stop actions before gameplay input', async () => {
  for (const result of [false, null, {}]) {
    const value = host({ onCombat: op => op === 'switchAvatar' ? result : undefined });
    if (result === null) value.combat = async op => op === 'initializeTeam' ? [{ name: '纳西妲', index: 1 }] : undefined;
    await assert.rejects(actions(value).run('nahida_collect'), error => error.code === 'switchUnverified');
    assert.equal(value.calls.length, 1); released(value);
  }
});

test('Nahida scan reproduces source ground sweep, tilt transition, DPI truncation and cooldown bookkeeping', async () => {
  const value = host(); const result = await actions(value, { dpi: 1.5 }).run('nahida_collect');
  const moves = value.calls.filter(call => call.method === 'moveMouseBy').map(call => call.args);
  assert.equal(moves.length, 76); assert.deepEqual(moves[0], [0, 10000]);
  assert.deepEqual(moves.slice(1, 16), Array.from({ length: 15 }, () => [600, 500]));
  assert.deepEqual(moves.slice(16, 35), Array.from({ length: 19 }, () => [600, -45]));
  assert.deepEqual(moves.slice(35), Array.from({ length: 41 }, () => [600, -75]));
  assert.equal(value.now(), 4650); assert.equal(result.outcomeVerified, false);
  assert.deepEqual(value.combats.map(call => call.operation), ['initializeTeam', 'switchAvatar', 'waitSkillCd', 'afterUseSkill']); released(value);
});

test('Nahida cancellation releases held E and skips post-cancel cooldown mutation', async () => {
  const controller = new AbortController(), value = host({ controller, onSleep(ms) { if (ms === 30) controller.abort(new Error('cancel scan')); } });
  await assert.rejects(actions(value).run('nahida_collect'), /cancel scan/);
  assert.ok(value.calls.some(call => call.method === 'keyUp' && call.args[0] === 'VK_E'));
  assert.equal(value.combats.some(call => call.operation === 'afterUseSkill'), false); released(value);
});

test('elemental collection follows team order, normal-attack priority and real skill adapter', async () => {
  const normal = host({ team: ['钟离', '丽莎', '八重神子'] });
  assert.equal((await actions(normal).run('electro_collect')).avatar, '丽莎');
  assert.equal(normal.calls.filter(call => call.method === 'leftButtonClick').length, 1);
  assert.equal(normal.combats.some(call => call.operation === 'useSkill'), false); assert.equal(normal.now(), 200); released(normal);
  const skill = host({ team: ['妮露', '芭芭拉'] });
  await actions(skill).run('hydro_collect');
  assert.deepEqual(skill.combats.map(call => call.operation), ['initializeTeam', 'switchAvatar', 'waitSkillCd', 'useSkill']); released(skill);
  const failed = host({ team: ['丽莎', '八重神子'], switchResult: false });
  await assert.rejects(actions(failed).run('electro_collect'), /切人失败/);
  assert.equal(failed.combats.filter(call => call.operation === 'switchAvatar').length, 1); released(failed);
});

test('circular pickup retains original geometry, six edges, movement durations and zero-turn behavior', async () => {
  const first = circularMotion(0), second = circularMotion(1);
  assert.ok(Math.abs(first.radiusT - 311.8097605735693) < 1e-10);
  assert.ok(Math.abs(first.endAngle - 1.2724954410454226) < 1e-12);
  assert.ok(Math.abs(second.radiusT - 515.2377997390249) < 1e-10);
  assert.throws(() => circularMotion(-1), RangeError);
  const value = host(); await actions(value).run('pick_around', { waypoint: { action_params: 'invalid' } });
  assert.equal(value.now(), 6312); assert.equal(value.calls.filter(call => call.method === 'middleButtonClick').length, 9);
  const downs = value.calls.filter(call => call.method === 'keyDown');
  assert.deepEqual(downs.map(call => call.args), [['VK_W'], ['VK_W'], ['VK_A']]);
  assert.equal(value.calls.find(call => call.method === 'keyUp' && call.args[0] === 'VK_W').at - downs[0].at, 200); released(value);
  const zero = host(); assert.equal((await actions(zero).run('pick_around', { waypoint: { action_params: '0' } })).turns, 0); assert.equal(zero.calls.length, 1); released(zero);
});

test('mining uses source strategy priority, aliases and literal disablePickupAround semantics', async () => {
  const value = host({ team: ['钟离', '诺艾尔'] });
  await actions(value).run('mining');
  assert.equal(value.combats.find(call => call.operation === 'switchAvatar').args.name, '诺艾尔');
  assert.equal(value.calls.filter(call => call.method === 'leftButtonClick').length, 7); released(value);
  const withScan = host({ team: ['坎蒂丝'] }), action = actions(withScan); let scan = 0;
  action.scanPick = async () => { scan++; return { targets: 0 }; };
  const result = await action.run('mining', { waypoint: { action_params: 'DISABLEpickupAround' } });
  assert.equal(scan, 1); assert.deepEqual(result.scan, { targets: 0 });
  assert.equal(withScan.combats.find(call => call.operation === 'useSkill').args.name, '坎蒂丝'); released(withScan);
});

test('pickup reuses original variants, default precedence, alias handling and untrimmed tokens', async () => {
  const value = host({ team: ['琴', '枫原万叶'] });
  assert.deepEqual((await actions(value).run('pick_up_collect')).executed, ['枫原万叶']);
  assert.equal(value.combats.find(call => call.operation === 'switchAvatar').args.name, '枫原万叶');
  assert.equal(value.combats.filter(call => call.operation === 'afterUseSkill').length, 1); released(value);
  const variant = host({ team: ['枫原万叶'] });
  await actions(variant).run('pick_up_collect', { waypoint: { action_params: '枫原万叶-短E' } });
  assert.equal(variant.combats.filter(call => call.operation === 'afterUseSkill').length, 2); released(variant);
  const alias = host({ team: ['枫原万叶'] });
  assert.deepEqual((await actions(alias).run('pick_up_collect', { waypoint: { action_params: '万叶' } })).executed, ['枫原万叶']); released(alias);
  const invalid = host({ team: ['枫原万叶'] });
  await assert.rejects(actions(invalid).run('pick_up_collect', { waypoint: { action_params: ' 枫原万叶' } }), error => error.code === 'missingAvatar'); released(invalid);
});

test('gadget uses exact source crop, white HSV threshold, recognition without detector and original wait caps', async () => {
  for (const [cooldown, parameter, waitMs] of [['0.5', '', 600], ['0.5', '0.1', 100], ['0.5', 'invalid', 0], ['101', '', 0], ['unreadable', '', 0]]) {
    const value = host({ cooldown }); const result = await actions(value).run('use_gadget', { waypoint: { action_params: parameter } });
    assert.equal(result.waitMs, waitMs); assert.equal(value.now(), waitMs + 300); assert.equal(result.outcomeVerified, false);
    assert.equal(value.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_Z').length, 2);
    const crop = value.visions.find(call => call.operation === 'image.crop').args;
    assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [1790, 814, 60, 24]);
    assert.deepEqual(value.visions.filter(call => call.operation === 'image.mat').map(call => call.args.args), [['BGR2HSV'], [[0, 0, 235], [0, 25, 255]]]); released(value);
  }
  const direct = host(); await actions(direct).run('use_gadget', { waypoint: { action_params: 'prefix_NOT_WAIT' } });
  assert.equal(direct.visions.length, 0); released(direct);
});

test('gadget OCR failures dispose derived images and preserve failure before a second Z press', async () => {
  const value = host({ onOcr() { throw new Error('recognizer unavailable'); } });
  await assert.rejects(actions(value).run('use_gadget'), /recognizer unavailable/);
  assert.equal(value.calls.filter(call => call.method === 'keyPress').length, 1); released(value);
});

test('set_time delegates actual clock flow with source skip default and rejects malformed values', async () => {
  const value = host(), calls = [], daily = { async setTime(...args) { calls.push(args); return { verified: true }; } };
  const action = actions(value, { daily });
  await action.run('set_time', { waypoint: { action_params: '18:05' } });
  await action.run('set_time', { waypoint: { action_params: '0:00:FALSE' } });
  assert.deepEqual(calls, [[18, 5, true], [0, 0, false]]);
  assert.deepEqual(await action.run('set_time'), { skipped: true, reason: 'emptyParams' });
  await assert.rejects(action.run('set_time', { waypoint: { action_params: '1:2:wrong' } }), TypeError); released(value);
  const malformed = host(); await assert.rejects(actions(malformed).run('set_time', { waypoint: { action_params: 'abc' } }), /integer/); released(malformed);
});

test('leaf requires consecutive exact source points followed by observed Fly, and retains out-of-bounds helper behavior', async () => {
  const value = host({ onPixel: () => [245, 255, 250], onFind: name => name === 'SpaceKey' ? region : empty });
  assert.equal((await actions(value).run('up_down_grab_leaf')).flyingVerified, true);
  assert.equal(value.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_T').length, 1);
  assert.equal(value.visions.filter(call => call.operation === 'image.mat').length, 8); released(value);
  const small = host({ width: 960, height: 540 });
  assert.equal(await actions(small).detectLeaf(), true); assert.equal(small.visions.some(call => call.operation === 'image.mat'), false); assert.equal(small.images.size, 0);
  const absent = host(); await assert.rejects(actions(absent).run('up_down_grab_leaf'), error => error.code === 'leafNotFound');
  assert.equal(absent.calls.filter(call => call.method === 'moveMouseBy').length, 40);
  assert.deepEqual(absent.calls.filter(call => call.method === 'moveMouseBy').map(call => call.args[1]), [...Array(10).fill(-1000), ...Array(10).fill(1000), ...Array(10).fill(-1000), ...Array(10).fill(1000)]); released(absent);
});

test('stop flying observes landing and propagates source timeout after 50 Fly samples', async () => {
  const value = host({ onFind: findQueues({ SpaceKey: [true, false], XKey: [false] }) });
  const result = await actions(value).run('stop_flying', { waypoint: { action_params: '123' } });
  assert.equal(result.flyingEndedVerified, true); assert.equal(value.now(), 723); released(value);
  const stuck = host({ onFind: name => name === 'SpaceKey' ? region : empty });
  await assert.rejects(actions(stuck).run('stop_flying'), error => error.code === 'landingTimeout'); assert.equal(stuck.now(), 15000); released(stuck);
});

test('original Linnea parameters keep named overrides, Int32 rejection, clamps and minimum rounds', () => {
  for (const [text, expected] of [['', [1, 1]], ['3', [3, 3]], ['3,10', [3, 10]], [' rounds=2, mines=4, rounds=1 ', [4, 4]], ['0,-2', [1, 1]], ['9999,10000', [999, 999]], ['mines=oops,3,rounds=2', [3, 3]], ['2147483648,2', [2, 2]], ['1.2,no', [1, 1]], ['1,2,7,mines=3', [3, 3]]]) {
    const actual = parseLinneaParams(text); assert.deepEqual([actual.mineCount, actual.scanRounds], expected, text);
  }
});

test('mineral clustering uses strict dynamic distance, inclusive area ratio and nearest-two right preference', () => {
  const rect = (x, width = 40, height = 45) => ({ x, y: 300, width, height });
  assert.equal(clusterMinerals([rect(0), rect(399)]).length, 1);
  assert.equal(clusterMinerals([rect(0), rect(400)]).length, 2);
  assert.equal(clusterMinerals([rect(0), rect(0, 80, 90)]).length, 1);
  assert.equal(clusterMinerals([rect(0), rect(0, 81, 90)]).length, 2);
  const points = [rect(0), rect(10), rect(100)];
  assert.equal(clusterMinerals(points, { preferRight: true })[0].target.x, 10);
  assert.equal(clusterMinerals(points, { preferRight: false })[0].target.x, 10);
  const even = [rect(0), rect(100)];
  assert.equal(clusterMinerals(even, { preferRight: true })[0].target.x, 100);
  assert.equal(clusterMinerals(even, { preferRight: false })[0].target.x, 0);
});

test('mineral selection preserves float32 confidence threshold, integer bounds and central-region filtering', () => {
  const observed = nearestMineralCluster([box(950.9, 520.9, 40.9, 45.9, Math.fround(0.7)), box(0, 500), box(970, 530, 40, 45, 0.69)], { width: 1920, height: 1080 });
  assert.deepEqual(observed.cluster.target, { x: 950, y: 520, width: 40, height: 45 });
  assert.deepEqual(observed.center, { x: 960, y: 540 });
  assert.equal(nearestMineralCluster([box(900, 500, 40, 45, 0.69)], { width: 1920, height: 1080 }).cluster, null);
});

test('ScanPick follows configured duration without an empty-scan early exit and disposes one predictor per scan', async () => {
  const value = host(), job = new ScanPickJob(actions(value));
  const result = await job.run(10); assert.ok(result.elapsedMs >= 10000); assert.ok(result.scans > 10); assert.equal(result.targets, 0); assert.equal(result.outcomeVerified, false); released(value);
  await job.run(0); assert.equal(value.visions.filter(call => call.operation === 'yolo.create').length, 2); assert.equal(value.visions.filter(call => call.operation === 'yolo.dispose').length, 2); released(value);
});

test('ScanPick preserves the found view, source nearest-item formula and opposing-key release order', async () => {
  let detections = 0;
  const value = host({ onDetect() { return ++detections < 3 ? [] : [box(1100, 600, 40, 40, 0.9, 'drops')]; }, onInput(method, args, current) {
    if (method === 'keyDown') { assert.ok(!(current.keys.has('VK_W') && current.keys.has('VK_S'))); assert.ok(!(current.keys.has('VK_A') && current.keys.has('VK_D'))); }
  } });
  const result = await new ScanPickJob(actions(value)).run(1.8);
  assert.equal(result.targets, 1); assert.equal(value.calls.filter(call => call.method === 'middleButtonClick').length, 2);
  assert.deepEqual(value.calls.filter(call => call.method === 'keyDown').map(call => call.args[0]), ['VK_D', 'VK_W']); released(value);
  const ordering = host({ onDetect: () => [box(860, 845, 600, 40), box(1100, 845, 20, 40)] });
  await new ScanPickJob(actions(ordering)).run(0.7);
  assert.equal(ordering.calls.find(call => call.method === 'keyDown').args[0], 'VK_D'); released(ordering);
});

test('ScanPick errors and cancellation dispose frames/models and release movement keys', async () => {
  const broken = host({ onDetect() { throw new Error('model failure'); } });
  await assert.rejects(new ScanPickJob(actions(broken)).run(10), /model failure/); released(broken);
  const controller = new AbortController(), cancelled = host({ controller, onDetect: () => [box(300, 600)], onSleep(ms) { if (ms === 200) controller.abort(new Error('cancel pickup')); } });
  await assert.rejects(new ScanPickJob(actions(cancelled)).run(10), /cancel pickup/); released(cancelled);
});

test('Linnea aligned shot counts geometry only, uses original Mine model and exits aiming mode', async () => {
  const value = host({ onDetect: () => [box(940, 520, 40, 40)] });
  const result = await actions(value).run('linnea_mining');
  assert.deepEqual([result.shots, result.alignedShots, result.rounds, result.quotaReached, result.outcomeVerified], [1, 1, 1, true, false]);
  assert.equal(value.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_R').length, 2);
  assert.ok(value.visions.find(call => call.operation === 'yolo.create').args.path.endsWith('/Mine/bgi_mine.onnx'));
  assert.equal(value.now(), 4700); released(value);
});

test('Linnea lost detection rolls back accumulated aim, and continuous fallback shots do not count toward quota', async () => {
  let detection = 0;
  const lost = host({ onDetect: () => ++detection === 1 ? [box(1140, 420, 40, 40)] : [] });
  const result = await new LinneaMiningJob(actions(lost)).run();
  assert.equal(result.shots, 0); assert.equal(result.quotaReached, false);
  assert.deepEqual(lost.calls.filter(call => call.method === 'moveMouseBy').map(call => call.args), [[90, -80], [-90, 80]]); released(lost);
  const fallback = host({ onDetect: () => [box(1140, 420, 40, 40)] });
  const fallbackResult = await new LinneaMiningJob(actions(fallback)).run();
  assert.deepEqual([fallbackResult.shots, fallbackResult.alignedShots, fallbackResult.quotaReached], [1, 0, false]);
  assert.equal(fallback.visions.filter(call => call.operation === 'yolo.predict').length, 7);
  assert.deepEqual(fallback.calls.filter(call => call.method === 'moveMouseBy').at(-1).args, [0, -25]); released(fallback);
});

test('Linnea cancellation exits R aiming through raw cleanup after abort and always releases middle button/model', async () => {
  const controller = new AbortController(), value = host({ controller, onSleep(ms) { if (ms === 1500) controller.abort(new Error('cancel mining')); } });
  await assert.rejects(new LinneaMiningJob(actions(value)).run(), /cancel mining/);
  assert.equal(value.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_R').length, 2); released(value);
});

test('source retry overloads preserve action/delay/capture ordering and do not accept unobserved disappearance', async () => {
  const value = host({ onFind: findQueues({ Confirm: [true, false] }) }), action = actions(value);
  await action.waitElement('AutoWood', 'Confirm', (_, target) => action.click(target), 5, 1000, { screenshotAction: true, disappear: true });
  const click = value.calls[0]; assert.equal(click.at, 0); assert.deepEqual(click.args, [40, 40]); assert.equal(value.now(), 1000); assert.equal(value.images.size, 0);
  const still = host({ onFind: () => region }), stuck = actions(still);
  await assert.rejects(stuck.waitElement('AutoWood', 'Confirm', (_, target) => stuck.click(target), 1, 1000, { screenshotAction: true, disappear: true }), error => error.code === 'elementStillPresent');
  assert.equal(still.visions.filter(call => call.operation === 'image.find').length, 1); assert.equal(still.images.size, 0);
});

test('exit/relogin and Wonderland reuse actual source templates and require observed main UI', async () => {
  const relogin = host({ onFind: findQueues({ MenuBag: [false, true], Confirm: [true, true, false], EnterGame: [true, true, false], PaimonMenu: [true] }) });
  assert.equal((await actions(relogin).run('exit_and_relogin')).completion, 'mainUiAfterRelogin');
  assert.equal(relogin.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_ESCAPE').length, 2);
  assert.equal(relogin.calls.filter(call => call.method === 'click' && call.args[0] === 955 && call.args[1] === 666).length, 2); released(relogin);
  const wonderland = host({ onFind: findQueues({ WonderlandClose: [true], BtnBlackConfirm: [true, true, false, true, true, false], PaimonMenu: [true, true], BtnBackTeyvat: [true, true] }) });
  assert.equal((await actions(wonderland).run('wonderland_cycle')).completion, 'mainUiAfterWonderlandCycle'); released(wonderland);
  const bilibili = host(); await assert.rejects(actions(bilibili, { login3rdParty: 'Bilibili' }).run('exit_and_relogin'), UnsupportedNativeOperation); assert.equal(bilibili.calls.length, 1); released(bilibili);
});

test('fight preserves party override and loot split, and fight/fishing need actual completed task receipts', async () => {
  const value = host(), tasks = [];
  value.task = async (operation, payload) => { tasks.push([operation, payload]); return { completed: true, verified: true }; };
  const config = { StrategyName: '根据队伍自动选择', OnlyPickEliteDropsMode: 'DisableAutoPickupForNonElite', KazuhaPickupEnabled: true, PickDropsAfterFightEnabled: true };
  await actions(value).run('fight', { waypoint: { enable_monster_loot_split: true, monster_tag: 'normal' }, config: { Enabled: true, AutoFightEnabled: true, AutoFightConfig: config } });
  assert.equal(tasks[0][0], 'autoFight'); assert.equal(tasks[0][1].suspendAutoPick, true); assert.equal(tasks[0][1].autoPickResumeDelaySeconds, 5);
  assert.equal(tasks[0][1].config.KazuhaPickupEnabled, false); assert.equal(tasks[0][1].config.PickDropsAfterFightEnabled, false); assert.equal(config.KazuhaPickupEnabled, true); released(value);
  await actions(value, { autoFishingConfig: { AutoThrowRodEnabled: true } }).run('fishing');
  assert.deepEqual(tasks[1], ['autoFishing', { config: { AutoThrowRodEnabled: true }, waypoint: {} }]); assert.equal(value.now(), 1000); released(value);
  const missing = host(); await assert.rejects(actions(missing).run('fight'), UnsupportedNativeOperation); released(missing);
  const incomplete = host(); incomplete.task = async () => ({ executed: true });
  await assert.rejects(actions(incomplete).run('fishing'), error => error.code === 'taskIncomplete'); released(incomplete);
});
