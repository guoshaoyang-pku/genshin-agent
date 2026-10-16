import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RewardItem, RewardResultRecognizer, createRewardSummary, detectRewardDuplicates, mergeRewardSummary, toRewardItems } from './reward.mjs';
import { VisionProcess } from './host.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const reward = (name, count = 1, qualityLevel = -1) => ({ name, count, qualityLevel });
const item = (name, quantity = 1, quality = -1, index = -1) => new RewardItem(name, quality, quantity, index);

function hostFor(options = {}) {
  let sequence = 0, page = 0;
  const events = [], images = new Set(), createdImages = new Set(), disposedImages = new Set(), sessions = new Set();
  const host = {
    signal: options.controller?.signal, runDir: options.runDir ?? '/tmp/bettergi-reward-test', events, images, sessions, createdImages, disposedImages,
    log(level, message) { events.push({ op: 'log', level, message }); },
    async capture() {
      this.signal?.throwIfAborted();
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080 };
      images.add(frame.handle); createdImages.add(frame.handle); events.push({ op: 'capture', frame, signal: this.signal });
      await options.onCapture?.(frame, host); this.signal?.throwIfAborted(); return frame;
    },
    async input(method, args = []) {
      this.signal?.throwIfAborted(); events.push({ op: 'input', method, args, signal: this.signal });
      await options.onInput?.(method, args, host);
    },
    async sleep(ms) { this.signal?.throwIfAborted(); events.push({ op: 'sleep', ms }); await options.onSleep?.(ms, host); },
    async vision(op, args) {
      this.signal?.throwIfAborted(); events.push({ op, args, signal: this.signal });
      if (op === 'image.dispose') {
        assert.ok(images.delete(args.handle)); disposedImages.add(args.handle); await options.onDispose?.(args, host); return;
      }
      if (op === 'reward.create') {
        const session = 'session-' + ++sequence; sessions.add(session);
        await options.onCreate?.(session, host); this.signal?.throwIfAborted();
        return { session, model: { mode: args.mode, files: [] } };
      }
      if (op === 'reward.release') { assert.ok(sessions.delete(args.session)); await options.onRelease?.(args, host); return; }
      if (op === 'reward.page') {
        assert.ok(images.has(args.handle)); assert.ok(sessions.has(args.session));
        const current = ++page; await options.onPage?.(current, host); this.signal?.throwIfAborted();
        const result = options.pages?.[current - 1] ?? [];
        return Array.isArray(result) ? { rewards: result, cardRects: [], warnings: [], observations: [] } : result;
      }
      throw new Error('Unexpected operation ' + op);
    },
  };
  return host;
}
function released(host) {
  assert.deepEqual(host.createdImages, host.disposedImages); assert.equal(host.images.size, 0); assert.equal(host.sessions.size, 0);
  const releases = host.events.filter(event => ['image.dispose', 'reward.release'].includes(event.op) || event.method === 'releaseAll' || event.method === 'leftButtonUp');
  assert.ok(releases.every(event => event.signal === null));
  assert.equal(host.events.filter(event => event.op === 'input').at(-1).method, 'releaseAll');
}

test('RewardItem original constructor defaults, ToString and Int32 values', () => {
  assert.deepEqual({ ...new RewardItem() }, { Name: '', QualityLevel: -1, Quantity: 0, PositionIndex: 0 });
  assert.deepEqual({ ...item('苹果', 4) }, { Name: '苹果', QualityLevel: -1, Quantity: 4, PositionIndex: -1 });
  assert.equal(item('苹果', 4).ToString(), '苹果 x4');
  assert.equal(item('苹果', -1).toString(), '苹果 x-1');
  for (const invalid of [NaN, 1.5, Infinity, 2147483648, -2147483649, '1', true]) assert.throws(() => item('a', invalid), /Int32/);
});

