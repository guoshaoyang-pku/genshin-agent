import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { AutoDomainTask, domainParameters, runAutoDomain } from './domain.mjs';
import { AutoFightTask } from './fight.mjs';
import { RewardResultRecognizer } from './reward.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const region = { x: 100, y: 100, width: 20, height: 20 };
function fixture({ width = 1920, height = 1080, observe, onCapture, onInput, onVision } = {}) {
  const controller = new AbortController(), images = new Set(), predictors = new Set(), events = [];
  let sequence = 0, time = 0;
  const host = {
    sourceRoot, signal: controller.signal, now: () => time, config: {},
    async capture() { const frame = { handle: ++sequence, width, height }; images.add(frame.handle); events.push(['capture', this.signal]); onCapture?.(frame); return frame; },
    async sleep(ms) { this.signal?.throwIfAborted(); time += ms; await yieldToEvents(); this.signal?.throwIfAborted(); },
    async input(method, args = []) { if (!/Up$|releaseAll/.test(method)) this.signal?.throwIfAborted(); events.push([method, args, this.signal]); await onInput?.(method, args); },
    async vision(op, args) {
      events.push([op, args, this.signal]);
      if (op === 'image.dispose') { images.delete(args.handle); return; }
      if (op === 'yolo.create') { predictors.add(1); await onVision?.(op); return { predictor: 1 }; }
      if (op === 'yolo.dispose') { predictors.delete(args.predictor); return; }
      this.signal?.throwIfAborted(); return observe?.(op, args) ?? (op === 'image.ocr' ? [] : {});
    },
    addTaskTrigger(timer) { events.push(['trigger', timer]); return { dispose: () => events.push(['trigger.dispose']) }; },
    log(...args) { events.push(['log', ...args]); },
  };
  return { host, controller, images, predictors, events, get time() { return time; } };
}
const make = (f, options = {}) => new AutoDomainTask(f.host, { taskConfig: { DomainRoundNum: 1 }, ...options });

test('domain parameters use original defaults, case-insensitive fields and explicit retry validation', () => {
  const { param, options } = domainParameters({ AutoDomainConfig: { ReviveRetryCount: 2 } }, { domainroundnum: 0, rewardrecognitionenabled: true }, sourceRoot);
  assert.equal(param.DomainRoundNum, 9999); assert.equal(param.RewardRecognitionEnabled, true); assert.equal(options.ReviveRetryCount, 2);
  for (const value of [-1, 1.5]) assert.throws(() => domainParameters({}, { DomainRoundNum: value }), /DomainRoundNum/);
  assert.throws(() => domainParameters({ AutoDomainConfig: { ReviveRetryCount: 0 } }), /positive integer/);
});

test('non-16:9 viewport fails before model creation and game input', async () => {
  const f = fixture({ height: 941 });
  await assert.rejects(make(f).start(), /16:9/);
  assert.equal(f.predictors.size, 0); assert.equal(f.images.size, 0);
  assert.ok(!f.events.some(([op]) => op === 'yolo.create' || op === 'keyDown'));
});

test('cancel during predictor allocation retains ownership and preserves falsy reason', async () => {
  let f; f = fixture({ onVision: () => f.controller.abort(false) });
  let caught = true; try { await make(f).start(); } catch (error) { caught = error; }
  assert.equal(caught, false); assert.equal(f.images.size, 0); assert.equal(f.predictors.size, 0);
  assert.equal(f.events.find(([op]) => op === 'yolo.dispose')[2], null);
});

test('domain lifecycle scopes AutoEat, retries only selected-domain path failure and joins background build', async () => {
  const f = fixture(), task = make(f, { config: { AutoDomainConfig: { AutoEat: true, ReviveRetryCount: 2 } }, taskConfig: { DomainName: '太山府', DomainRoundNum: 1 } });
  let attempts = 0, joined = false;
  task.comboBuildController = new AbortController();
  task.comboBuild = new Promise(resolve => task.comboBuildController.signal.addEventListener('abort', async () => { await yieldToEvents(); joined = true; resolve({ failed: true, error: task.comboBuildController.signal.reason }); }, { once: true }));
  task.doDomain = async () => { if (++attempts === 1) throw Object.assign(new Error('revive'), { code: 'PATH_RETRY' }); task.receipt.completion = 'roundLimit'; };
  task.waitMainUi = async () => { task.receipt.mainObserved = true; };
  const result = await task.start();
  assert.equal(attempts, 2); assert.equal(result.retries.length, 1); assert.equal(result.mainUiVerified, true); assert.equal(joined, true);
  assert.equal(f.events.filter(([op]) => op === 'trigger.dispose').length, 1);
  assert.equal(f.predictors.size, 0); assert.equal(f.images.size, 0);
});

test('missing selected domain never swallows a path retry or fabricates main UI completion', async () => {
  const f = fixture(), task = make(f), failure = Object.assign(new Error('retry'), { code: 'PATH_RETRY' });
  task.doDomain = async () => { throw failure; }; task.waitMainUi = async () => assert.fail('must not reach completion');
  await assert.rejects(task.start(), error => error === failure);
  assert.equal(f.predictors.size, 0);
});

