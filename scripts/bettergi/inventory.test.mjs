import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { InventoryTasks, InventoryTaskError, inventoryParameters } from './inventory.mjs';
import { createTaskParamTypes, GridScreenName } from './task-params.mjs';
import { VisionProcess } from './host.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (x = 100, y = 200, width = 20, height = 20) => ({ x, y, width, height, globalX: x, globalY: y });
const pages = Object.keys(GridScreenName).slice(0, 9);
const tabNames = ['BagWeapon', 'BagArtifact', 'BagCharacterDevelopmentItem', 'BagFood', 'BagMaterial', 'BagGadget', 'BagQuest', 'BagPreciousItem', 'BagFurnishing'];
const entries = [
  { name: '苹果', page: 'Food', sortOrder: 1 }, { name: '日落果', page: 'Food', sortOrder: 2 },
  { name: '甜甜花', page: 'Materials', sortOrder: 108 }, { name: '精锻用魔矿', page: 'Weapons', sortOrder: null },
];
const cell = (name, index = 0, isPhantom = false) => ({ rect: { x: 120 + index * 140, y: 180, width: 125, height: 153 }, rowNum: 0, colNum: index, isPhantom, name });

function hostFor(options = {}) {
  let clock = 0, sequence = 0;
  const calls = [], inputs = [], images = new Map(), created = new Set(), disposed = new Set(), held = new Set(), definitions = new Map(), scanIndex = new Map();
  const state = { phase: 'main', page: options.initialPage ?? 'Weapons' };
  const host = {
    sourceRoot, signal: options.controller?.signal, calls, inputs, images, created, disposed, held, state,
    now: () => clock,
    log(level, message) { calls.push({ op: 'log', level, message }); },
    async capture() {
      this.signal?.throwIfAborted();
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080, ...state };
      images.set(frame.handle, frame); created.add(frame.handle); await options.onCapture?.(frame, host); return frame;
    },
    async sleep(ms) { this.signal?.throwIfAborted(); clock += ms; calls.push({ op: 'sleep', ms, at: clock }); await options.onSleep?.(ms, host); },
    async input(method, args = []) {
      this.signal?.throwIfAborted(); inputs.push({ method, args, at: clock, signal: this.signal });
      if (method.endsWith('Down')) held.add(method);
      if (method.endsWith('Up')) held.delete(method.replace(/Up$/, 'Down'));
      if (method === 'releaseAll') held.clear();
      if (method === 'keyPress' && args[0] === (options.inventoryKey ?? 'VK_B')) state.phase = state.phase === 'main' ? 'bag' : state.phase === 'bag' ? 'main' : 'bag';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') state.phase = 'main';
      if (method === 'click') {
        const index = tabNames.findIndex((_, i) => args[0] === 210 + i * 40 && args[1] === 110);
        if (index >= 0) { state.phase = 'bag'; state.page = pages[index]; }
        if (args[0] === 910 && args[1] === 310) state.phase = 'bag';
      }
      await options.onInput?.(method, args, host);
    },
    async vision(op, args) {
      this.signal?.throwIfAborted(); calls.push({ op, args, at: clock, signal: this.signal });
      if (op === 'image.dispose') { assert.ok(images.has(args.handle), 'owned image ' + args.handle); assert.ok(!disposed.has(args.handle)); images.delete(args.handle); disposed.add(args.handle); await options.onDispose?.(args.handle, host); return; }
      const override = await options.observe?.(op, args, host);
      if (override !== undefined) return override;
      if (op === 'inventory.metadata') return { entries: options.entries ?? entries, missing: [], entryCount: (options.entries ?? entries).length };
      if (op === 'inventory.modelStatus') return { mode: args.mode, prototypes: 3617 };
      if (op === 'inventory.release') return { released: true };
      if (op === 'inventory.params') return { page: args.page, roi: { x: 106, y: 110, width: 1171, height: 845 }, columns: 8, s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 };
      if (op === 'inventory.scrolling') { assert.ok(images.has(args.previousHandle)); assert.ok(images.has(args.nextHandle)); return { isScrolling: false, response: 1, shift: { x: 0, y: 0 } }; }
      if (op === 'recognition.load') {
        if (!definitions.has(args.path)) definitions.set(args.path, JSON.parse(await readFile(args.path, 'utf8')));
        const recognition = definitions.get(args.path).objects[args.objectName]; assert.ok(recognition, args.objectName);
        if (recognition.template) assert.ok((await readFile(path.join(path.dirname(args.path), '1920x1080', recognition.template))).length);
        return { ...recognition, name: args.objectName };
      }
      const frame = images.get(args.handle); assert.ok(frame, 'live handle for ' + op);
      if (op === 'image.find') {
        const name = args.recognition.name, custom = await options.recognize?.(name, frame, args, host);
        if (custom !== undefined) return custom;
        if (name === 'PaimonMenu') return frame.phase === 'main' ? region() : empty;
        if (name === 'PromptDialogLeftBottomStar') return frame.phase === 'prompt' ? region() : empty;
        if (name === 'BtnWhiteConfirm') return frame.phase === 'prompt' ? region(900, 300) : empty;
        const index = tabNames.findIndex(tab => name === tab + 'Checked' || name === tab + 'Unchecked');
        if (index >= 0 && frame.phase === 'bag') return (name.endsWith('Unchecked') ? frame.page !== pages[index] : frame.page === pages[index]) ? region(200 + index * 40, 100) : empty;
        return empty;
      }
      if (op === 'image.ocr') return [];
      if (op === 'inventory.grid') {
        if (args.postProcess === false) return { roi: { x: 106, y: 110, width: 1171, height: 845 }, rawRects: [{ x: 120, y: 120, width: 125, height: 153 }], cells: [] };
        const index = scanIndex.get(args.page) ?? 0; scanIndex.set(args.page, index + 1);
        frame.cells = options.grids?.[args.page]?.[index] ?? [];
        return { roi: { x: 106, y: 110, width: 1171, height: 845 }, rawRects: frame.cells.map(value => value.rect), cells: frame.cells };
      }
      if (op === 'inventory.item') {
        const item = frame.cells.find(value => value.rect.x === args.rect.x);
        assert.ok(item); return { name: item.name, candidateName: item.name ?? '未知', score: .9, scoreKind: 'cosine', qualityLevel: -1 };
      }
      if (op === 'inventory.count') {
        const item = frame.cells.find(value => value.rect.x === args.rect.x); assert.ok(item);
        const count = options.counts?.[item.name] ?? 123;
        return { count, rawText: count < 0 ? '' : String(count), reason: count < 0 ? 'PARSE' : null, componentCount: 3, foregroundBounds: region() };
      }
      throw new Error('Unexpected operation ' + op);
    },
  };
  return host;
}
function released(host, mode = 'Item') {
  assert.deepEqual(host.created, host.disposed); assert.equal(host.images.size, 0); assert.equal(host.held.size, 0);
  assert.equal(host.inputs.at(-1)?.method, 'releaseAll'); assert.equal(host.inputs.at(-1)?.signal, null);
  if (mode) { const call = host.calls.findLast(call => call.op === 'inventory.release'); assert.deepEqual(call.args, { mode }); assert.equal(call.signal, null); }
}