test('conversion filters only null or empty names, normalizes negative count and reindexes known names', () => {
  const result = toRewardItems([reward(null), reward(''), reward('苹果', -1), reward(' ', 0), reward('摩拉', 12, -1)]);
  assert.deepEqual(result.map(i => [i.Name, i.Quantity, i.PositionIndex]), [['苹果', 1, 0], [' ', 0, 1], ['摩拉', 12, 2]]);
  assert.deepEqual(result.map(i => i.QualityLevel), [-1, -1, -1]);
});

test('dedupe checks only current prefix and previous last10, may reuse same previous match', () => {
  const previous = Array.from({ length: 12 }, (_, i) => item('p' + i, i));
  assert.equal(detectRewardDuplicates([item('p1', 1), item('p11', 11)], previous), 0);
  assert.equal(detectRewardDuplicates([item('p2', 2), item('p2', 2), item('new')], previous), 2);
  assert.equal(detectRewardDuplicates([item('p10', 10), item('new'), item('p11', 11)], previous), 1);
  assert.equal(detectRewardDuplicates([item('p11', 11), item('p10', 10)], previous), 2);
  assert.equal(detectRewardDuplicates([item('a'), item('a'), item('a')], [item('a')]), 1);
  assert.equal(detectRewardDuplicates([item('a', 2)], [item('a', 1)]), 0);
  assert.equal(detectRewardDuplicates([item('a', 1, 5)], [item('a', 1, -1)]), 0);
  assert.equal(detectRewardDuplicates([item('a', 1, -1, 7)], [item('a', 1, -1, 0)]), 1);
});

test('summary uses checked Int32 sums and treats dictionary names as own keys', () => {
  const summary = createRewardSummary([item('苹果', 2), item('苹果', 4), item('__proto__', 3), item('constructor', 7)]);
  assert.equal(summary['苹果'], 6); assert.equal(summary.__proto__, 3); assert.equal(summary.constructor, 7);
  assert.equal(Object.getPrototypeOf(summary), Object.prototype);
  assert.throws(() => createRewardSummary([item('a', 2147483647), item('a', 1)]), /Int32/);
  assert.throws(() => createRewardSummary([item(null)]), /name must be a string/);
});

test('MergeIntoSummary source unknown handling and unchecked cumulative overflow', () => {
  const summary = { known: 4, unknown: -1, keep: 5 };
  assert.equal(mergeRewardSummary(summary, { known: 3, unknown: 2, keep: -5, absent: -7 }), summary);
  assert.deepEqual(summary, { known: 7, unknown: 2, keep: 5, absent: -1 });
  RewardResultRecognizer.MergeIntoSummary(summary, { known: -1, absent: 0 }); assert.equal(summary.known, 7); assert.equal(summary.absent, 0);
  RewardResultRecognizer.mergeIntoSummary(summary, { overflow: 2147483647 });
  mergeRewardSummary(summary, { overflow: 1 }); assert.equal(summary.overflow, -2147483648);
  mergeRewardSummary(summary, { overflow: 3 }); assert.equal(summary.overflow, 3);
  mergeRewardSummary(summary, JSON.parse('{"__proto__":2}')); assert.equal(summary.__proto__, 2);
});

test('unsupported resolution checks own screenshot and creates no recognizer', async () => {
  const host = hostFor({ width: 1280, height: 720 });
  const result = await new RewardResultRecognizer(host).recognizeMultiPage(3);
  assert.equal(result.supportedResolution, false); assert.equal(result.stopReason, 'unsupportedResolution'); assert.deepEqual(result.summary, {});
  assert.equal(host.events.filter(e => e.op === 'reward.create').length, 0);
  assert.deepEqual(host.events.filter(e => e.method === 'moveMouseTo').map(e => e.args), [[960, 720]]); released(host);
});

test('zero and negative maxPages still create and dispose one recognizer after resolution capture', async () => {
  for (const maximum of [0, -1, -2147483648]) {
    const host = hostFor(), result = await new RewardResultRecognizer(host).RecognizeMultiPage(maximum);
    assert.deepEqual(result.pages, []); assert.deepEqual(result.summary, {});
    assert.equal(result.model.mode, 'Item'); assert.equal(result.evidence.completed, true);
    assert.equal(host.events.filter(e => e.op === 'capture').length, 1);
    assert.equal(host.events.filter(e => e.op === 'reward.create').length, 1); released(host);
  }
});

