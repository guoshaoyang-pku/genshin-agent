import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FishingTask, FishingController, runAutoFishing } from './fishing.mjs';
import { loadRodNet } from './native.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 }, button = { x: 1400, y: 900, width: 100, height: 40 };
const fish = (baitType = 'FruitPasteBait') => ({ baitType, rect: { x: 700, y: 300, width: 100, height: 50 }, confidence: 0.9 });
const pond = (fishes = [fish()]) => ({ width: 1920, height: 1080, detectionCount: fishes.length, fishpondRect: { x: 500, y: 200, width: 800, height: 400 }, targetRect: { x: 800, y: 500, width: 100, height: 50 }, fishes });
function fixture(options = {}) {
  let clock = 0, sequence = 0, captures = 0;
  const images = new Map(), inputs = [], calls = [], logs = [], times = [];
  const host = {
    sourceRoot, signal: options.controller?.signal, images, inputs, calls, logs, times, random: () => 0.25,
    now: () => clock,
    advance(ms) { clock += ms; },
    log(level, text) { logs.push({ level, text }); },
    async capture() {
      clock += options.captureStep ?? 100;
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080, frame: ++captures };
      images.set(frame.handle, frame); await options.onCapture?.(frame, host); return frame;
    },
    async input(method, args = []) { this.signal?.throwIfAborted(); inputs.push({ method, args, at: clock }); await options.onInput?.(method, args, host); },
    async sleep(ms) { this.signal?.throwIfAborted(); clock += ms; calls.push({ op: 'sleep', ms, at: clock }); await options.onSleep?.(ms, host); },
    async setTime(hour, minute) { times.push([hour, minute]); },
    async vision(op, args) {
      if (op !== 'image.dispose') this.signal?.throwIfAborted();
      calls.push({ op, args, at: clock });
      if (op === 'image.dispose') { assert.ok(images.has(args.handle), 'dispose owned image ' + args.handle); images.delete(args.handle); return; }
      if (op === 'recognition.load') {
        const json = JSON.parse(await readFile(args.path, 'utf8'));
        const ro = json.objects[args.objectName]; assert.ok(ro, args.objectName);
        const template_path = path.join(path.dirname(args.path), '1920x1080', ro.template); assert.ok((await readFile(template_path)).length > 0);
        return { ...ro, template_path, name: args.objectName };
      }
      const frame = images.get(args.handle); assert.ok(frame, 'image exists for ' + op);
      const override = await options.observe?.(op, args, frame, host);
      if (override !== undefined) return override;
      if (op === 'image.findMulti') return options.coOp ? [button] : [];
      if (op === 'image.find') return args.recognition.name === 'PaimonMenu' ? button : empty;
      if (op === 'image.ocr') return [];
      if (op === 'fishing.ui') return Object.fromEntries(args.names.map(name => [name, null]));
      if (op === 'fishing.fishpond') return { ...pond([]), detectionCount: 0, fishpondRect: empty, targetRect: null };
      if (op === 'fishing.bite') return { bite: false };
      if (op === 'fishing.baitGrid') return [];
      if (op === 'fishing.selectedBait') return { baitType: null };
      if (op === 'fishing.fishBox') return { rect: null, reason: 'count' };
      if (op === 'fishing.control') return { missing: true, desiredPressed: null, resetNoDetectionTimer: false, invalidTwoRects: false };
      if (op === 'image.mat') {
        if (args.method === 'SetTo') return;
        const result = { ...frame, handle: ++sequence }; images.set(result.handle, result); return result;
      }
      if (op === 'image.save') return true;
      throw new Error('Unexpected vision operation ' + op);
    },
    get captures() { return captures; },
  };
  return host;
}
function nodes(node) { return [node, ...node.children.flatMap(nodes)]; }
const findNode = (round, name) => { const result = nodes(round.root).find(node => node.name === name); assert.ok(result, name); return result; };
function makeRound(host, options = {}) { return new FishingTask(host, { config: { fishingTimePolicy: 3 }, ...options }).createRound(); }
async function frameFor(round) { round.frame = await round.host.capture(); return round.frame; }
const released = host => { assert.equal(host.images.size, 0); assert.equal(host.inputs.at(-1).method, 'releaseAll'); };