test('CountInventoryItemParam constructor, numeric enums, Chinese pages and case-insensitive config are source-compatible', () => {
  const { CountInventoryItemParam } = createTaskParamTypes({ getConfig: () => ({ OtherConfig: { ItemIconRecognitionMode: 0 } }) });
  const param = new CountInventoryItemParam(); param.ItemNames.push('苹果', '苹果', '日落果'); param.GridScreenName = GridScreenName.Food;
  assert.deepEqual(inventoryParameters(param), { itemNames: ['苹果', '日落果'], page: 'Food', stopByItemSort: false, mode: 'GridIcon' });
  assert.deepEqual(inventoryParameters({ itemnames: [' 苹果 '], gridscreenname: '食物', stopbyitemsort: true }, { otherconfig: { itemiconrecognitionmode: 'gridicon' } }), { itemNames: [' 苹果 '], page: 'Food', stopByItemSort: true, mode: 'GridIcon' });
});

test('invalid parameters and unresolved metadata fail before game input and release safely', async () => {
  for (const param of [null, {}, { ItemNames: [] }, { ItemNames: [' '] }, { ItemNames: [2] }, { ItemNames: ['苹果'], GridScreenName: 11 }, { ItemNames: ['苹果'], IconRecognitionMode: 2 }, { ItemNames: ['苹果'], StopByItemSort: 1 }]) assert.throws(() => inventoryParameters(param));
  const host = hostFor();
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['不存在'] }), error => error instanceof InventoryTaskError && error.code === 'unresolvedPage');
  assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); assert.equal(host.created.size, 0); released(host);
});