test('invalid page limits reject before allocating or sending input', async () => {
  for (const maximum of [true, null, '3', 1.2, Infinity, 2147483648]) {
    const host = hostFor(); await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(maximum), /Int32/); assert.equal(host.events.length, 0);
  }
});

test('pages share fresh model, stop at duplicate prefix after adding new suffix and preserve exact drag', async () => {
  const host = hostFor({ pages: [[reward('苹果', 2), reward('摩拉', 100)], [reward('摩拉', 100), reward('树脂', -1)], [reward('should not reach')]] });
  const result = await new RewardResultRecognizer(host).recognizeMultiPage(3);
  assert.equal(result.stopReason, 'duplicatePrefix'); assert.equal(result.pages.length, 2);
  assert.deepEqual(result.summary, { 苹果: 2, 摩拉: 100, 树脂: 1 });
  assert.equal(result.pages[1].duplicateCount, 1); assert.equal(result.pages[1].newItems[0].Name, '树脂');
  assert.equal(result.evidence.kind, 'model-and-ocr-estimate'); assert.equal(result.evidence.verifiedRewards, false);
  const down = host.events.findIndex(e => e.method === 'leftButtonDown'), up = host.events.findIndex(e => e.method === 'leftButtonUp');
  const drag = host.events.slice(down + 1, up);
  assert.deepEqual(drag.filter(e => e.method === 'moveMouseTo').map(e => e.args), Array.from({ length: 21 }, (_, step) => [1650 - step * 70, 540]));
  assert.deepEqual(drag.filter(e => e.op === 'sleep').map(e => e.ms), [100, ...Array(21).fill(30)]);
  assert.equal(host.events[up + 1].ms, 1200);
  assert.equal(host.events.filter(e => e.op === 'capture').length, 3);
  assert.equal(host.events.filter(e => e.op === 'reward.create').length, 1); released(host);
});

test('no overlap accumulates to maxPages, empty recognized rewards stops immediately', async () => {
  const host = hostFor({ pages: [[reward('a', 1)], [reward('a', 2)], [reward('b', 3)]] });
  const result = await new RewardResultRecognizer(host).recognizeMultiPage(3);
  assert.equal(result.stopReason, 'maxPages'); assert.deepEqual(result.summary, { a: 3, b: 3 }); released(host);
  const empty = hostFor({ pages: [[], [reward('unreachable')]] });
  const stopped = await new RewardResultRecognizer(empty).recognizeMultiPage();
  assert.equal(stopped.stopReason, 'noRecognizedRewards'); assert.equal(stopped.pages.length, 1); assert.deepEqual(stopped.summary, {}); released(empty);
});

test('source empty-name reward list does not trigger raw-empty stop', async () => {
  const host = hostFor({ pages: [[reward('')], [reward(' ', 0), reward('a', -2)], []] });
  const result = await new RewardResultRecognizer(host).recognizeMultiPage(3);
  assert.equal(result.pages.length, 3); assert.deepEqual(result.summary, { ' ': 0, a: 1 }); released(host);
});

test('configured mode aliases and both screenshot gates control debug paths, save warning remains nonfatal', async () => {
  for (const [screenshots, rewards] of [[false, true], [true, false], [true, true]]) {
    const host = hostFor({ pages: [{ rewards: [reward('a')], warnings: [{ code: 'debugSave', message: 'fixture save failed' }], debug: { saved: false } }] });
    const config = { otherconfig: { itemiconrecognitionmode: 'gridicon' }, commonconfig: { screenshotenabled: screenshots, rewardrecognitionscreenshotenabled: rewards } };
    const result = await new RewardResultRecognizer(host, { config }).recognizeMultiPage(1);
    const args = host.events.find(e => e.op === 'reward.page').args;
    assert.equal(args.debugPath, screenshots && rewards ? path.join(host.runDir, 'RewardRecognition/rewardRecDebug1.png') : undefined);
    assert.equal(result.model.mode, 'GridIcon'); assert.deepEqual(result.summary, { a: 1 }); released(host);
  }
});

