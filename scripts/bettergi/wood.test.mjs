import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AutoWoodConfig, AutoWoodTask, WoodStatisticsPrinter, WoodTaskParam, WoodTaskError, woodParameters, runAutoWood } from './wood.mjs';
import { PathingActions } from './actions.mjs';
import { VisionProcess } from './host.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (x = 1000, y = 500, width = 20, height = 20) => ({ x, y, width, height, globalX: x, globalY: y });
const optionsFor = (rounds = 2, maximum = 2000, config = {}) => ({ taskConfig: { WoodRoundNum: rounds, WoodDailyMaxCount: maximum }, config });
const lines = text => text ? text.split('\n').map((text, index) => ({ text, x: 100, y: 450 + index * 30, width: 150, height: 25 })) : [];

function hostFor(options = {}) {
  let clock = 0, sequence = 0, ocrIndex = 0, gadgetIndex = 0;
  const calls = [], inputs = [], images = new Map(), created = new Set(), disposed = new Set(), definitions = new Map();
  const state = { phase: 'main' };
  const host = {
    sourceRoot, signal: options.controller?.signal, calls, inputs, images, created, disposed, state, now: () => clock,
    log(level, message) { calls.push({ op: 'log', level, message }); },
    async capture() {
      this.signal?.throwIfAborted();
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080, ...state };
      images.set(frame.handle, frame); created.add(frame.handle); calls.push({ op: 'capture', frame, signal: this.signal });
      await options.onCapture?.(frame, host); this.signal?.throwIfAborted(); return frame;
    },
    async sleep(ms) { this.signal?.throwIfAborted(); clock += ms; calls.push({ op: 'sleep', ms }); await options.onSleep?.(ms, host); },
    async input(method, args = []) {
      this.signal?.throwIfAborted(); inputs.push({ method, args, at: clock, signal: this.signal });
      const scale = Math.min((options.width ?? 1920) / 1920, (options.height ?? 1080) / 1080);
      if (method === 'keyPress' && args[0] === 'VK_F6') state.phase = 'wonderlandList';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') state.phase = state.phase === 'mainWonderland' ? 'wonderlandMenu' : 'bag';
      if (method === 'click') {
        if (state.phase === 'wonderlandList' && args[0] === 680 * scale && args[1] === 310 * scale) state.phase = 'enterConfirm';
        else if (state.phase === 'wonderlandMenu' && args[0] === 1610 && args[1] === 910) state.phase = 'exitWonderlandConfirm';
        else if (state.phase === 'enterConfirm' && args[0] === 1010 && args[1] === 510) state.phase = 'mainWonderland';
        else if (state.phase === 'exitWonderlandConfirm' && args[0] === 1010 && args[1] === 510) state.phase = 'main';
        else if (state.phase === 'bag' && args[0] === 50 * scale && args[1] === (options.height ?? 1080) - 50 * scale) state.phase = 'exitConfirm';
        else if (state.phase === 'exitConfirm' && args[0] === 1010 && args[1] === 510) state.phase = 'welcome';
        else if (state.phase === 'welcome' && args[0] === 955 * scale && args[1] === 666 * scale) state.phase = 'main';
      }
      await options.onInput?.(method, args, host);
    },
    async vision(op, args) {
      this.signal?.throwIfAborted(); calls.push({ op, args, at: clock, signal: this.signal });
      if (op === 'image.dispose') {
        assert.ok(images.has(args.handle), 'owned capture'); assert.ok(!disposed.has(args.handle));
        images.delete(args.handle); disposed.add(args.handle); await options.onDispose?.(args.handle, host); return;
      }
      if (op === 'recognition.load') {
        if (!definitions.has(args.path)) definitions.set(args.path, JSON.parse(await readFile(args.path, 'utf8')));
        const definition = definitions.get(args.path).objects[args.objectName]; assert.ok(definition, args.objectName);
        if (definition.template) assert.ok((await readFile(path.join(path.dirname(args.path), '1920x1080', definition.template))).length);
        return { ...definition, name: args.objectName };
      }
      const frame = images.get(args.handle); assert.ok(frame, 'live capture for ' + op);
      if (op === 'image.find') {
        const name = args.recognition.name;
        const custom = await options.recognize?.(name, frame, args, host);
        if (custom !== undefined) return custom;
        if (name === 'TheBoonOfTheElderTree') return (options.gadgets?.[gadgetIndex++] ?? true) ? region() : empty;
        if (name === 'WonderlandClose') return frame.phase === 'wonderlandList' ? region() : empty;
        if (name === 'BtnBlackConfirm') return ['enterConfirm', 'exitWonderlandConfirm'].includes(frame.phase) ? region() : empty;
        if (name === 'BtnBackTeyvat') return frame.phase === 'wonderlandMenu' ? region(1600, 900) : empty;
        if (name === 'PaimonMenu') return ['main', 'mainWonderland'].includes(frame.phase) && !options.missingMainUi ? region() : empty;
        if (name === 'MenuBag') return frame.phase === 'bag' ? region() : empty;
        if (name === 'Confirm') return frame.phase === 'exitConfirm' ? region() : empty;
        if (name === 'EnterGame') return frame.phase === 'welcome' ? region() : empty;
        throw new Error('Unexpected original template ' + name);
      }
      if (op === 'image.ocr') {
        const value = options.ocr?.[ocrIndex++] ?? '';
        await options.onOcr?.(args, host);
        return typeof value === 'string' ? lines(value) : value;
      }
      throw new Error('Unexpected operation ' + op);
    },
  };
  return host;
}
function released(host) {
  assert.deepEqual(host.created, host.disposed); assert.equal(host.images.size, 0);
  assert.equal(host.inputs.at(-1)?.method, 'releaseAll'); assert.equal(host.inputs.at(-1)?.signal, null);
  assert.ok(host.calls.filter(call => call.op === 'image.dispose').every(call => call.signal === null));
}

