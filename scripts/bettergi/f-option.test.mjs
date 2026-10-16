import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ChooseFOptionTask, normalizeFOptionText, fOptionCandidateRect, mergeFOptionRows, fOptionScrollClicks, findPickInteraction } from './f-option.mjs';
import { RealtimeDispatcher } from './realtime.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source/', import.meta.url));
const row = (text, y = 500, x = 1230, width = 150, height = 30) => ({ text, x, y, width, height });
const pick = { x: 1100, y: 500, width: 30, height: 30 };
const empty = { x: 0, y: 0, width: 0, height: 0 };
function fixture({ current = '石化古树', rows = [], onInput, onCapture, onVision, onSleep, onDispose, controller, config = {}, width = 1920, height = 1080, found = true } = {}) {
  let id = 0, frame = 0, clock = 0, paused = 0;
  const images = new Map(), calls = [];
  const host = {
    sourceRoot, config, signal: controller?.signal, images, calls, now: () => clock,
    pauseAutoPick() { paused++; let done = false; return { dispose() { if (!done) { done = true; paused--; } } }; },
    get paused() { return paused; },
    async sleep(ms) { calls.push({ method: 'sleep', args: [ms], paused }); clock += ms; await onSleep?.(ms, host); },
    async capture() { const image = { handle: ++id, width, height, frame: ++frame }; images.set(id, image); await onCapture?.(image, this); return image; },
    async input(method, args = []) { calls.push({ method, args, paused }); await onInput?.(method, args, this); },
    log() {},
    async vision(op, args) {
      await onVision?.(op, args, this);
      if (op === 'recognition.load') {
        const source = JSON.parse(await readFile(args.path, 'utf8')); assert.ok(source.objects[args.objectName], args.objectName);
        return { ...source.objects[args.objectName], name: args.objectName, template_path: fileURLToPath(new URL('./1920x1080/' + source.objects[args.objectName].template, 'file://' + args.path)) };
      }
      if (op === 'image.dispose') { images.delete(args.handle); await onDispose?.(this); return; }
      const image = images.get(args.handle); assert.ok(image, 'owned image for ' + op);
      if (op === 'image.find') return (typeof found === 'function' ? found(image.frame) : found) ? { ...pick } : { ...empty };
      if (op === 'realtime.pickText') return { text: typeof current === 'function' ? current(image.frame) : current, alreadyPicking: false };
      if (op === 'image.ocr') return typeof rows === 'function' ? rows(image.frame) : rows;
      throw new Error('Unexpected vision operation ' + op);
    },
  };
  return host;
}
const inputs = host => host.calls.filter(call => call.method !== 'sleep');
const rejectedValue = async promise => { try { await promise; assert.fail('expected rejection'); } catch (error) { return error; } };

test('source normalization merges whitespace and brackets without fuzzy matching', () => {
  assert.equal(normalizeFOptionText(' 【石化 古树]\n'), '「石化古树」');
  assert.notEqual(normalizeFOptionText('石化古树'), normalizeFOptionText('开启石化古树'));
  assert.deepEqual(fOptionCandidateRect({ width: 1920, height: 1080 }, pick), [1215, 0, 285, 860]);
  assert.deepEqual(fOptionCandidateRect({ width: 960, height: 540 }, { x: 550, y: 250 }), [607, 0, 142, 430]);
  assert.deepEqual(fOptionCandidateRect({ width: 960, height: 540 }, { x: 950, y: 20 }), [960, 0, 0, 430]);
});

test('source row geometry merges OCR fragments before computing wheel notches', () => {
  const rows = mergeFOptionRows([row('树', 501, 1290, 30), row('古', 500, 1260, 30), row('石化', 500, 1200, 60), row('离开', 570), row(' ', 620), row('无效', 700, 1200, 0)]);
  assert.deepEqual(rows.map(item => item.text), ['石化古树', '离开']);
  assert.equal(fOptionScrollClicks(rows, pick, '离开'), -1);
  assert.equal(fOptionScrollClicks(rows, { ...pick, y: 570 }, '石化古树'), 1);
  assert.equal(fOptionScrollClicks([...rows, row('离开', 640)], pick, '离开'), null);
  assert.equal(fOptionScrollClicks([row('石化古树', 490), row('离开', 520)], pick, '离开'), null);
});

test('current exact text presses configured interaction key while AutoPick remains paused', async () => {
  const host = fixture({ current: ' 石化 古树\n', config: { AutoPickConfig: { PickKey: 'VK_F' } } });
  assert.equal(await new ChooseFOptionTask(host).singleSelectText('石化古树'), true);
  assert.deepEqual(inputs(host).map(call => [call.method, call.args]), [['keyDown', ['F']], ['keyUp', ['F']]]);
  assert.ok(inputs(host).every(call => call.paused === 1));
  assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
});

test('unknown custom key falls back to original F template and F input', async () => {
  const host = fixture({ config: { autoPickConfig: { pickKey: 'VK_NOT_A_KEY' } } });
  assert.equal(await new ChooseFOptionTask(host).singleSelectText('石化古树'), true);
  assert.deepEqual(inputs(host).map(call => call.args), [['F'], ['F']]);
  assert.equal(host.images.size, 0);
});

test('scrolls candidate index difference one notch at a time and confirms fresh OCR', async () => {
  const host = fixture({ current: frame => frame === 1 ? '第一行' : '石化古树', rows: [row('第一行'), row('第二行', 565), row('石化古树', 630)] });
  assert.equal(await new ChooseFOptionTask(host).singleSelectText('石化古树'), true);
  assert.deepEqual(inputs(host).map(call => [call.method, call.args]), [['verticalScroll', [-1]], ['verticalScroll', [-1]], ['keyDown', ['F']], ['keyUp', ['F']]]);
  assert.ok(inputs(host).every(call => call.paused === 1)); assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
});