test('post-domain salvage keeps source low-star-only null settings instead of invoking five-star rules', async () => {
  const f = fixture(), task = make(f, { taskConfig: { DomainRoundNum: 1, AutoArtifactSalvage: true, MaxArtifactStar: '3' } });
  task.doDomain = async () => { task.receipt.completion = 'roundLimit'; }; task.waitMainUi = async () => {};
  let requested; f.host.task = async (name, args) => { requested = { name, args }; return { completion: 'fixture' }; };
  const result = await task.start();
  assert.deepEqual(requested, { name: 'autoArtifactSalvage', args: { config: { Star: 3, JavaScript: null, ArtifactSetFilter: null, MaxNumToCheck: null, RecognitionFailurePolicy: null } } });
  assert.equal(result.salvage.completion, 'fixture'); assert.equal(f.images.size, 0); assert.equal(f.predictors.size, 0);
});

test('final explicit round exits reward page instead of entering an extra challenge', async () => {
  const f = fixture(), task = make(f); let waits = 0;
  task.waitFor = async observe => ++waits === 1 ? false : observe({ handle: 7, width: 1920, height: 1080 });
  task.text = async () => null; task.recognizeRewards = async () => {};
  task.find = async (frame, group, name) => ({ ...region, text: name });
  const clicks = []; task.click = async target => clicks.push(target.text);
  const result = await task.treasure({ finalRound: true });
  assert.deepEqual(result, { repeat: false, completion: 'roundLimit' }); assert.deepEqual(clicks, ['Exit']);
});

test('round orchestration resets skill tracker and passes final-round state', async () => {
  const f = fixture(), states = [], state = { team: [{ lastSkillAt: 100, manualSkillCd: 2 }], skillTracker: new Map([['old', true]]) };
  const task = make(f, { combatState: state, taskConfig: { DomainRoundNum: 2 } });
  for (const method of ['teleport', 'enter', 'closeTip', 'walkToPressF', 'fight', 'alignTree']) task[method] = async () => ({});
  task.prepareFight = async () => ({ kind: 'json' });
  task.treasure = async args => { states.push(args.finalRound); return { repeat: !args.finalRound, completion: 'roundLimit' }; };
  await task.doDomain(); assert.deepEqual(states, [false, true]); assert.equal(state.skillTracker.size, 0);
  assert.equal(state.team[0].lastSkillAt, -Infinity); assert.equal(task.receipt.rounds.length, 2);
});

test('reward recognition follows task flag, accumulates observations and tolerates optional OCR failure', async t => {
  const f = fixture(), task = make(f, { taskConfig: { DomainRoundNum: 1, RewardRecognitionEnabled: true } });
  task.waitFor = async () => true;
  const method = t.mock.method(RewardResultRecognizer.prototype, 'recognizeMultiPage', async () => ({ summary: { 摩拉: 10 }, evidence: 'fixture' }));
  await task.recognizeRewards(); assert.equal(task.summary.摩拉, 10);
  method.mock.mockImplementation(async () => { throw new Error('OCR unavailable'); });
  await task.recognizeRewards(); assert.equal(task.receipt.rewardObservations.at(-1).skipped, 'recognitionFailed');
  f.controller.abort(null); let caught = true;
  try { await task.recognizeRewards(); } catch (error) { caught = error; } assert.equal(caught, null);
});

test('fight waits for canceled worker cleanup before returning observed completion', async t => {
  const f = fixture(), task = make(f); let workerStopped = false;
  t.mock.method(AutoFightTask.prototype, 'start', async function () {
    try { while (true) await this.host.sleep(100); }
    finally { await yieldToEvents(); workerStopped = true; }
  });
  t.mock.method(AutoDomainTask.prototype, 'domainEnd', async () => ({ evidence: 'domainEndOcr' }));
  const result = await task.fight({ kind: 'json', strategy: {} });
  assert.equal(workerStopped, true); assert.equal(result.endObservation.evidence, 'domainEndOcr');
  assert.equal(task.combatState.fightActive, false); assert.equal(f.events.at(-1)[0], 'releaseAll');
});

test('late worker failure prevents a successful fight receipt', async t => {
  const f = fixture(), task = make(f), failure = new Error('late cleanup failure');
  t.mock.method(AutoFightTask.prototype, 'start', async function () { try { while (true) await this.host.sleep(100); } finally { throw failure; } });
  t.mock.method(AutoDomainTask.prototype, 'domainEnd', async () => ({ evidence: 'domainEndOcr' }));
  await assert.rejects(task.fight({ kind: 'json', strategy: {} }), error => error === failure);
});

test('tree movement starts only after six consecutive east camera samples', async () => {
  let orientations = 0, firstMovement = 0;
  const f = fixture({ observe: op => op === 'map.cameraOrientation' ? { valid: true, angle: ++orientations < 3 ? 90 : 0 } : op === 'yolo.predict' ? [{ bounds: { x: 950, width: 20 } }] : undefined,
    onInput: (method, args) => { if (method === 'keyDown' && args[0] === 'VK_W') firstMovement ||= orientations; } });
  const task = make(f); task.predictor = 1;
  const result = await task.alignTree();
  assert.ok(firstMovement >= 8); assert.equal(result.eastConsecutiveRequired, 6); assert.equal(result.completion, 'centeredTree'); assert.equal(f.images.size, 0);
});

test('wrapper preserves original reward summary and detailed receipt opt-in', async t => {
  t.mock.method(AutoDomainTask.prototype, 'start', async () => ({ rewardSummary: { 摩拉: 3 }, completion: 'fixture' }));
  assert.deepEqual(await runAutoDomain(fixture().host), { 摩拉: 3 });
  assert.equal((await runAutoDomain(fixture().host, { detailed: true })).completion, 'fixture');
});