test('WoodTaskParam preserves original zero, cap, negative and Int32 semantics', () => {
  assert.deepEqual({ ...new WoodTaskParam() }, { WoodRoundNum: 9999, WoodDailyMaxCount: 2000 });
  assert.deepEqual({ ...woodParameters({ woodroundnum: '3', wooddailymaxcount: '0' }) }, { WoodRoundNum: 3, WoodDailyMaxCount: 9999 });
  for (const cap of [9999, 10000, 2147483647]) assert.equal(new WoodTaskParam(-1, cap).WoodDailyMaxCount, 9999);
  assert.deepEqual({ ...new WoodTaskParam(-2, -30) }, { WoodRoundNum: -2, WoodDailyMaxCount: -30 });
  for (const value of [true, null, '', '1.1', '1e2', 1.5, Infinity, 2147483648, -2147483649]) assert.throws(() => new WoodTaskParam(value, 3));
  for (const value of [null, [], '1']) assert.throws(() => woodParameters(value));
});

test('AutoWoodConfig and constructor support original globals, defaults and gadget keybindings', () => {
  assert.deepEqual({ ...new AutoWoodConfig() }, { AfterZSleepDelay: 0, WoodCountOcrEnabled: false, UseWonderlandRefresh: true });
  const task = new AutoWoodTask(hostFor(), { config: { autowoodconfig: { afterzsleepdelay: -10 }, keybindingsconfig: { quickusegadget: 'KeyT' } } });
  assert.ok(task instanceof PathingActions); assert.equal(task.gadgetKey, 'KeyT');
  for (const config of [{ WoodCountOcrEnabled: 1 }, { UseWonderlandRefresh: 'true' }, { AfterZSleepDelay: 1.5 }]) assert.throws(() => new AutoWoodConfig(config));
  assert.throws(() => new AutoWoodTask(hostFor(), { config: { KeyBindingsConfig: { QuickUseGadget: 'invalid' } } }), /virtual key/);
  assert.throws(() => new AutoWoodTask(hostFor(), { login3rdParty: 'other' }));
});