// These cases exercise source scheduling through the actual fishing tree.
test('parallel ticks every child before failure wins, and successful synchronized children are skipped', async () => {
  const host = fixture(), round = makeRound(host), p = findNode(round, 'InitialSearch');
  const events = [], [work, guard] = p.children;
  work.kind = undefined; work.children = []; work.update = () => { events.push('work'); return 'Failure'; };
  guard.update = () => { events.push('guard'); return 'Success'; };
  assert.equal(await p.tick(round), 'Failure'); assert.deepEqual(events, ['work', 'guard']);
  p.stop('Invalid'); events.length = 0; let ticks = 0;
  work.update = () => { events.push('work'); return ++ticks < 2 ? 'Running' : 'Success'; };
  assert.equal(await p.tick(round), 'Running'); assert.equal(await p.tick(round), 'Success');
  assert.deepEqual(events, ['work', 'guard', 'work']);
});

test('nested Try handoff advances Cast then RaiseHook then Quit and waits for real delays', async () => {
  const host = fixture(), round = makeRound(host);
  await frameFor(round);
  const outer = findNode(round, 'EnterAndQuit'), body = outer.children[0], keep = findNode(round, 'KeepFishing');
  const loop = keep.children[0], ignored = loop.children[0], from = ignored.children[0], castWait = findNode(round, 'CastWaitRaise');
  const castBody = castWait.children[0], castParallel = castBody.children[0], repeated = castParallel.children[0], selector = repeated.children[0], aiming = selector.children[0], aimBody = aiming.children[0];
  for (const node of [outer, body, keep, loop, ignored, from, castWait, castBody, castParallel, repeated, selector, aiming, aimBody]) node.status = 'Running';
  body.current = 1; loop.current = 0; from.current = 3; castBody.current = 0; selector.current = 0; aimBody.current = 1;
  findNode(round, 'LiftRod').status = 'Running'; round.blackboard.handoffTimeSeconds = 1;
  assert.equal(await outer.handoff(round), 'Running'); assert.equal(host.inputs.at(-1).method, 'leftButtonUp');
  host.advance(1999); assert.equal(await outer.handoff(round), 'Running');
  host.advance(1); assert.equal(await outer.handoff(round), 'Running');
  host.advance(2000); assert.equal(await outer.handoff(round), 'Invalid');
  assert.equal(findNode(round, 'QuitFishingMode').status, 'Success');
  assert.deepEqual(host.inputs.map(call => call.method), ['leftButtonUp']); await round.disposeFrame();
});

test('All, Daytime, Nighttime, DontChange and co-op preserve source setTime rounds', async () => {
  for (const [policy, coOp, expected] of [[0, false, [7, 19]], [1, false, [7]], [2, false, [19]], [3, false, []], [0, true, []]]) {
    const host = fixture({ coOp, captureStep: 1000 });
    const result = await runAutoFishing(host, { config: { fishingTimePolicy: policy, wholeProcessTimeoutSeconds: 1 } });
    assert.deepEqual(host.times.map(value => value[0]), expected); assert.equal(result.rounds.length, expected.length || 1);
    assert.equal(result.coOp, coOp); assert.equal(result.verified, false); assert.equal(result.inventoryVerified, false); assert.equal(result.barDisappearanceCount, 0); released(host);
  }
});

test('bait choice keeps an already selected usable bait and otherwise uses stable majority excluding two failures', async () => {
  const host = fixture({ observe: op => op === 'fishing.baitGrid' ? [{ rect: button, baitType: 'B' }] : undefined });
  const round = makeRound(host), choose = findNode(round, 'ChooseBait'); await frameFor(round);
  round.blackboard.fishpond = pond([fish('A'), fish('B'), fish('B'), fish('C')]); round.blackboard.selectedBait = 'A';
  assert.equal(await choose.tick(round), 'Success'); assert.deepEqual(host.inputs, []);
  choose.stop('Invalid'); round.blackboard.selectedBait = null; round.blackboard.chooseBaitFailures.push('A', 'A');
  assert.equal(await choose.tick(round), 'Running'); assert.equal(await choose.tick(round), 'Success');
  assert.equal(round.blackboard.selectedBait, 'B'); assert.equal(round.blackboard.chooseBaitUIOpening, false);
  assert.deepEqual(host.inputs.map(call => call.method), ['rightButtonClick', 'moveMouseBy', 'click', 'click']);
  const confirmation = host.calls.find(call => call.op === 'image.find' && call.args.recognition.use3Channels);
  assert.deepEqual(confirmation.args.recognition.roi, [0, 0, 1920, 1080]);
  assert.equal(host.calls.filter(call => call.op === 'sleep').reduce((sum, call) => sum + call.ms, 0), 2000); await round.disposeFrame();
});