test('fresh confirmation mismatch never presses key after scrolling', async () => {
  const host = fixture({ current: '第一行', rows: [row('第一行'), row('石化古树', 570)] });
  assert.equal(await new ChooseFOptionTask(host).singleSelectText('石化古树'), false);
  assert.deepEqual(inputs(host).map(call => call.method), ['verticalScroll']); assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
});

test('ambiguous targets perform five source retry movements then stop without selection', async () => {
  const host = fixture({ current: '其他', rows: [row('其他'), row('石化古树', 560), row('石化古树', 620)] });
  assert.equal(await new ChooseFOptionTask(host, { dpi: 1.5 }).singleSelectText('石化古树'), false);
  assert.deepEqual(inputs(host).map(call => [call.method, call.args]), Array.from({ length: 5 }, () => ['moveMouseBy', [600, 0]]));
  assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
});

test('missing interaction template terminates without mouse retries or key presses', async () => {
  const host = fixture({ found: false });
  assert.equal(await new ChooseFOptionTask(host).singleSelectText('石化古树'), false);
  assert.deepEqual(inputs(host), []); assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
});

test('rejects blank input before acquiring AutoPick lease', async () => {
  const host = fixture();
  await assert.rejects(new ChooseFOptionTask(host).singleSelectText(' \n'), /不能为空/);
  await assert.rejects(new ChooseFOptionTask(host).singleSelectText(null), /字符串/);
  assert.equal(host.calls.length, 0); assert.equal(host.paused, 0);
});

test('cancellation during capture releases newly allocated frame through uncancelled transport', async () => {
  const controller = new AbortController(); let disposeSignal = 'unset';
  const host = fixture({ controller, onCapture: () => controller.abort(false), onDispose: transport => { disposeSignal = transport.signal; throw new Error('cleanup failed'); } });
  assert.equal(await rejectedValue(new ChooseFOptionTask(host).singleSelectText('石化古树')), false);
  assert.equal(disposeSignal, null); assert.equal(host.images.size, 0); assert.equal(host.paused, 0); assert.deepEqual(inputs(host), []);
});

test('cancellation after keyDown always releases key and preserves falsy abort reason', async () => {
  const controller = new AbortController(); let releaseSignal;
  const host = fixture({ controller, onInput: (method, args, transport) => {
    if (method === 'keyDown') controller.abort(0);
    if (method === 'keyUp') { releaseSignal = transport.signal; throw new Error('release failed'); }
  } });
  assert.equal(await rejectedValue(new ChooseFOptionTask(host).singleSelectText('石化古树')), 0);
  assert.equal(releaseSignal, null); assert.equal(host.images.size, 0); assert.equal(host.paused, 0);
  assert.deepEqual(inputs(host).map(call => call.method), ['keyDown', 'keyUp']);
});

test('original operation error wins over secondary image disposal failure', async () => {
  const primary = new Error('OCR failed'), host = fixture({ onVision: op => { if (op === 'realtime.pickText') throw primary; }, onDispose: () => { throw new Error('dispose failed'); } });
  assert.equal(await rejectedValue(new ChooseFOptionTask(host).singleSelectText('石化古树')), primary);
  assert.equal(host.paused, 0); assert.equal(host.images.size, 0);
});

test('selection mutex cancels queued work without skipping an active owner', async () => {
  let entered, resume; const active = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const first = fixture({ onSleep: async ms => { if (ms === 100) { entered(); await blocked; } } });
  const controller = new AbortController(), second = fixture({ controller }), third = fixture();
  const a = new ChooseFOptionTask(first).singleSelectText('石化古树'); await active;
  const b = new ChooseFOptionTask(second).singleSelectText('石化古树'); controller.abort(new Error('cancel queued'));
  await assert.rejects(b, /cancel queued/);
  const c = new ChooseFOptionTask(third).singleSelectText('石化古树'); await Promise.resolve();
  assert.equal(third.calls.length, 0); resume(); assert.equal(await a, true); assert.equal(await c, true);
  assert.equal(second.calls.length, 0); assert.equal(first.paused + second.paused + third.paused, 0);
});

test('dispatcher AutoPick pause leases compose and dispose idempotently', async () => {
  const host = fixture({ current: '甜甜花' });
  const dispatcher = new RealtimeDispatcher(host); dispatcher.addTrigger({ name: 'AutoPick', config: { ForceInteraction: true } });
  const first = dispatcher.pauseAutoPick(), second = dispatcher.pauseAutoPick();
  assert.equal((await dispatcher.tick()).reason, 'notDue'); first.dispose(); first.dispose();
  assert.equal((await dispatcher.tick()).reason, 'notDue'); second.dispose();
  assert.deepEqual((await dispatcher.tick()).triggers, ['AutoPick']); assert.deepEqual(inputs(host).map(call => call.method), ['keyPress']);
  await dispatcher.close(); assert.equal(host.images.size, 0);
});

test('configured key lookup uses original Recognition F object', async () => {
  const host = fixture(), frame = await host.capture();
  const value = await findPickInteraction(host, frame, 'VK_F');
  assert.equal(value.key, 'F'); assert.deepEqual(value.region, pick); await host.vision('image.dispose', { handle: frame.handle });
});