test('single final round presses configured gadget, preserves delays and intentionally skips OCR/refresh', async () => {
  const host = hostFor();
  const result = await runAutoWood(host, optionsFor(1, 30, { AutoWoodConfig: { WoodCountOcrEnabled: true, AfterZSleepDelay: 250 }, KeyBindingsConfig: { QuickUseGadget: 'VK_T' } }));
  assert.equal(result.completed, true); assert.equal(result.verified, false); assert.equal(result.inventoryVerified, false); assert.equal(result.completion, 'roundLimit');
  assert.equal(result.gadgetPresses, 1); assert.equal(result.ocrFrames, 0); assert.deepEqual(result.woodCountEstimates, {}); assert.deepEqual(result.refreshes, []);
  assert.equal(result.rounds[0].lastRoundSkippedOcrAndRefresh, true);
  assert.deepEqual(host.inputs.map(call => [call.method, call.args]), [['keyPress', ['VK_T']], ['releaseAll', []]]);
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').map(call => call.ms), [300, 250, 500]); released(host);
});

test('missing initial gadget fails before action and exposes partial evidence', async () => {
  const host = hostFor({ gadgets: [false] });
  await assert.rejects(runAutoWood(host, optionsFor(2)), error => error instanceof WoodTaskError && error.code === 'missingGadget' && error.evidence.gadgetPresses === 0 && error.evidence.completed === false);
  assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); released(host);
});

test('subsequent gadget polls original120 limit with correct successful-retry delays', async () => {
  const host = hostFor({ gadgets: [true, false, false, true] });
  const task = new AutoWoodTask(host, optionsFor());
  assert.equal(await task.pressZ(), 1); assert.equal(await task.pressZ(), 3);
  assert.equal(task.gadgetPresses, 2);
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').map(call => call.ms), [300, 1, 1000, 1, 1000, 1, 500, 300]);
  assert.deepEqual(host.created, host.disposed);
});

test('subsequent gadget exhaustion never emits an extra press', async () => {
  const host = hostFor({ gadgets: [true, ...Array(120).fill(false)] });
  const task = new AutoWoodTask(host, optionsFor()); await task.pressZ();
  await assert.rejects(task.pressZ(), error => error.code === 'gadgetRetryExhausted');
  assert.equal(task.gadgetPresses, 1); assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 1).length, 120);
  assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 1000).length, 119); assert.deepEqual(host.created, host.disposed);
});

test('two rounds execute inherited Wonderland cycle and confirm both main UI transitions', async () => {
  const host = hostFor(), result = await runAutoWood(host, optionsFor(2));
  assert.equal(result.roundsAttempted, 2); assert.equal(result.gadgetPresses, 2);
  assert.deepEqual(result.refreshes, [{ round: 1, method: 'wonderland', verified: true, completion: 'mainUiAfterWonderlandCycle' }]);
  assert.equal(host.calls.filter(call => call.op === 'image.find' && call.args.recognition.name === 'PaimonMenu').length, 2);
  assert.ok(host.inputs.some(call => call.args[0] === 'VK_F6')); assert.equal(host.state.phase, 'main'); released(host);
});

test('relogin branch executes inherited MenuBag/Confirm/EnterGame/main UI flow', async () => {
  const host = hostFor({ width: 1280, height: 720 });
  const result = await runAutoWood(host, optionsFor(2, 2000, { UseWonderlandRefresh: false, AfterZSleepDelay: -50 }));
  assert.deepEqual(result.refreshes, [{ round: 1, method: 'exitAndRelogin', verified: true, completion: 'mainUiAfterRelogin' }]);
  assert.ok(host.inputs.some(call => call.method === 'click' && call.args[0] === 955 * 2 / 3 && call.args[1] === 444));
  assert.ok(host.calls.filter(call => call.op === 'sleep').every(call => call.ms >= 0)); assert.equal(host.state.phase, 'main'); released(host);
});

test('unobserved main UI fails inherited refresh instead of returning completion', async () => {
  const host = hostFor({ missingMainUi: true });
  await assert.rejects(runAutoWood(host, optionsFor(2)), error => error.code === 'elementAbsent' && error.evidence.completed === false && error.evidence.refreshes.length === 0);
  assert.equal(host.calls.filter(call => call.op === 'image.find' && call.args.recognition.name === 'PaimonMenu').length, 120); released(host);
});