test('missing bait fails at3s, records each failed enum and clears selected bait', async () => {
  const host = fixture(), round = makeRound(host), choose = findNode(round, 'ChooseBait'); await frameFor(round);
  round.blackboard.fishpond = pond([fish('A')]);
  assert.equal(await choose.tick(round), 'Running'); host.advance(2400);
  assert.equal(await choose.tick(round), 'Failure'); assert.deepEqual(round.blackboard.chooseBaitFailures, ['A']);
  assert.equal(round.blackboard.selectedBait, null); assert.equal(round.blackboard.chooseBaitUIOpening, false); assert.equal(host.inputs.at(-1).args[0], 'VK_ESCAPE');
  await round.disposeFrame();
});

test('GetFishpond ignores both source failure lists, preserves cadence across restarts and passes ignoreObtained', async () => {
  const host = fixture({ observe: op => op === 'fishing.fishpond' ? pond([fish('A')]) : undefined }), round = makeRound(host), get = findNode(round, 'GetFishpond'); await frameFor(round);
  round.blackboard.throwRodNoBaitFishFailures.push('A', 'A'); assert.equal(await get.tick(round), 'Running');
  assert.equal(host.calls.find(call => call.op === 'fishing.fishpond').args.ignoreObtained, true);
  get.stop('Invalid'); get.interval = host.now() + 500;
  const count = host.calls.length; assert.equal(await get.tick(round), 'Running'); assert.equal(host.calls.length, count);
  host.advance(500); round.blackboard.throwRodNoBaitFishFailures = []; assert.equal(await get.tick(round), 'Success'); await round.disposeFrame();
});

test('RodNet aiming uses original normalization observation, source direction formulas and finite guard', async () => {
  let state = 1, aim = { currentFish: fish(), rodInput: {}, dx: 6, dy: 8, distance: 10 };
  const host = fixture({ observe: op => op === 'fishing.fishpond' ? pond() : op === 'fishing.rodInput' ? aim : undefined });
  const round = makeRound(host), lift = findNode(round, 'LiftRod'); round.rodNet = { getRodState: () => state }; round.blackboard.selectedBait = 'FruitPasteBait'; await frameFor(round);
  assert.equal(await lift.tick(round), 'Running'); assert.deepEqual(host.inputs.map(call => [call.method, call.args]), [['leftButtonDown', []], ['moveMouseBy', [-12, -36]]]);
  state = 2; assert.equal(await lift.tick(round), 'Running'); assert.deepEqual(host.inputs.at(-1).args, [4, 12]);
  state = 0; assert.equal(await lift.tick(round), 'Success');
  const request = host.calls.find(call => call.op === 'fishing.rodInput'); assert.equal(request.args.selectedBait, 'FruitPasteBait'); assert.ok(request.args.fishpond.targetRect);
  lift.stop('Invalid'); state = 1; aim = { ...aim, distance: 0 };
  await assert.rejects(lift.tick(round), /distance is zero/); await round.disposeFrame();
  const original = await loadRodNet(sourceRoot);
  assert.equal(original.parameters.dz.length, 11); assert.throws(() => original.getRodState({ fish_label: 0 }), /Invalid rod_x1/);
});

test('three complete target-search failures abort;11 no-bait-fish detections record the bait', async () => {
  const host = fixture(), round = makeRound(host), lift = findNode(round, 'LiftRod'); await frameFor(round);
  for (let i = 0; i < 3; i++) {
    lift.stop('Invalid'); assert.equal(await lift.tick(round), 'Running'); host.advance(5001); assert.equal(await lift.tick(round), 'Failure');
  }
  assert.equal(round.blackboard.throwRodNoTargetTimes, 3); assert.equal(round.blackboard.abort, true);
  const fishHost = fixture({ observe: op => op === 'fishing.fishpond' ? pond() : op === 'fishing.rodInput' ? { currentFish: null } : undefined });
  const r = makeRound(fishHost), leaf = findNode(r, 'LiftRod'); await frameFor(r); r.blackboard.selectedBait = 'A';
  for (let i = 0; i < 10; i++) assert.equal(await leaf.tick(r), 'Running');
  assert.equal(await leaf.tick(r), 'Failure'); assert.deepEqual(r.blackboard.throwRodNoBaitFishFailures, ['A']); assert.equal(r.blackboard.selectedBait, null); assert.equal(r.blackboard.throwRodNoBaitFish, true);
  await round.disposeFrame(); await r.disposeFrame();
});