test('each invocation allocates its own model and invalid configured mode cannot leak resolution image', async () => {
  const host = hostFor({ pages: [[reward('a')], [reward('b')]] }), recognizer = new RewardResultRecognizer(host);
  await recognizer.recognizeMultiPage(1); await recognizer.recognizeMultiPage(1);
  assert.equal(host.events.filter(e => e.op === 'reward.create').length, 2); released(host);
  const invalid = hostFor();
  await assert.rejects(new RewardResultRecognizer(invalid, { config: { OtherConfig: { ItemIconRecognitionMode: false } } }).recognizeMultiPage(), /mode/i); released(invalid);
});

test('cancel during screenshot allocation disposes allocated frame with null signal', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, onCapture: () => controller.abort(new Error('cancel capture')) });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), /cancel capture/);
  assert.equal(host.events.filter(e => e.op === 'reward.create').length, 0); released(host);
});

test('cancel during model allocation still owns and releases session', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, onCreate: () => controller.abort(new Error('cancel model')) });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), /cancel model/); released(host);
});

test('cancel during recognition releases page image, model and all inputs', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, onPage: () => controller.abort(new Error('cancel page')) });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), /cancel page/); released(host);
});

test('cancel immediately after mouse down and during drag always releases button', async () => {
  for (const cancelAt of ['down', 'move']) {
    const controller = new AbortController(); let down = false;
    const host = hostFor({ controller, pages: [[reward('a')]], onInput(method) {
      if (method === 'leftButtonDown') { down = true; if (cancelAt === 'down') controller.abort(new Error('cancel drag')); }
      if (method === 'moveMouseTo' && down && cancelAt === 'move') controller.abort(new Error('cancel drag'));
    } });
    await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), /cancel drag/);
    assert.equal(host.events.filter(e => e.method === 'leftButtonUp').length, 1); released(host);
  }
});

test('primary page error survives image, model and releaseAll failures with partial evidence', async () => {
  const primary = new Error('page primary');
  const host = hostFor({ onPage: () => { throw primary; }, onDispose: (args, h) => { if (h.createdImages.size > 1) throw new Error('dispose failed'); },
    onRelease: () => { throw new Error('release model failed'); }, onInput: method => { if (method === 'releaseAll') throw new Error('release input failed'); } });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), error => error === primary && error.evidence.evidence.completed === false && error.evidence.evidence.cleanupFailed === true);
  released(host);
});

test('cleanup-only failure rejects and marks evidence incomplete, further cleanup is attempted', async () => {
  const host = hostFor({ pages: [[reward('a')]], onRelease: () => { throw new Error('release failed'); } });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(1), error => error.message === 'release failed' && error.evidence.evidence.completed === false && error.evidence.evidence.cleanupFailed); released(host);
});

test('falsy cancellation reasons survive screenshot, model and input cleanup failures', async () => {
  for (const reason of [null, 0, false, '']) {
    const controller = new AbortController();
    const host = hostFor({ controller, onPage: () => controller.abort(reason),
      onDispose: (args, h) => { if (h.createdImages.size > 1) throw new Error('dispose failed'); },
      onRelease: () => { throw new Error('model release failed'); },
      onInput: method => { if (method === 'releaseAll') throw new Error('input release failed'); } });
    let caught = false;
    try { await new RewardResultRecognizer(host).recognizeMultiPage(); }
    catch (error) { caught = true; assert.equal(error, reason); }
    assert.ok(caught); released(host);
  }
});