test('Bilibili desktop login is explicitly unsupported before any game input', async () => {
  const host = hostFor();
  await assert.rejects(runAutoWood(host, { ...optionsFor(2), login3rdParty: 'Bilibili' }), error => error.operation === 'login3rdParty.Bilibili');
  assert.equal(host.created.size, 0); assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); released(host);
});

test('first OCR selects only longest valid original wood-name candidates and stable ties', () => {
  const good = '获得\n竹节×30', bad = '获得\n不认识的长木材×30';
  assert.equal(WoodStatisticsPrinter.findBestOcrResult([good, bad]), '');
  assert.equal(WoodStatisticsPrinter.findBestOcrResult(['获得\n竹节×30', '获得\n杉木×20']), good);
  assert.equal(WoodStatisticsPrinter.findBestOcrResult(['获得×abc']), '获得×abc');
  assert.equal(WoodStatisticsPrinter.findBestOcrResult([]), '');
});

test('first OCR estimates quantities; later obtained text reuses cached metrics to stop by minimum wood type', async () => {
  const host = hostFor({ ocr: ['获得\n竹节×30', '获得\n竹节×30\n杉木×20', '', '获得\n竹节×9999', '获得'] });
  const result = await runAutoWood(host, optionsFor(8, 50, { WoodCountOcrEnabled: true }));
  assert.equal(result.completion, 'woodLimit'); assert.equal(result.roundsAttempted, 3); assert.equal(result.gadgetPresses, 3);
  assert.deepEqual(result.woodCountEstimates, { 竹节: 90, 杉木: 60 }); assert.equal(result.countEvidence, 'sourceOcrEstimate');
  assert.equal(result.ocrFrames, 5); assert.equal(result.refreshes.length, 2); assert.equal(result.verified, false); released(host);
});

test('three empty later OCR windows stop with source estimates and cache clearing', async () => {
  const host = hostFor({ ocr: ['获得\n竹节×30', ''] });
  const result = await runAutoWood(host, optionsFor(20, 2000, { WoodCountOcrEnabled: true }));
  assert.equal(result.completion, 'emptyWoodLimit'); assert.equal(result.emptyObservations, 3); assert.equal(result.roundsAttempted, 4);
  assert.equal(result.refreshes.length, 3); assert.deepEqual(result.woodCountEstimates, { 竹节: 30 }); released(host);
});

test('initial empty OCR disables the supplied original config and requires explicit restart', async () => {
  const host = hostFor(), config = { AutoWoodConfig: { WoodCountOcrEnabled: true } };
  await assert.rejects(runAutoWood(host, optionsFor(5, 2000, config)), error => error.code === 'firstOcrEmpty' && error.evidence.ocrEnabled === false && error.evidence.configChanges[0].value === false);
  assert.equal(config.AutoWoodConfig.WoodCountOcrEnabled, false); assert.equal(host.calls.filter(call => call.op === 'image.ocr').length, 12); released(host);
});

test('lowercase-x-only source detection/parse inconsistency is retained', async () => {
  const host = hostFor({ ocr: ['获得\n竹节x30', ''] }), task = new AutoWoodTask(host, optionsFor(3, 2000, { WoodCountOcrEnabled: true }));
  assert.equal(task.printer.hasDetectedWoodText('获得\n竹节x30'), true);
  await task.printer.printWoodStatistics();
  assert.equal(task.printer.firstWoodOcr, true); assert.equal(task.printer.WoodTotalDict.size, 0); assert.equal(task.printer.NothingCount, 1);
  assert.ok(host.calls.some(call => call.op === 'log' && call.message.includes('未能正确解析'))); assert.deepEqual(host.created, host.disposed);
});

test('source count parser rejects overflowing quantities and Unicode decimal Int32 parse', () => {
  const task = new AutoWoodTask(hostFor(), optionsFor()), printer = task.printer;
  assert.throws(() => printer.parseWoodStatisticsText(task.taskParam, '获得\n竹节×2147483648'), /Int32/);
  assert.throws(() => printer.parseWoodStatisticsText(task.taskParam, '获得\n竹节×３０'), /Int32/);
  assert.equal(printer.WoodTotalDict.size, 0);
});