test('bite timeout recalls once then fails2s later; RaiseHook waits800ms after observed button', async () => {
  const host = fixture({ observe: (op, args) => op === 'fishing.ui' ? Object.fromEntries(args.names.map(name => [name, name === 'WaitBiteButton' ? button : null])) : undefined });
  const round = makeRound(host), timeout = findNode(round, 'FishBiteTimeout'), raise = findNode(round, 'RaiseHook'); await frameFor(round);
  assert.equal(await timeout.tick(round), 'Running'); host.advance(15000); assert.equal(await timeout.tick(round), 'Running');
  host.advance(1999); assert.equal(await timeout.tick(round), 'Running'); host.advance(1); assert.equal(await timeout.tick(round), 'Failure');
  assert.equal(host.inputs.length, 1); assert.equal(await raise.tick(round), 'Running'); host.advance(799); assert.equal(await raise.tick(round), 'Running'); host.advance(1); assert.equal(await raise.tick(round), 'Success');
  assert.equal(host.inputs.length, 2); await round.disposeFrame();
});

test('bar control changes button state only at transitions and reports disappearance without catch proof', async () => {
  let control = { sourceCount: 2, desiredPressed: true, resetNoDetectionTimer: true, missing: false };
  const host = fixture({ observe: op => op === 'fishing.control' ? control : undefined }), round = makeRound(host), reel = findNode(round, 'Fishing'); await frameFor(round);
  assert.equal(await reel.tick(round), 'Running'); assert.equal(await reel.tick(round), 'Running'); assert.equal(host.inputs.length, 1);
  control = { ...control, desiredPressed: false }; await reel.tick(round); assert.equal(host.inputs.at(-1).method, 'leftButtonUp');
  control = { missing: true }; assert.equal(await reel.tick(round), 'Running'); host.advance(900);
  control = { invalidTwoRects: true }; assert.equal(await reel.tick(round), 'Running'); host.advance(100);
  control = { missing: true }; assert.equal(await reel.tick(round), 'Success');
  assert.equal(round.stats.barDisappearanceCount, 1); assert.equal('caught' in round.stats, false); await round.disposeFrame();
});

test('semiauto borrows entry frames, skips67ms and uses fresh captures without autocasting', async () => {
  const host = fixture({ observe: (op, args) => op === 'fishing.ui' ? Object.fromEntries(args.names.map(name => [name, button])) : undefined });
  const controller = new FishingController(host, { config: { enabled: true, autoThrowRodEnabled: true } });
  const borrowed = await host.capture();
  assert.equal((await controller.tick(borrowed)).reason, 'enteredFishingUi');
  assert.equal(host.captures, 1); assert.equal(host.images.size, 1); assert.deepEqual(host.inputs, []);
  host.advance(67); assert.equal((await controller.tick(borrowed)).reason, 'interval'); assert.equal(host.captures, 1);
  host.advance(1); assert.equal((await controller.tick(borrowed)).reason, 'fishing');
  assert.equal(host.captures, 2); assert.equal(host.images.size, 1); assert.ok(host.images.has(borrowed.handle));
  assert.deepEqual(host.inputs, []);
  assert.deepEqual(host.calls.filter(call => call.op.startsWith('fishing.')).map(call => call.op), ['fishing.ui', 'fishing.ui', 'fishing.bite']);
  await host.vision('image.dispose', { handle: borrowed.handle }); await controller.close(); released(host);
});

