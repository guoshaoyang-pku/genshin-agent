import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactAffix, ArtifactStat, ArtifactStatus, SalvageTasks } from './salvage.mjs';

const affix = type => new ArtifactAffix(type, 10);
const artifact = (types = ['ATK', 'DEF']) => new ArtifactStat('测试圣遗物', affix('HP'), types.map(affix), 0);
const rect = (x, y = 110, width = 125, height = 153) => ({ x, y, width, height });
const cells = (...xs) => xs.map(x => ({ rect: rect(x), rowNum: 0, colNum: Math.floor(x / 130), isPhantom: false }));
const empty = { x: 0, y: 0, width: 0, height: 0 };
const localized = { strings: Object.fromEntries(['快速选择', ...[1, 2, 3, 4].map(i => i + '星圣遗物')].map(text => [text, text])) };

function fake(options = {}) {
  let sequence = 0, clock = 0, artifactIndex = 0, inventoryPages = 0, setPages = 0;
  const images = new Set(), disposed = new Set(), sessions = new Set(), pageFrames = new Set(), events = [];
  const host = { signal: options.controller?.signal, sourceRoot: '/retained/source', images, disposed, sessions, events,
    now: () => clock, log: (level, message) => events.push({ op: 'log', level, message }),
    async capture() {
      this.signal?.throwIfAborted(); const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080 }; images.add(frame.handle);
      events.push({ op: 'capture', frame, signal: this.signal }); await options.onCapture?.(frame, host); this.signal?.throwIfAborted(); return frame;
    },
    async input(method, args) {
      this.signal?.throwIfAborted(); events.push({ op: 'input', method, args, signal: this.signal });
      await options.onInput?.(method, args, host); this.signal?.throwIfAborted();
    },
    async sleep(ms) { this.signal?.throwIfAborted(); clock += ms; events.push({ op: 'sleep', ms }); await options.onSleep?.(ms, host); this.signal?.throwIfAborted(); },
    async vision(op, args) {
      this.signal?.throwIfAborted(); events.push({ op, args, signal: this.signal });
      if (op === 'image.dispose') { assert.ok(images.delete(args.handle), 'owned frame disposed once'); disposed.add(args.handle); await options.onDispose?.(args, host); return; }
      if (op === 'salvage.metadata') return localized;
      if (op === 'recognition.load') return { name: args.objectName };
      if (op === 'image.find') return options.missingButtons?.includes(args.recognition.name) ? empty : { ...rect(20), button: args.recognition.name };
      if (op === 'image.ocr') return (args.recognition.roi[1] > 0 ? (options.quickMissing ? [] : ['快速选择']) : [1, 2, 3, 4].filter(i => i !== options.missingStar).map(i => i + '星圣遗物')).map((text, i) => ({ ...rect(10, 50 + 30 * i, 100, 25), text }));
      if (op === 'inventory.params' || op === 'salvage.setParams') return { roi: rect(40, 100, 1300, 852), s1Round: 3, roundMilliseconds: 40, s2Round: 2, s3Scale: .018 };
      if (op === 'inventory.grid' || op === 'salvage.setGrid') {
        const sets = op === 'salvage.setGrid'; let selected;
        if (args.postProcess === false) selected = cells(60);
        else {
          const page = sets ? setPages++ : inventoryPages++;
          selected = (sets ? options.setPages : options.pages)?.[page] ?? [];
          if (!sets) pageFrames.add(args.handle);
        }
        return { cells: selected, rawRects: selected.map(cell => cell.rect), roi: rect(40, 100, 1300, 852) };
      }
      if (op === 'salvage.status') {
        const status = pageFrames.has(args.handle) ? options.initial?.[args.rect.x] ?? 0 : options.after?.[args.rect.x] ?? 2;
        return { status, statusName: Object.keys(ArtifactStatus)[status] };
      }
      if (op === 'salvage.artifact') {
        const item = options.artifacts?.[artifactIndex++] ?? artifact();
        await options.onArtifact?.(args, host); this.signal?.throwIfAborted();
        if (item instanceof Error) throw item;
        return { artifact: item, allText: 'source OCR' };
      }
      if (op === 'inventory.scrolling') return { isScrolling: options.scrolling?.shift() ?? false };
      if (op === 'salvage.setCreate') {
        const session = 'model-' + ++sequence; sessions.add(session); await options.onCreate?.(session, host); this.signal?.throwIfAborted();
        return { session, model: { original: true, mode: args.mode } };
      }
      if (op === 'salvage.setRelease') { assert.ok(sessions.delete(args.session)); await options.onRelease?.(args, host); return { released: true }; }
      if (op === 'salvage.setIcon') return { name: options.setNames?.[args.rect.x] ?? null, candidateName: 'candidate', score: .8 };
      throw new Error('Unexpected vision ' + op);
    } };
  const task = new SalvageTasks(host, options.config);
  task.returnMainUi = async () => { events.push({ op: 'returnMainUi' }); return { verified: true }; };
  task.openInventory = async page => { events.push({ op: 'openInventory', page }); };
  return { task, host };
}
function released(host) {
  assert.equal(host.images.size, 0); assert.equal(host.sessions.size, 0);
  assert.equal(host.events.filter(event => event.op === 'capture').length, host.disposed.size);
  assert.ok(host.events.filter(event => event.op === 'image.dispose' || event.op === 'salvage.setRelease' || event.method === 'releaseAll').every(event => event.signal === null));
  assert.equal(host.events.at(-1).method, 'releaseAll');
}

