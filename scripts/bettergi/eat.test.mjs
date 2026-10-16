import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AutoEatTask, eatParameters } from './eat.mjs';
const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const rect = { x: 100, y: 110, width: 125, height: 153 };
function fixture({ food = '甜甜花酿鸡', text = '１２', confirm = true } = {}) {
  const controller = new AbortController(), images = new Set(), events = []; let sequence = 0, time = 0;
  const host = {
    sourceRoot, signal: controller.signal, now: () => time,
    async capture() { const frame = { handle: ++sequence, width: 1920, height: 1080 }; images.add(frame.handle); return frame; },
    async vision(op, args) {
      events.push([op, args, this.signal]);
      if (op === 'image.dispose') { images.delete(args.handle); return; }
      this.signal?.throwIfAborted();
      if (op === 'inventory.params') return { roi: rect };
      if (op === 'inventory.grid') return { cells: [{ rect }] };
      if (op === 'inventory.item') return { name: food };
      if (op === 'inventory.itemText') return { text };
      if (op === 'party.lowHp') return true;
      return {};
    },
    async input(method, args) { events.push([method, args, this.signal]); this.signal?.throwIfAborted(); },
    async sleep(ms) { time += ms; this.signal?.throwIfAborted(); }, log() {},
  };
  const task = new AutoEatTask(host, { taskConfig: { FoodName: '甜甜花酿鸡' } });
  task.returnMainUi = async () => events.push(['main']); task.openInventory = async page => events.push(['open', page]);
  task.find = async () => confirm ? rect : null; task.scroll = async () => false;
  return { host, task, controller, events, images };
}

test('food effect follows source mutually exclusive and group-only configuration', () => {
  assert.throws(() => eatParameters({}, { FoodName: '鸡', FoodEffectType: 1 }), /不能同时/);
  assert.throws(() => eatParameters({}, { FoodEffectType: 1 }), /调度器配置/);
  assert.throws(() => eatParameters({}, { FoodEffectType: 0 }, {}), /错误/);
  assert.equal(eatParameters({}, { FoodEffectType: 1 }, { AutoEatConfig: { DefaultAtkBoostingDishName: '炸萝卜丸子' } }).FoodName, '炸萝卜丸子');
  assert.equal(eatParameters({}, { FoodEffectType: 2 }, {}).skipped, 'missingConfiguredFood');
});

test('named food reuses grid model, source count text and returns remaining estimate', async () => {
  const f = fixture(); assert.equal(await f.task.start(), 11); assert.equal(f.images.size, 0);
  assert.equal(f.task.lastObservation.confirmObserved, true); assert.equal(f.task.lastObservation.inventoryVerified, false);
  assert.equal(f.events.filter(([op]) => op === 'click').length, 2);
  assert.ok(f.events.some(([op]) => op === 'inventory.release')); assert.equal(f.events.at(-1)[0], 'releaseAll');
});

test('invalid count keeps source -2 sentinel and absent confirm remains unverified', async () => {
  const f = fixture({ text: 'unreadable', confirm: false }); assert.equal(await f.task.start(), -2);
  assert.equal(f.task.lastObservation.confirmObserved, false); assert.equal(f.events.filter(([op]) => op === 'click').length, 1);
});

test('missing food returns source -1 only after bottom observation and main UI return', async () => {
  const f = fixture({ food: '烤肉排' }); assert.equal(await f.task.start(), -1); assert.equal(f.images.size, 0);
  assert.equal(f.events.filter(([op]) => op === 'main').length, 2);
});

test('nutritional bag loop uses source minimum eat interval and propagates cancellation with cleanup', async () => {
  const f = fixture(); f.task.param.FoodName = null; f.task.takeFoodEquipped = async () => true;
  let reads = 0; const original = f.host.vision;
  f.host.vision = async function (op, args) { if (op === 'party.lowHp' && ++reads === 10) f.controller.abort(false); return original.call(this, op, args); };
  let caught = true; try { await f.task.start(); } catch (error) { caught = error; }
  assert.equal(caught, false); assert.equal(f.images.size, 0);
  assert.equal(f.events.filter(([op]) => op === 'keyPress').length, 2);
  assert.equal(f.events.at(-1)[2], null);
});

test('nutritional bag count uses original gray ROI without resin thresholding and releases derivatives', async () => {
  const f = fixture(), original = f.host.vision; let sequence = 100;
  f.host.vision = async function (op, args) {
    if (op === 'image.crop' || op === 'image.mat') { const image = { handle: ++sequence }; f.images.add(image.handle); f.events.push([op, args]); return image; }
    if (op === 'image.ocrWithoutDetector') return { text: ' 12 ' };
    return original.call(this, op, args);
  };
  assert.equal(await f.task.takeFoodEquipped(), true); assert.equal(f.images.size, 0);
  const crop = f.events.find(([op]) => op === 'image.crop')[1];
  assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [1800, 845, 40, 20]);
  assert.deepEqual(f.events.filter(([op]) => op === 'image.mat').map(([, args]) => [args.method, args.args]), [['cvtcolor', ['BGR2GRAY']]]);
});

test('model cancellation preserves falsy reason, disposes images and releases model and input', async () => {
  const f = fixture(), original = f.host.vision;
  f.host.vision = async function (op, args) { if (op === 'inventory.modelStatus') { f.controller.abort(null); throw null; } return original.call(this, op, args); };
  let caught = true; try { await f.task.start(); } catch (error) { caught = error; }
  assert.equal(caught, null); assert.equal(f.images.size, 0); assert.ok(f.events.some(([op, , signal]) => op === 'inventory.release' && signal === null));
});