test('falsy cancellation during drag survives mouse-up failure and still releases resources', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, pages: [[reward('a')]], onInput(method) {
    if (method === 'leftButtonDown') controller.abort(null);
    if (method === 'leftButtonUp') throw new Error('mouse up failed');
  } });
  let caught = false;
  try { await new RewardResultRecognizer(host).recognizeMultiPage(); }
  catch (error) { caught = true; assert.equal(error, null); }
  assert.ok(caught); assert.equal(host.events.filter(e => e.method === 'leftButtonUp').length, 1); released(host);
});

test('screenshot disposal failure alone rejects before creating a model', async () => {
  const primary = new Error('screenshot disposal failed');
  const host = hostFor({ onDispose: () => { throw primary; } });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(), error => error === primary && !error.evidence.evidence.completed);
  assert.equal(host.events.filter(e => e.op === 'reward.create').length, 0); released(host);
});

test('summary overflow preserves recognized page evidence and releases resources', async () => {
  const host = hostFor({ pages: [[reward('a', 2147483647), reward('a', 1)]] });
  await assert.rejects(new RewardResultRecognizer(host).recognizeMultiPage(1), error => /Int32/.test(error.message) && error.evidence.items.length === 2 && !error.evidence.evidence.completed); released(host);
});

test('real VisionProcess reuses original asset/model/OCR, dedupes synthetic page and leaves no handles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bgi-reward-')), fixture = path.join(directory, 'reward.png');
  const python = process.env.BETTERGI_PYTHON ?? path.join(project, 'venv/bin/python');
  const generated = spawnSync(python, ['-c', [
    'import cv2, numpy as np, sys',
    'image=np.zeros((1080,1920,3),np.uint8)',
    'card=np.full((153,125,3),100,np.uint8);card[125:]=(220,229,233)',
    'asset=cv2.imread(sys.argv[1]);card[50:71,49:75]=asset',
    'cv2.putText(card,"1850",(8,147),cv2.FONT_HERSHEY_SIMPLEX,.55,(60,60,60),1,cv2.LINE_AA)',
    'image[488:641,250:375]=card',
    'assert cv2.imwrite(sys.argv[2],image)',
  ].join('\n'), path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoWood/Assets/1920x1080/TheBoonOfTheElderTree.png'), fixture], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const service = new VisionProcess({ sourceRoot }), inputs = [], releasedSessions = [];
  const host = { runDir: directory, sleep: async () => {}, input: async (method, args) => { inputs.push({ method, args }); },
    capture: () => service.call('image.load', { path: fixture, type: 'ImageRegion' }),
    vision: async (op, args) => { const result = await service.call(op, args); if (op === 'reward.release') releasedSessions.push(result); return result; } };
  try {
    const config = { OtherConfig: { ItemIconRecognitionMode: 0 }, CommonConfig: { ScreenshotEnabled: true, RewardRecognitionScreenshotEnabled: true } };
    const result = await new RewardResultRecognizer(host, { config }).recognizeMultiPage(3);
    assert.equal(result.pages.length, 2); assert.equal(result.stopReason, 'duplicatePrefix');
    assert.equal(result.items.length, 1); assert.equal(result.items[0].Quantity, 1850); assert.equal(result.items[0].QualityLevel, -1);
    assert.equal(result.summary[result.items[0].Name], 1850);
    assert.equal(result.pages[0].rewards[0].countRecognition.rawText, '1850');
    assert.equal(result.model.files[0].sha256, 'ac56acadfe8b8ffdf2bfeac2c3b56415d2aa2c51c2d4f9c4264ef2f40de8cd18');
    assert.equal(result.evidence.verifiedRewards, false); assert.equal(result.pages[0].debug.saved, true);
    assert.ok((await readFile(path.join(directory, 'RewardRecognition/rewardRecDebug1.png'))).length);
    assert.deepEqual(releasedSessions, [{ released: true, sessions: 0 }]);
    assert.equal((await service.call('vision.status')).imageHandles, 0);
    assert.equal(inputs.at(-1).method, 'releaseAll');
    await assert.rejects(service.call('reward.page', { session: 'reward-1', handle: 1 }), /reward-1/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