test('quick salvage deselects higher stars on one screenshot, confirms and exits', async () => {
  const { task, host } = fake();
  const result = await task.autoArtifactSalvage({ Star: 2, JavaScript: null });
  assert.equal(result.completed, true); assert.equal(result.manualReviewRequired, false); assert.equal(result.mainUiVerified, true);
  assert.deepEqual(result.quickSalvage, { deselectedStars: [3, 4], submitButtonObserved: true, confirmationClicked: true, verifiedDecomposedCount: null });
  assert.equal(host.events.filter(event => event.op === 'returnMainUi').length, 2);
  assert.equal(host.events.filter(event => event.op === 'image.ocr').length, 2);
  assert.ok(!host.events.some(event => event.method === 'leftButtonClick')); released(host);
});
test('missing quick-select, star, or entry button returns incomplete and cleans up', async () => {
  for (const [options, stopReason] of [[{ quickMissing: true }, 'quickSelectMissing'], [{ missingStar: 4 }, 'starOptionMissing'], [{ missingButtons: ['BtnArtifactSalvage'] }, 'salvageButtonMissing']]) {
    const { task, host } = fake(options); const result = await task.autoArtifactSalvage({ Star: 2, JavaScript: null });
    assert.equal(result.completed, false); assert.equal(result.stopReason, stopReason);
    assert.ok(!host.events.some(event => event.args?.recognition?.name === 'BtnArtifactSalvageConfirm')); released(host);
  }
});
test('five-star scan skips locked/selected initial cells and leaves matched candidates for review', async () => {
  const { task, host } = fake({ pages: [cells(60, 200, 340, 480)], initial: { 60: 1, 200: 2 }, artifacts: [artifact(['ATK', 'DEF']), artifact(['CRITRate', 'CRITDMG'])] });
  const result = await task.autoArtifactSalvage({ MaxNumToCheck: 2 });
  assert.equal(result.fiveStar.checked, 2); assert.equal(result.fiveStar.selected, 1); assert.equal(result.manualReviewRequired, true);
  assert.deepEqual(result.fiveStar.items.map(item => item.selected), [false, false, true, false]);
  assert.equal(result.fiveStar.stopReason, 'checkLimit');
  assert.equal(host.events.filter(event => event.args?.recognition?.name === 'BtnArtifactSalvageConfirm').length, 1);
  assert.equal(host.events.filter(event => event.op === 'returnMainUi').length, 1); released(host);
});
test('Skip deselects without consuming count; nonselected click consumes count', async () => {
  const { task, host } = fake({ pages: [cells(60, 200, 340)], artifacts: [new Error('OCR failed'), artifact()], after: { 200: 0 } });
  const result = await task.autoArtifactSalvage({ MaxNumToCheck: 1 });
  assert.equal(result.fiveStar.checked, 1); assert.equal(result.fiveStar.recognitionSkipped, 1); assert.equal(result.fiveStar.selected, 0);
  assert.equal(result.fiveStar.items.length, 2); assert.match(result.fiveStar.items[0].recognitionError, /OCR failed/); released(host);
});
test('zero/negative source check limit still inspects first eligible item', async () => {
  for (const MaxNumToCheck of [0, -2]) {
    const { task, host } = fake({ pages: [cells(60, 200)] }); const result = await task.autoArtifactSalvage({ MaxNumToCheck });
    assert.equal(result.fiveStar.checked, 1); assert.equal(result.fiveStar.items.length, 1); released(host);
  }
});
test('Abort and filter exceptions retain selected-item evidence', async () => {
  for (const [options, param, pattern] of [[{ artifacts: [new Error('OCR broken')] }, { RecognitionFailurePolicy: 1 }, /OCR broken/], [{}, { JavaScript: 'throw new Error("bad filter");' }, /bad filter/]]) {
    const { task, host } = fake({ pages: [cells(60)], ...options });
    await assert.rejects(task.autoArtifactSalvage(param), error => { assert.match(error.message, pattern); assert.equal(error.evidence.completed, false); assert.equal(error.evidence.fiveStar.items[0].selected, true); return true; });
    released(host);
  }
});
test('set filtering preserves substring matching, scoped model and two confirmations', async () => {
  for (const [width, height] of [[1920, 1080], [1280, 720]]) {
    const { task, host } = fake({ width, height, setPages: [cells(60, 200, 340)], setNames: { 60: '猎人', 200: '剧团' }, pages: [] });
    const result = await task.autoArtifactSalvage({ ArtifactSetFilter: '逐影猎人及其他', JavaScript: 'Output = false;' });
    assert.deepEqual(result.setFilter.items.map(item => item.selected), [true, false, false]);
    assert.equal(result.setFilter.pages, 1); assert.equal(result.setFilter.model.original, true);
    assert.equal(result.setFilter.filterConfirmObserved, true); assert.equal(result.setFilter.confirmObserved, true);
    assert.equal(host.events.filter(event => event.op === 'salvage.setCreate').length, 1);
    assert.ok(host.events.some(event => event.method === 'click' && event.args[0] === 315 && event.args[1] === 190), 'source ClickTo stays in capture pixels below 1080p');
    assert.equal(host.events.find(event => event.op === 'inventory.scrolling').args.page, 'ArtifactSalvage'); released(host);
  }
});
test('scrolling preserves source rounds, alignment and final bottom-right mouse move', async () => {
  const { task, host } = fake({ pages: [cells(60), []], scrolling: [true] });
  const result = await task.autoArtifactSalvage({ MaxNumToCheck: 5 });
  assert.equal(result.fiveStar.stopReason, 'noGrid');
  const scrolls = host.events.filter(event => event.method === 'verticalScroll');
  assert.equal(scrolls.length, 5); assert.ok(scrolls.every(event => event.args[0] === -2));
  assert.ok(host.events.some(event => event.method === 'moveMouseTo' && event.args[0] === 1340 && event.args[1] === 952)); released(host);
});
test('capture cancellation preserves falsy reasons and disposes in-flight allocations', async () => {
  for (const reason of [null, false, 0, '']) {
    const controller = new AbortController();
    const { task, host } = fake({ controller, onCapture: () => controller.abort(reason), onDispose: () => { throw new Error('dispose'); }, onInput: method => { if (method === 'releaseAll') throw new Error('release'); } });
    let caught = Symbol('unset'); try { await task.autoArtifactSalvage({}); } catch (error) { caught = error; }
    assert.equal(caught, reason); assert.equal(host.images.size, 0); assert.equal(host.events.at(-1).op, 'log');
    assert.ok(host.events.filter(event => event.op === 'image.dispose' || event.method === 'releaseAll').every(event => event.signal === null));
  }
});
test('cancel during model creation still releases session and input', async () => {
  const controller = new AbortController(); const reason = new Error('cancel set model');
  const { task, host } = fake({ controller, onCreate: () => controller.abort(reason) });
  await assert.rejects(task.autoArtifactSalvage({ ArtifactSetFilter: '猎人' }), error => error === reason); released(host);
});
test('cancellation during OCR is never swallowed by Skip', async () => {
  const controller = new AbortController(); const reason = new Error('cancel OCR');
  const { task, host } = fake({ controller, pages: [cells(60)], onArtifact: () => controller.abort(reason) });
  await assert.rejects(task.autoArtifactSalvage({}), error => error === reason);
  assert.equal(host.events.filter(event => event.method === 'click' && event.args[0] === 122.5).length, 1); released(host);
});
test('cleanup failure changes completed receipt and is raised', async () => {
  const { task, host } = fake({ onInput: method => { if (method === 'releaseAll') throw new Error('release failed'); } });
  await assert.rejects(task.autoArtifactSalvage({ JavaScript: null }), error => error.evidence.cleanupFailed && !error.evidence.completed);
  released(host);
});
