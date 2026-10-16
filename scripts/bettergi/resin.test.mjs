import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ResinTasks, buildResinRecords } from './resin.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
function fixture({ onOperation, failure, cleanupFailure } = {}) {
  const controller = new AbortController(), calls = [], handles = new Set(); let sequence = 0;
  const host = {
    signal: controller.signal, sourceRoot,
    async capture() { const frame = { handle: ++sequence, width: 1920, height: 1080 }; handles.add(frame.handle); onOperation?.('capture'); return frame; },
    async vision(op, args) {
      calls.push([op, args, this.signal]);
      if (op === 'image.dispose') { handles.delete(args.handle); if (cleanupFailure !== undefined) throw cleanupFailure; return; }
      this.signal?.throwIfAborted();
      if (op === 'image.crop' || op === 'image.mat') { const image = { handle: ++sequence }; handles.add(image.handle); onOperation?.(op); return image; }
      if (op === 'image.ocrWithoutDetector') { if (failure !== undefined) throw failure; return { text: '5' }; }
      if (op === 'image.find') return { x: 1320, y: 25, width: 20, height: 20 };
      return [];
    },
    async input(method, args) { calls.push([method, args, this.signal]); },
    async sleep(ms) { this.signal?.throwIfAborted(); calls.push(['sleep', ms]); },
    log() {},
  };
  return { host, controller, calls, handles, task: new ResinTasks(host) };
}

test('configured resin preserves source order, excludes nonpositive counts and narrows Stygian types', () => {
  const param = { specifyresinuse: true, condensedresinusecount: 2, OriginalResin40UseCount: 3, OriginalResin20UseCount: 1, OriginalResinUseCount: 4, TransientResinUseCount: -1, FragileResinUseCount: 5 };
  assert.deepEqual(buildResinRecords(param).map(item => item.Name), ['浓缩树脂', '原粹树脂40', '原粹树脂20', '原粹树脂', '脆弱树脂']);
  assert.deepEqual(buildResinRecords(param, { stygian: true }).map(item => item.Name), ['浓缩树脂', '原粹树脂', '脆弱树脂']);
  assert.deepEqual(buildResinRecords({}), []);
  assert.throws(() => buildResinRecords({ SpecifyResinUse: true }), /至少配置/);
  assert.throws(() => buildResinRecords({ SpecifyResinUse: true, CondensedResinUseCount: 1.5 }), /integer/);
});

test('condensed OCR reuses source gray, threshold180 and inverted detectorless pipeline', async () => {
  const f = fixture(); assert.equal(await f.task.count({ handle: 99 }, { x: 2, y: 3, width: 20, height: 15 }, true), '5');
  assert.deepEqual(f.calls.filter(([op]) => op === 'image.mat').map(([, args]) => [args.method, args.args]), [['cvtcolor', ['BGR2GRAY']], ['threshold', [180, 255, 'Binary']], ['bitwisenot', []]]);
  assert.deepEqual(f.calls.filter(([op]) => op === 'image.dispose').map(([, args]) => args.handle), [4, 3, 2, 1]); assert.equal(f.handles.size, 0);
});

test('cancel during every allocation retains and disposes all created images', async () => {
  for (const allocation of [1, 2, 3, 4]) {
    let count = 0, f; f = fixture({ onOperation: () => { if (++count === allocation) f.controller.abort(false); } });
    let caught = true; try { await f.task.count({ handle: 99 }, { x: 0, y: 0, width: 20, height: 20 }, true); } catch (error) { caught = error; }
    assert.equal(caught, false); assert.equal(f.handles.size, 0);
    assert.ok(f.calls.filter(([op]) => op === 'image.dispose').every(([, , signal]) => signal === null));
  }
});

test('primary OCR error including falsy reasons survives cleanup failures', async () => {
  const f = fixture({ failure: false, cleanupFailure: new Error('dispose') }); let caught = true;
  try { await f.task.count({ handle: 99 }, { x: 0, y: 0, width: 20, height: 20 }, true); } catch (error) { caught = error; }
  assert.equal(caught, false); assert.equal(f.handles.size, 0); assert.equal(f.calls.filter(([op]) => op === 'image.dispose').length, 4);
});

test('cleanup-only failure rejects successful OCR and capture failure preserves reason', async () => {
  const failure = new Error('dispose'), f = fixture({ cleanupFailure: failure });
  await assert.rejects(f.task.count({ handle: 99 }, { x: 0, y: 0, width: 20, height: 20 }, true), error => error === failure);
  let g; g = fixture({ onOperation: () => g.controller.abort(null), cleanupFailure: failure });
  let caught = true; try { await g.task.captured(() => assert.fail('canceled')); } catch (error) { caught = error; }
  assert.equal(caught, null); assert.equal(g.handles.size, 0);
});

test('resin status uses original template geometry, OCR regex and complete Int32 digit extraction', async () => {
  const f = fixture(), texts = ['120/200', 'x 1 2']; f.task.count = async () => texts.shift();
  const result = await f.task.status({ handle: 99, width: 1920, height: 1080 });
  assert.equal(result.OriginalResinCount, 120); assert.equal(result.CondensedResinCount, 12);
  const icons = f.calls.filter(([op]) => op === 'image.find'); assert.deepEqual(icons[0][1].recognition.roi, [1300, 25, 160, 50]);
  assert.ok(icons[0][1].recognition.template_path.endsWith('original_resin_top_icon.png'));
  const overflow = ['99999999999/200', '99999999999']; f.task.count = async () => overflow.shift();
  const invalid = await f.task.status({ handle: 99, width: 1920, height: 1080 });
  assert.equal(invalid.OriginalResinCount, 0); assert.equal(invalid.CondensedResinCount, 0);
});

test('resin use selects only the overlapping right-hand use button and double clicks at60ms', async () => {
  const f = fixture(), clicks = []; f.task.click = async region => clicks.push(region);
  const use = { text: '使用', x: 1400, y: 400, width: 80, height: 40 };
  const rows = [{ text: '原粹树脂40', x: 500, y: 400, width: 200, height: 40 }, { ...use, y: 500 }, use];
  const result = await f.task.pressUseResin(rows, '原粹树脂40');
  assert.equal(result.used, true); assert.equal(result.num, 40); assert.deepEqual(clicks, [use, use]);
  assert.deepEqual(f.calls.find(([op]) => op === 'sleep'), ['sleep', 60]);
  assert.equal((await f.task.pressUseResin([], '浓缩树脂')).used, false);
});

test('20/40 switching distinguishes observed target, disabled button and exhausted retry', async () => {
  for (const mode of ['target', 'disabled', 'missing']) {
    const f = fixture(); f.task.prompt = async () => mode === 'target' ? [{ text: '使用40原粹树脂' }] : [];
    f.task.find = async (frame, group, name) => mode === 'disabled' && name === 'ResinSwitchBtnNoActive' ? { width: 10, height: 10 } : null;
    if (mode === 'missing') await assert.rejects(f.task.switchOriginalResinType(40), error => error.name === 'RetryException');
    else assert.equal(await f.task.switchOriginalResinType(40), mode === 'target');
    assert.equal(f.handles.size, 0);
  }
});