test('automatic page batches sort by original enum, deduplicate names and OCR only first observed target', async () => {
  const host = hostFor({ grids: { Food: [[cell(null), cell('日落果', 1), cell('苹果', 2), cell('苹果', 3)]], Materials: [[cell('甜甜花')]] }, counts: { 苹果: 1850, 日落果: 1234, 甜甜花: 7 } });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['甜甜花', '苹果', '日落果', '苹果'] });
  assert.deepEqual(result.counts, { 日落果: 1234, 苹果: 1850, 甜甜花: 7 }); assert.deepEqual(result.missing, []);
  assert.deepEqual(result.pages.map(value => value.page), ['Food', 'Materials']); assert.ok(result.pages.every(value => value.stopReason === 'allTargetsObserved'));
  assert.equal(result.observations.length, 3); assert.equal(host.calls.filter(call => call.op === 'inventory.count').length, 3);
  assert.equal(result.verified, true); assert.equal(result.mainUiVerified, true); assert.equal(host.state.phase, 'main'); released(host);
});

test('public task returns plain source dictionary, retains OCR -2 and omits missing names', async () => {
  const host = hostFor({ grids: { Food: [[cell('苹果')]] }, counts: { 苹果: -2 } });
  const result = await new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果', '日落果'] });
  assert.equal(Object.getPrototypeOf(result), Object.prototype); assert.deepEqual(result, { 苹果: -2 }); assert.equal(Object.hasOwn(result, '日落果'), false); released(host);
  const detailHost = hostFor({ grids: { Food: [[cell('苹果')]] }, counts: { 苹果: -2 } });
  const detail = await new InventoryTasks(detailHost).countInventoryItemDetailed({ ItemNames: ['苹果', '日落果'] });
  assert.equal(detail.verified, false); assert.deepEqual(detail.missing, ['日落果']); assert.equal(detail.pages[0].stopReason, 'bottom'); released(detailHost);
});

test('explicit page permits missing metadata; empty grid reports noGrid without invented zero', async () => {
  const host = hostFor({ entries: [] });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['本页未知物品'], GridScreenName: 'Food', StopByItemSort: true });
  assert.deepEqual(result.counts, {}); assert.deepEqual(result.missing, ['本页未知物品']); assert.equal(result.pages[0].stopReason, 'noGrid');
  assert.equal(host.calls.filter(call => call.op === 'inventory.scrolling').length, 0); assert.equal(host.calls.filter(call => call.op === 'log').length, 1); released(host);
});

test('sort-order early exit stops before count and missing metadata disables early exit', async () => {
  const host = hostFor({ grids: { Food: [[cell('日落果'), cell('苹果', 1)]] } });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['苹果'], StopByItemSort: true });
  assert.equal(result.pages[0].stopReason, 'sortOrder'); assert.deepEqual(result.missing, ['苹果']); assert.equal(host.calls.filter(call => call.op === 'inventory.count').length, 0); released(host);
  const noOrder = hostFor({ entries: entries.map(value => value.name === '苹果' ? { ...value, sortOrder: null } : value), grids: { Food: [[cell('日落果'), cell('苹果', 1)]] } });
  const complete = await new InventoryTasks(noOrder).countInventoryItemDetailed({ ItemNames: ['苹果'], StopByItemSort: true });
  assert.equal(complete.counts.苹果, 123); assert.equal(complete.pages[0].stopReason, 'allTargetsObserved'); released(noOrder);
});