test('semiauto completes bite, raise and reel and still ticks its reel branch on the exit frame', async () => {
  let bite = true, present = true, control = { sourceCount: 3, desiredPressed: true, resetNoDetectionTimer: true, missing: false };
  const host = fixture({ observe: (op, args) => {
    if (op === 'fishing.ui') return Object.fromEntries(args.names.map(name => [name, name === 'ExitFishingButton' ? present ? button : null : button]));
    if (op === 'fishing.bite') return { bite };
    if (op === 'fishing.fishBox') return { rect: button };
    if (op === 'fishing.control') return control;
  } });
  const controller = new FishingController(host, { config: { enabled: true } });
  await controller.tick(); assert.equal(host.inputs.length, 0);
  const first = await controller.tick(); assert.equal(first.hookClicks, 1); assert.equal(host.inputs.at(-1).method, 'leftButtonClick');
  host.advance(800); await controller.tick(); assert.equal(host.inputs.at(-1).method, 'leftButtonDown');
  control = { missing: true }; await controller.tick(); host.advance(1000);
  const complete = await controller.tick(); assert.equal(complete.barDisappearanceCount, 1); assert.equal(complete.verified, false); assert.equal(complete.inventoryVerified, false);
  bite = false; present = false; const before = host.calls.filter(call => call.op === 'fishing.bite').length;
  const exit = await controller.tick(); assert.equal(exit.reason, 'leftFishingUi');
  assert.equal(host.calls.filter(call => call.op === 'fishing.bite').length, before + 1); released(host); await controller.close();
});