test('known wood names and first metrics keep duplicates, ignore unknowns and preserve Int32 addition', async () => {
  const source = await readFile(path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoWood/AutoWoodTask.cs'), 'utf8');
  const names = [...source.match(/ExistWoods\s*=\s*\[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const task = new AutoWoodTask(hostFor(), optionsFor()), printer = task.printer;
  assert.equal(names.length, 25); for (const name of names) printer.updateWoodCount(name, 1);
  assert.deepEqual([...printer.WoodTotalDict.keys()], names);
  printer.updateWoodCount('竹节', 30); printer.updateWoodCount('未知木', 100); assert.equal(printer.WoodTotalDict.get('竹节'), 31);
  assert.equal(printer.woodMetrics.get('竹节'), 1); assert.equal(printer.WoodTotalDict.has('未知木'), false);
  printer.WoodTotalDict.set('竹节', 2147483647); printer.updateWoodCount('竹节', 1); assert.equal(printer.WoodTotalDict.get('竹节'), -2147483648);
});

test('per-round metrics above configured max are skipped on subsequent accumulation', () => {
  const task = new AutoWoodTask(hostFor(), optionsFor(3, 20)), printer = task.printer;
  printer.parseWoodStatisticsText(task.taskParam, '获得\n竹节×30\n杉木×10');
  printer.parseWoodStatisticsText(task.taskParam, '获得\n竹节×1');
  printer.checkAndPrintWoodQuantities(task.taskParam);
  assert.deepEqual(Object.fromEntries(printer.WoodTotalDict), { 竹节: 30, 杉木: 20 }); assert.equal(printer.ReachedWoodMaxCount, true);
});

test('wood OCR uses width-only capped original ROI, crop intersection and center ordering', async () => {
  for (const [width, height, roi] of [[1280, 720, [66, 300, 200, 166]], [3840, 2160, [100, 450, 300, 250]], [1920, 500, [100, 450, 300, 50]]]) {
    const host = hostFor({ width, height, ocr: [[{ text: '第三', x: 60, y: 20, width: 10, height: 10 }, { text: '第二', x: 40, y: 0, width: 10, height: 30 }, { text: '第一', x: 0, y: 10, width: 10, height: 10 }]] });
    const task = new AutoWoodTask(host, optionsFor());
    assert.equal(await task.printer.woodTextAreaOcr(), '第一\n第二\n第三');
    assert.deepEqual(host.calls.find(call => call.op === 'image.ocr').args.recognition.roi, roi); assert.deepEqual(host.created, host.disposed);
  }
  const task = new AutoWoodTask(hostFor({ height: 400 }), optionsFor());
  await assert.rejects(task.printer.woodTextAreaOcr(), error => error.code === 'emptyOcrRegion'); assert.deepEqual(task.host.created, task.host.disposed);
});

test('negative requested round count preserves empty source loop without inputs', async () => {
  const host = hostFor(), result = await runAutoWood(host, optionsFor(-2));
  assert.equal(result.roundsAttempted, 0); assert.equal(result.gadgetPresses, 0); assert.equal(result.completion, 'roundLimit');
  assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); released(host);
});

test('cancellation during capture owns allocation, disposes frame and releases through null signal', async () => {
  const controller = new AbortController(), host = hostFor({ controller, onCapture() { controller.abort(); } });
  await assert.rejects(runAutoWood(host, optionsFor(2)), error => error.name === 'AbortError');
  assert.equal(host.created.size, 1); assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); released(host);
});

test('cancellation after gadget input stops refresh and leaves cleanup available', async () => {
  const controller = new AbortController(), host = hostFor({ controller, onInput(method, args) { if (method === 'keyPress' && args[0] === 'VK_Z') controller.abort(); } });
  await assert.rejects(runAutoWood(host, optionsFor(3)), error => error.name === 'AbortError' && error.evidence.gadgetPresses === 1 && error.evidence.rounds[0].gadgetPressed === true);
  assert.deepEqual(host.inputs.map(call => call.method), ['keyPress', 'releaseAll']); assert.equal(host.state.phase, 'main'); released(host);
});

test('vision failure propagates, and failing disposal/release preserve the original error', async () => {
  const original = new Error('template failure');
  const host = hostFor({ recognize() { throw original; }, onDispose() { throw new Error('dispose failure'); }, onInput(method) { if (method === 'releaseAll') throw new Error('release failure'); } });
  await assert.rejects(runAutoWood(host, optionsFor(2)), error => error === original); released(host);
  assert.equal(host.calls.filter(call => call.op === 'log' && call.level === 'error').length, 2);
});

test('disposal failure alone stops gadget and release failure alone cannot claim successful completion', async () => {
  const disposal = hostFor({ onDispose() { throw new Error('dispose only'); } });
  await assert.rejects(runAutoWood(disposal, optionsFor(1)), /dispose only/); assert.deepEqual(disposal.inputs.map(call => call.method), ['releaseAll']); released(disposal);
  const release = hostFor({ onInput(method) { if (method === 'releaseAll') throw new Error('release only'); } });
  await assert.rejects(runAutoWood(release, optionsFor(1)), error => error.message === 'release only' && error.evidence.completed === false && error.evidence.cleanupFailed === true); released(release);
});

test('real VisionProcess matches original gadget, runs single round and OCRs original font with no leaked handles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bgi-wood-'));
  const fixture = path.join(directory, 'wood.png');
  const python = process.env.BETTERGI_PYTHON ?? path.join(project, 'venv/bin/python');
  const generated = spawnSync(python, ['-c', [
    'import cv2, numpy as np, sys',
    'im = np.random.default_rng(7).integers(0, 40, (1080, 1920, 3), dtype=np.uint8)',
    'template = cv2.imread(sys.argv[1])',
    'h, w = template.shape[:2]',
    'im[700:700+h, 1600:1600+w] = template',
    'assert cv2.imwrite(sys.argv[2], im)',
  ].join('\n'), path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoWood/Assets/1920x1080/TheBoonOfTheElderTree.png'), fixture], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const service = new VisionProcess({ sourceRoot }), inputs = []; let clock = 0;
  const host = { sourceRoot, now: () => clock, sleep: async ms => { clock += ms; }, input: async (method, args) => { inputs.push({ method, args }); },
    capture: () => service.call('image.load', { path: fixture, type: 'ImageRegion' }), vision: (op, args) => service.call(op, args) };
  try {
    const result = await runAutoWood(host, optionsFor(1));
    assert.equal(result.gadgetPresses, 1); assert.equal(result.rounds[0].gadgetAttempts, 1); assert.equal(result.verified, false);
    assert.deepEqual(inputs, [{ method: 'keyPress', args: ['VK_Z'] }, { method: 'releaseAll', args: [] }]);
    assert.equal((await service.call('vision.status')).imageHandles, 0);
    const font = path.join(sourceRoot, 'BetterGenshinImpact/Resources/Fonts/MiSans-Regular.ttf');
    const rendered = spawnSync(python, ['-c', [
      'from PIL import Image, ImageDraw, ImageFont',
      'import sys',
      'image = Image.new("RGB", (1920,1080), (30,30,30))',
      'draw = ImageDraw.Draw(image)',
      'font = ImageFont.truetype(sys.argv[1],36)',
      'draw.text((115,455), "获得", font=font, fill="white")',
      'draw.text((115,510), "竹节×30", font=font, fill="white")',
      'draw.text((115,565), "杉木×20", font=font, fill="white")',
      'image.save(sys.argv[2])',
    ].join('\n'), font, fixture], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    const task = new AutoWoodTask(host, optionsFor(3, 2000, { WoodCountOcrEnabled: true }));
    const observed = await task.printer.woodTextAreaOcr();
    assert.equal(task.printer.hasDetectedWoodText(observed), true, observed);
    task.printer.parseWoodStatisticsText(task.taskParam, observed);
    assert.deepEqual(Object.fromEntries(task.printer.WoodTotalDict), { 竹节: 30, 杉木: 20 });
    assert.equal((await service.call('vision.status')).imageHandles, 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