test('original selected-tab recognition, custom inventory key and icon mode are passed through', async () => {
  const host = hostFor({ initialPage: 'Food', inventoryKey: 'VK_I', grids: { Food: [[cell('苹果', 0, true)]] } });
  const task = new InventoryTasks(host, { keybindingsconfig: { openinventory: 'VK_I' }, OtherConfig: { ItemIconRecognitionMode: 0 } });
  const result = await task.countInventoryItemDetailed({ ItemNames: ['苹果'] });
  assert.equal(result.observations[0].isPhantom, true); assert.equal(host.inputs.filter(call => call.method === 'click').length, 0);
  assert.deepEqual(host.inputs.filter(call => call.method === 'keyPress').map(call => call.args[0]), ['VK_I', 'VK_ESCAPE']);
  assert.equal(host.calls.find(call => call.op === 'inventory.item').args.mode, 'GridIcon'); released(host, 'GridIcon');
});

test('inventory reopening and prompt confirmation use original top80percent ROI', async () => {
  let presses = 0;
  const host = hostFor({ grids: { Food: [[cell('苹果')]] }, onInput(method, args, h) {
    if (method === 'keyPress' && args[0] === 'VK_B') { presses++; h.state.phase = presses === 1 ? 'main' : 'prompt'; }
  } });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['苹果'] });
  assert.equal(result.verified, true); assert.equal(presses, 2);
  const confirm = host.calls.find(call => call.op === 'image.find' && call.args.recognition.name === 'BtnWhiteConfirm');
  assert.deepEqual(confirm.args.recognition.roi, [0, 0, 1920, 864]); released(host);
});

test('opening fails honestly after five attempts if no inventory button is recognized', async () => {
  const host = hostFor({ onInput(method, args, h) { if (method === 'keyPress' && args[0] === 'VK_B') h.state.phase = 'unknown'; } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), error => error.code === 'inventoryNotOpened');
  assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 1000).length, 5); released(host);
});

test('unchecked click never counts as selected-tab evidence', async () => {
  const host = hostFor({ recognize(name) { if (name === 'BagFoodChecked') return empty; } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), error => error.code === 'tabUnverified');
  assert.equal(host.calls.filter(call => call.op === 'inventory.grid').length, 0); assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 500).length, 5); released(host);
});

test('switch waits through source retries and verifies selected state before scanning', async () => {
  let tries = 0;
  const host = hostFor({ grids: { Food: [[cell('苹果')]], Materials: [[cell('甜甜花')]] }, recognize(name) {
    if (name === 'BagMaterialUnchecked' && ++tries < 3) return empty;
  } });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['甜甜花', '苹果'] });
  assert.equal(result.verified, true); assert.equal(tries, 3); assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 300).length, 2); released(host);
});

test('switch fails after five missing-tab retries without scanning the wrong page', async () => {
  const host = hostFor({ grids: { Food: [[cell('苹果')]] }, recognize(name) { if (name === 'BagMaterialUnchecked') return empty; } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果', '甜甜花'] }), error => error.code === 'tabNotFound');
  assert.equal(host.calls.filter(call => call.op === 'inventory.grid' && call.args.page === 'Materials').length, 0);
  assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 300).length, 5); released(host);
});

test('scroll uses source wheel rounds, phase gate and raw-grid fine alignment', async () => {
  let fine = 0;
  const host = hostFor({ observe(op, args) {
    if (op === 'inventory.scrolling') return { isScrolling: true };
    if (op === 'inventory.grid') return { roi: { x: 106, y: 110, width: 1171, height: 845 }, rawRects: [{ x: 120, y: ++fine === 1 ? 200 : 130, width: 125, height: 153 }], cells: [] };
  } });
  const result = await new InventoryTasks(host).scroll('Food', { s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 });
  assert.equal(result, true); assert.equal(host.inputs.filter(call => call.method === 'verticalScroll' && call.args[0] === -2).length, 35);
  assert.equal(host.inputs.filter(call => call.method === 'verticalScroll' && call.args[0] === -1).length, 1);
  assert.deepEqual(host.inputs.at(-1).args, [1277, 955]); assert.deepEqual(host.created, host.disposed);
  assert.equal(host.calls.filter(call => call.op === 'inventory.grid').every(call => call.args.postProcess === false), true);
  assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 40).length, 35);
});

