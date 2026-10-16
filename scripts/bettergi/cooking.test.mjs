import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CookingTask, runAutoCook } from './cooking.mjs';
import { VisionProcess } from './host.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const button = { x: 1400, y: 900, width: 100, height: 40 };
function fixture({ counts = [], recoverAt = 8, cook = () => true, confirm = () => false, width = 1920, height = 1080, controller, onSleep, fail } = {}) {
  let clock = 0, frame = 0, handle = 0;
  const images = new Map(), calls = [], inputs = [], uiChecks = [], logs = [];
  const host = {
    sourceRoot, images, calls, inputs, uiChecks, logs, signal: controller?.signal, now: () => clock,
    log(level, text) { logs.push({ level, text }); },
    async capture() { const image = { handle: ++handle, width, height, frame: ++frame }; images.set(handle, image); return image; },
    async sleep(ms) { clock += ms; calls.push({ op: 'sleep', ms, at: clock, frame }); await onSleep?.(ms); },
    async input(method, args) { inputs.push({ method, args, at: clock, frame }); },
    async vision(op, args) {
      calls.push({ op, args, at: clock, frame });
      if (op === 'image.dispose') { images.delete(args.handle); return; }
      if (op === 'recognition.load') {
        const json = JSON.parse(await readFile(args.path, 'utf8'));
        assert.ok(json.objects[args.objectName], args.objectName);
        const template = path.join(path.dirname(args.path), '1920x1080', json.objects[args.objectName].template);
        assert.ok((await readFile(template)).length > 0);
        return { ...json.objects[args.objectName], name: args.objectName };
      }
      const image = images.get(args.handle); assert.ok(image, 'owned image for ' + op);
      if (op === 'image.find') {
        const name = args.recognition.name;
        if (name === 'UiLeftTopCookIcon') { uiChecks.push(image.frame); return cook(image.frame) ? button : empty; }
        if (name === 'BtnWhiteRecover') return image.frame >= recoverAt ? button : empty;
        if (name === 'BtnWhiteConfirm') return confirm(image.frame) ? button : empty;
        throw new Error('Unexpected original template ' + name);
      }
      if (fail?.(op, args, image.frame)) throw new Error('vision failed');
      if (op === 'image.crop' || op === 'image.mat' && ['CvtColor', 'InRange'].includes(args.method)) {
        const result = { ...image, handle: ++handle }; images.set(handle, result); return result;
      }
      if (op === 'image.mat' && args.method === 'CountNonZero') return counts[image.frame - 1] ?? 0;
      throw new Error('Unexpected vision operation ' + op);
    },
    get frameCount() { return frame; },
  };
  return host;
}
const presses = host => host.inputs.filter(call => call.method === 'keyPress');
const assertReleased = host => { assert.equal(host.inputs.at(-1).method, 'releaseAll'); assert.equal(host.images.size, 0); };

test('AutoCook uses original templates and plateau/drop timing while checking active UI every400ms', async () => {
  const host = fixture({ counts: [610, 629, 630, 900, 331, 330], recoverAt: 41 });
  const result = await runAutoCook(host);
  assert.deepEqual(host.uiChecks, [1, 41]); assert.deepEqual(presses(host).map(call => [call.frame, call.args]), [[6, ['SPACE']]]);
  assert.deepEqual(result, { completion: 'recoverButtonObserved', recoverButtonObserved: true, frames: 41, confirmations: 0, spacePresses: 1, verified: false });
  assertReleased(host);
});

test('peak threshold is strict, tolerance is20, and unstable candidates restart the3frame window', async () => {
  const host = fixture({ counts: [600, 601, 622, 603, 612, 323, 322], recoverAt: 8 });
  await runAutoCook(host, { checkIntervalMs: 400 });
  assert.deepEqual(presses(host).map(call => call.frame), [7]); assertReleased(host);
});

test('short captures use original min-axis rectangle and linear truncated count thresholds', async () => {
  const host = fixture({ width: 960, height: 360, counts: [201, 210, 205, 111, 110], recoverAt: 6 });
  await runAutoCook(host, { checkIntervalMs: 400 });
  assert.deepEqual(presses(host).map(call => call.frame), [5]);
  const crop = host.calls.find(call => call.op === 'image.crop').args; assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [200, 220, 243, 63]);
  assert.deepEqual(host.calls.find(call => call.op === 'image.mat' && call.args.method === 'CvtColor').args.args, ['BGR2RGB']);
  assert.deepEqual(host.calls.find(call => call.op === 'image.mat' && call.args.method === 'InRange').args.args, [[255, 192, 64], [255, 192, 64]]); assertReleased(host);
});

test('leaving the cooking UI clears an unfinished peak before reentry', async () => {
  const host = fixture({ counts: [700, 710, 0, 710, 410, 720, 720, 720, 420], recoverAt: 10, cook: frame => frame !== 3 });
  await runAutoCook(host, { checkIntervalMs: 400 });
  assert.deepEqual(presses(host).map(call => call.frame), [9]);
  assert.equal(host.calls.some(call => call.op === 'image.crop' && call.frame === 3), false); assertReleased(host);
});