test('debug screenshots clone and mask original UID geometry without mutating borrowed pixels', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bettergi-fishing-screenshot-'));
  try {
    const host = fixture({ width: 3840, height: 2160 }), round = makeRound(host, { screenshotDir: dir }); await frameFor(round);
    const original = round.frame.handle; await round.saveScreenshot('Fishing', 'Error');
    assert.equal(host.images.size, 1); assert.ok(host.images.has(original));
    const mat = host.calls.filter(call => call.op === 'image.mat');
    assert.deepEqual(mat.map(call => call.args.method), ['Clone', 'SubMat', 'SetTo']);
    assert.deepEqual(mat[1].args.args, [[3370, 2106, 356, 44]]); assert.deepEqual(mat[2].args.args, [[255, 255, 255]]);
    assert.notEqual(host.calls.find(call => call.op === 'image.save').args.handle, original);
    const disposed = host.calls.filter(call => call.op === 'image.dispose').map(call => call.args.handle);
    assert.deepEqual(disposed, [mat[2].args.handle, mat[1].args.handle]); await round.disposeFrame();
    const plain = fixture(), noMask = makeRound(plain, { config: { CommonConfig: { screenshotUidCoverEnabled: false } }, screenshotDir: dir }); await frameFor(noMask);
    await noMask.saveScreenshot('Cast', 'Success'); assert.equal(plain.calls.filter(call => call.op === 'image.mat').length, 0);
    assert.equal(plain.calls.find(call => call.op === 'image.save').args.handle, noMask.frame.handle); await noMask.disposeFrame();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('screenshot postallocation cancellation and save failure dispose every owned clone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bettergi-fishing-cancel-'));
  try {
    for (const cancellation of ['Clone', 'SubMat', 'saveFailure']) {
      const ac = new AbortController(), error = new Error(cancellation);
      const host = fixture({ controller: ac }), round = makeRound(host, { screenshotDir: dir }); await frameFor(round);
      const original = host.vision; host.vision = async function (op, args) {
        if (op === 'image.save' && cancellation === 'saveFailure') throw error;
        const result = await original.call(this, op, args);
        if (op === 'image.mat' && args.method === cancellation) ac.abort(error);
        return result;
      };
      await assert.rejects(round.saveScreenshot('Fishing', 'Error'), value => value === error);
      assert.equal(host.images.size, 1); assert.ok(host.images.has(round.frame.handle)); await round.disposeFrame(); assert.equal(host.images.size, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cleanup passes an explicit null signal through hosts with default cancellation arguments', async () => {
  const ac = new AbortController(), error = new Error('cancel allocation'), host = fixture({ controller: ac });
  const originalVision = host.vision, originalInput = host.input;
  const service = {
    signal: ac.signal,
    async vision(op, args, signal = this.signal) {
      signal?.throwIfAborted();
      const result = await originalVision.call({ signal }, op, args);
      if (op === 'image.mat' && args.method === 'Clone') ac.abort(error);
      signal?.throwIfAborted(); return result;
    },
    async input(method, args, signal = this.signal) { signal?.throwIfAborted(); return originalInput.call({ signal }, method, args); },
  };
  host.vision = function (op, args) { return service.vision(op, args, this.signal); };
  host.input = function (method, args) { return service.input(method, args, this.signal); };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bettergi-fishing-default-signal-'));
  try {
    const round = makeRound(host, { screenshotDir: dir }); await frameFor(round);
    await assert.rejects(round.saveScreenshot('Cast', 'Success'), value => value === error); assert.equal(host.images.size, 1);
    await round.disposeFrame(); await assert.rejects(runAutoFishing(host, { config: { fishingTimePolicy: 3 } }), value => value === error); released(host);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('capture cancellation and capture failure preserve caller frames and release held inputs', async () => {
  for (const point of ['before', 'after', 'failure']) {
    const ac = new AbortController(), error = new Error(point); let cancelCapture = false;
    const host = fixture({ controller: ac, onCapture: () => { if (cancelCapture && point === 'after') ac.abort(error); } });
    const controller = new FishingController(host, { config: { enabled: true } });
    controller.exclusive = true; cancelCapture = true;
    if (point === 'before') ac.abort(error);
    if (point === 'failure') host.capture = async () => { throw error; };
    await assert.rejects(controller.tick(), value => value === error); released(host); await controller.close();
  }
});

test('disable and close await in-flight cleanup, reject concurrent ticks and retain unrelated failures', async () => {
  let entered, resume; const enteredPromise = new Promise(resolve => { entered = resolve; });
  const resumePromise = new Promise(resolve => { resume = resolve; });
  const host = fixture({ observe: async (op, args) => {
    if (op === 'fishing.ui') { entered(); await resumePromise; return Object.fromEntries(args.names.map(name => [name, button])); }
  } });
  const controller = new FishingController(host, { enabled: true });
  const pending = controller.tick(), pendingResult = assert.rejects(pending, /controller disabled/); await enteredPromise;
  await assert.rejects(controller.tick(), /already running/);
  const closing = controller.close(); assert.equal(controller.close(), closing); let closed = false; closing.then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); resume(); await pendingResult; await closing; released(host);
  assert.equal((await controller.tick()).reason, 'closed'); await assert.rejects(controller.setEnabled(true), /closed/);

  let fail; const failure = new Error('vision failed independently'), failingHost = fixture({ observe: op => op === 'fishing.ui' ? new Promise((_, reject) => { fail = reject; }) : undefined });
  const failing = new FishingController(failingHost, { enabled: true }), running = failing.tick(), rejected = assert.rejects(running, value => value === failure);
  while (!fail) await Promise.resolve();
  const disabling = failing.setEnabled(false), disablingRejected = assert.rejects(disabling, value => value === failure); fail(failure);
  await Promise.all([rejected, disablingRejected]); released(failingHost);
});

test('solo config overrides source defaults and rejects invalid timeout, policy and state types', () => {
  const host = fixture(), fallback = new FishingTask(host, { config: { AutoFishingConfig: { WholeProcessTimeoutSeconds: 60, AutoThrowRodTimeOut: 12, FishingTimePolicy: 2 } }, taskConfig: {} });
  assert.equal(fallback.config.wholeProcessTimeoutSeconds, 60); assert.equal(fallback.config.throwRodTimeOutTimeoutSeconds, 12); assert.equal(fallback.config.fishingTimePolicy, 2);
  const task = new FishingTask(host, { taskConfig: { wholeProcessTimeoutSeconds: 20, throwRodTimeOutTimeoutSeconds: 4, fishingTimePolicy: 3, saveScreenshotOnKeyTick: true } });
  assert.equal(task.config.wholeProcessTimeoutSeconds, 20); assert.equal(task.config.throwRodTimeOutTimeoutSeconds, 4); assert.equal(task.config.saveScreenshotOnKeyTick, true);
  for (const options of [{ taskConfig: { wholeProcessTimeoutSeconds: -1 } }, { config: { autoThrowRodTimeOut: 1.5 } }, { taskConfig: { fishingTimePolicy: 4 } }, { enabled: 'true' }, { taskConfig: { saveScreenshotOnKeyTick: 'false' } }, { config: { CommonConfig: { screenshotUidCoverEnabled: 1 } } }, { config: { AutoPickConfig: { itemTextLeftOffset: 400, itemTextRightOffset: 115 } } }]) assert.throws(() => new FishingTask(host, options));
});

test('canceling the actual task during aim finishes nested Cast and RaiseHook before permitting another run', async () => {
  for (const cancelOnAim of [1, 2]) {
  const ac = new AbortController(), cancellation = new Error('stop fishing'); let aimed = 0, releaseEntered, resumeRelease;
  const entered = new Promise(resolve => { releaseEntered = resolve; }), release = new Promise(resolve => { resumeRelease = resolve; });
  const host = fixture({ controller: ac, observe: (op, args) => {
    if (op === 'fishing.ui') return Object.fromEntries(args.names.map(name => [name, button]));
    if (op === 'fishing.fishpond') return pond();
    if (op === 'fishing.baitGrid') return [{ rect: button, baitType: 'FruitPasteBait' }];
    if (op === 'fishing.rodInput') return { currentFish: fish(), rodInput: {}, dx: 6, dy: 8, distance: 10 };
  }, onInput: async (method, args) => {
    if (method === 'moveMouseBy' && args[0] === -12 && ++aimed === cancelOnAim) ac.abort(cancellation);
    if (method === 'releaseAll') { releaseEntered(); await release; }
  } });
  const task = new FishingTask(host, { config: { fishingTimePolicy: 3 } }), original = task.createRound;
  task.createRound = function () { const round = original.call(this); round.rodNet = { getRodState: () => 1 }; return round; };
  const pending = task.start(), rejected = assert.rejects(pending, value => value === cancellation); await entered;
  await assert.rejects(task.start(), /already running/); assert.equal(task.running, true);
  assert.equal(task.round.stats.casts, 1); assert.equal(task.round.stats.hookClicks, 1);
  const cast = host.inputs.find(call => call.method === 'leftButtonUp'), hook = host.inputs.find(call => call.method === 'leftButtonClick');
  assert.ok(hook.at - cast.at >= 2000); assert.ok(host.inputs.at(-1).at - hook.at >= 800);
  assert.equal(host.inputs.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_ESCAPE').length, 0);
  resumeRelease(); await rejected; assert.equal(task.running, false); released(host);
  }
});

test('task preserves the operational error when handoff capture and input release also fail', async () => {
  const originalError = new Error('aim observation failed'), handoffError = new Error('handoff capture failed'), releaseError = new Error('release failed'); let aimed = 0, failed = false;
  const host = fixture({ observe: (op, args) => {
    if (op === 'fishing.ui') return Object.fromEntries(args.names.map(name => [name, button]));
    if (op === 'fishing.fishpond') return pond();
    if (op === 'fishing.baitGrid') return [{ rect: button, baitType: 'FruitPasteBait' }];
    if (op === 'fishing.rodInput') { if (++aimed === 2) { failed = true; throw originalError; } return { currentFish: fish(), rodInput: {}, dx: 6, dy: 8, distance: 10 }; }
  }, onInput: method => { if (method === 'releaseAll') throw releaseError; } });
  const capture = host.capture; host.capture = async function () { if (failed) throw handoffError; return capture.call(this); };
  const task = new FishingTask(host, { config: { fishingTimePolicy: 3 } }), create = task.createRound;
  task.createRound = function () { const round = create.call(this); round.rodNet = { getRodState: () => 1 }; return round; };
  await assert.rejects(task.start(), value => value === originalError); assert.equal(task.running, false); assert.equal(host.images.size, 0);
  assert.ok(host.logs.some(entry => entry.text.includes(handoffError.message))); assert.ok(host.logs.some(entry => entry.text.includes(releaseError.message)));
});

test('inactive game returns its observed reason and release failure is visible on an otherwise normal stop', async () => {
  const host = fixture(); host.isGameActive = async () => false;
  const result = await runAutoFishing(host, { config: { fishingTimePolicy: 3 } });
  assert.equal(result.completion, 'gameInactive'); assert.deepEqual(result.rounds, []); assert.equal(result.verified, false); released(host);
  const error = new Error('could not release'), failing = fixture({ onInput: method => { if (method === 'releaseAll') throw error; } });
  failing.isGameActive = async () => false; await assert.rejects(runAutoFishing(failing, { config: { fishingTimePolicy: 3 } }), value => value === error);
});