test('stationary scroll stops after initial three rounds and disposes both captures', async () => {
  const host = hostFor();
  assert.equal(await new InventoryTasks(host).scroll('Food', { s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 }), false);
  assert.equal(host.inputs.length, 3); assert.equal(host.created.size, 2); assert.deepEqual(host.created, host.disposed); assert.equal(host.now(), 720);
});

test('scroll with no contours exits fine-alignment deadline without endless polling', async () => {
  const host = hostFor({ observe(op) {
    if (op === 'inventory.scrolling') return { isScrolling: true };
    if (op === 'inventory.grid') return { roi: { x: 10, y: 20, width: 100, height: 100 }, rawRects: [], cells: [] };
  } });
  assert.equal(await new InventoryTasks(host).scroll('Food', { s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 }), true);
  assert.ok(host.now() >= 4000 && host.now() < 4100); assert.equal(host.inputs.filter(call => call.method === 'verticalScroll').length, 35); assert.deepEqual(host.created, host.disposed);
});

test('source ore fast-scroll holds2s at scaled1080point then scans final inventory page', async () => {
  const host = hostFor({ width: 1280, height: 720, grids: { Weapons: [[cell('精锻用魔矿')]] }, counts: { 精锻用魔矿: 1850 } });
  const result = await new InventoryTasks(host).countInventoryItemDetailed({ ItemNames: ['精锻用魔矿'] });
  assert.equal(result.counts.精锻用魔矿, 1850);
  const down = host.inputs.find(call => call.method === 'leftButtonDown'), up = host.inputs.find(call => call.method === 'leftButtonUp');
  assert.equal(up.at - down.at, 2000); assert.equal(up.signal, null);
  assert.deepEqual(host.inputs.find(call => call.method === 'moveMouseTo').args, [1289 * (2 / 3), 624]); released(host);
});

test('cancel immediately after ore button-down still sends uncancelled button-up and releaseAll', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, onInput(method) { if (method === 'leftButtonDown') controller.abort(new Error('cancel hold')); } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['精锻用魔矿'] }), /cancel hold/);
  const up = host.inputs.find(call => call.method === 'leftButtonUp'); assert.ok(up); assert.equal(up.signal, null); released(host);
});

test('cancel during scrolling disposes both captures even when regular vision rejects aborted signal', async () => {
  const controller = new AbortController(); let captures = 0;
  const host = hostFor({ controller, onCapture() { if (++captures === 2) controller.abort(new Error('cancel scroll')); } });
  await assert.rejects(new InventoryTasks(host).scroll('Food', { s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 }), /cancel scroll/);
  assert.equal(host.created.size, 2); assert.deepEqual(host.created, host.disposed); assert.ok(host.calls.filter(call => call.op === 'image.dispose').every(call => call.signal === null));
});

test('icon/count errors dispose current frame and model, preserving original failure across cleanup errors', async () => {
  for (const failedOp of ['inventory.item', 'inventory.count']) {
    const host = hostFor({ grids: { Food: [[cell('苹果')]] }, observe(op) {
      if (op === failedOp) throw new Error('observed failure');
      if (op === 'inventory.release') throw new Error('cleanup failure');
    } });
    await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), /observed failure/); released(host);
    assert.ok(host.calls.some(call => call.op === 'log' && call.level === 'error' && call.message.includes('cleanup failure')));
  }
});

test('model failure occurs before game input, releases model and all input state', async () => {
  const host = hostFor({ observe(op) { if (op === 'inventory.modelStatus') throw new Error('model load failure'); } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), /model load failure/);
  assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); assert.equal(host.created.size, 0); released(host);
});