test('white confirmation preserves Bv500ms wait and clears a built peak before counting the same frame', async () => {
  const host = fixture({ counts: [700, 700, 700, 400], recoverAt: 5, confirm: frame => frame === 4 });
  const result = await runAutoCook(host, { config: { AutoCookConfig: { CheckIntervalMs: 400 } } });
  assert.equal(result.confirmations, 1); assert.deepEqual(presses(host), []);
  const click = host.inputs.find(call => call.method === 'click'); assert.deepEqual(click.args, [1450, 920]); assert.equal(click.at, 1700);
  const frame4Count = host.calls.find(call => call.op === 'image.mat' && call.args.method === 'CountNonZero' && call.frame === 4); assert.equal(frame4Count.at, 1700); assertReleased(host);
});

test('recover button stops immediately without counting and disabled stop continues until cancellation', async () => {
  const host = fixture({ recoverAt: 1 }); const result = await runAutoCook(host);
  assert.equal(result.frames, 1); assert.equal(host.calls.some(call => call.op === 'image.crop'), false); assertReleased(host);
  const controller = new AbortController(), continuing = fixture({ controller, recoverAt: 1, onSleep: () => controller.abort(new Error('stop cooking')) });
  await assert.rejects(runAutoCook(continuing, { stopTaskWhenRecoverButtonDetected: false }), /stop cooking/);
  assert.equal(continuing.calls.some(call => call.op === 'image.find' && call.args.recognition.name === 'BtnWhiteRecover'), false);
  assert.equal(continuing.calls.some(call => call.op === 'image.crop'), true); assertReleased(continuing);
});

test('inactive UI is checked on every frame, minimum interval is1ms, and cancellation releases input', async () => {
  const controller = new AbortController(); let sleeps = 0;
  const host = fixture({ controller, cook: () => false, onSleep: () => { if (++sleeps === 3) controller.abort(new Error('inactive stop')); } });
  await assert.rejects(runAutoCook(host, { CheckIntervalMs: 0 }), /inactive stop/);
  assert.deepEqual(host.uiChecks, [1, 2, 3]); assert.deepEqual(host.calls.filter(call => call.op === 'sleep').map(call => call.ms), [1, 1, 1]);
  assert.equal(host.calls.some(call => call.op === 'image.crop'), false); assertReleased(host);
});

test('failed color conversion disposes its crop and frame and never fabricates completion', async () => {
  for (const method of ['CvtColor', 'InRange', 'CountNonZero']) {
    const host = fixture({ fail: (op, args) => op === 'image.mat' && args.method === method });
    await assert.rejects(runAutoCook(host), /vision failed/); assertReleased(host);
  }
});

test('configuration rejects malformed values and pre-abort performs no capture', async () => {
  assert.throws(() => new CookingTask(fixture(), { checkIntervalMs: NaN }), /integer/);
  assert.throws(() => new CookingTask(fixture(), { stopTaskWhenRecoverButtonDetected: 'true' }), /boolean/);
  const controller = new AbortController(); controller.abort(new Error('already stopped'));
  const host = fixture({ controller }); await assert.rejects(runAutoCook(host), /already stopped/); assert.equal(host.frameCount, 0); assertReleased(host);
});

test('cancellation during absent button recognition stops before any color pipeline work', async () => {
  for (const name of ['BtnWhiteRecover', 'BtnWhiteConfirm']) {
    const controller = new AbortController(), host = fixture({ controller });
    const vision = host.vision.bind(host);
    host.vision = async (op, args) => {
      const result = await vision(op, args);
      if (op === 'image.find' && args.recognition.name === name) controller.abort(new Error('recognition stop'));
      return result;
    };
    await assert.rejects(runAutoCook(host), /recognition stop/);
    assert.equal(host.calls.some(call => call.op === 'image.crop'), false); assertReleased(host);
  }
});

test('concurrent start remains rejected until pending input release completes', async () => {
  const host = fixture({ recoverAt: 1 }), input = host.input.bind(host);
  let unblock, entered;
  const releasing = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { unblock = resolve; });
  host.input = async (method, args) => { await input(method, args); if (method === 'releaseAll') { entered(); await gate; } };
  const task = new CookingTask(host), pending = task.start(); await releasing;
  await assert.rejects(task.start(), /already running/); unblock(); await pending;
  assert.equal(task.running, false); assertReleased(host);
});

test('real vision bridge counts only exact RGB pixels and releases crop/color/mask handles', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'bgi-cook-pixels-'));
  const pixels = Buffer.alloc(1920 * 1080 * 3);
  pixels.set([255, 192, 64, 255, 192, 64, 254, 192, 64, 255, 192, 65], (660 * 1920 + 600) * 3);
  const filename = path.join(folder, 'exact-color.ppm');
  const header = 'P6' + String.fromCharCode(10) + '1920 1080' + String.fromCharCode(10) + '255' + String.fromCharCode(10);
  await writeFile(filename, Buffer.concat([Buffer.from(header), pixels]));
  const service = new VisionProcess(); let frame;
  try {
    frame = await service.call('image.load', { path: filename, type: 'ImageRegion' });
    const host = { vision: (op, args) => service.call(op, args) };
    const count = await new CookingTask(host).countTargetColor(frame, [600, 660, 730, 190]);
    assert.equal(count, 2); assert.equal((await service.call('vision.status')).imageHandles, 1);
  } finally {
    if (frame) await service.call('image.dispose', { handle: frame.handle });
    await service.close(); await rm(folder, { recursive: true, force: true });
  }
});