test('invalid count observations reject instead of claiming observed inventory', async () => {
  for (const count of [-3, -1, 1.5, null, 2147483648]) {
    const host = hostFor({ grids: { Food: [[cell('苹果')]] }, observe(op) { if (op === 'inventory.count') return { count }; } });
    await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), error => error.code === 'invalidCountObservation'); released(host);
  }
});

test('successful task still surfaces cleanup failure', async () => {
  const host = hostFor({ grids: { Food: [[cell('苹果')]] }, onInput(method) { if (method === 'releaseAll') throw new Error('release failure'); } });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), /release failure/); released(host);
});

test('VisionProcess inventory dispatch uses original metadata, real grid, count preprocessing and session release', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bgi-inventory-'));
  const width = 350, height = 360, pixels = Buffer.alloc(width * height * 3);
  for (const y0 of [20, 140]) for (const x0 of [20, 130, 240]) for (let y = y0; y < y0 + 100; y++) for (let x = x0; x < x0 + 81; x++) pixels.set([233, 229, 220], (y * width + x) * 3);
  const filename = path.join(directory, 'grid.ppm'), header = ['P6', width + ' ' + height, '255', ''].join(String.fromCharCode(10));
  await writeFile(filename, Buffer.concat([Buffer.from(header), pixels]));
  const service = new VisionProcess(); let frame;
  try {
    const metadata = await service.call('inventory.metadata', { names: ['苹果', '不存在'] });
    assert.equal(metadata.entryCount, 2577); assert.deepEqual(metadata.missing, ['不存在']); assert.equal(metadata.entries[0].page, 'Food');
    frame = await service.call('image.load', { path: filename, type: 'ImageRegion' });
    const grid = await service.call('inventory.grid', { handle: frame.handle, page: 'Food', roi: [0, 0, width, height], columns: 3 });
    assert.equal(grid.cells.length, 6); assert.ok(grid.cells.every(value => !value.isPhantom));
    assert.equal((await service.call('inventory.count', { handle: frame.handle, rect: grid.cells[0].rect })).count, -2);
    for (const [mode, prototypes] of [['Item', 3617], ['GridIcon', 918]]) {
      assert.equal((await service.call('inventory.modelStatus', { mode })).prototypes, prototypes);
      const item = await service.call('inventory.item', { handle: frame.handle, rect: grid.cells[0].rect, mode });
      assert.ok(Number.isFinite(item.score)); assert.equal(typeof item.candidateName, 'string');
      assert.deepEqual(await service.call('inventory.release', { mode }), { released: true });
    }
    assert.equal((await service.call('vision.status')).imageHandles, 1);
    await service.call('image.dispose', { handle: frame.handle }); frame = null;
    assert.equal((await service.call('vision.status')).imageHandles, 0);
  } finally {
    if (frame) await service.call('image.dispose', { handle: frame.handle });
    await service.close(); await rm(directory, { recursive: true, force: true });
  }
});


test('image cleanup attempts every owned scroll frame and preserves original vision error', async () => {
  let attempts = 0;
  const host = hostFor({
    observe(op) { if (op === 'inventory.scrolling') throw new Error('phase failure'); },
    onDispose() { if (++attempts === 1) throw new Error('dispose failure'); },
  });
  await assert.rejects(new InventoryTasks(host).scroll('Food', { s1Round: 3, roundMilliseconds: 40, s2Round: 32, s3Scale: .024 }), /phase failure/);
  assert.equal(attempts, 2); assert.deepEqual(host.created, host.disposed);
});

test('captured icon error is preserved if disposal also fails', async () => {
  const host = hostFor({
    grids: { Food: [[cell('苹果')]] },
    observe(op) { if (op === 'inventory.item') throw new Error('icon failure'); },
    onDispose(handle, h) { if (h.calls.some(call => call.op === 'inventory.item' && call.args.handle === handle)) throw new Error('dispose failure'); },
  });
  await assert.rejects(new InventoryTasks(host).countInventoryItem({ ItemNames: ['苹果'] }), /icon failure/); released(host);
});
