import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadMapCoordinates, UnsupportedNativeOperation } from './native.mjs';
import {
  PATHING_ACTIONS, NavigationTasks, auditPathingCorpus, parsePathingTask, loadPathingTask,
  mergePathingControl, loadTeleportCatalog, resolveTeleportTarget, cameraRotation,
  generateMapDragSteps, estimateMapIconAlignment,
  mapMoveState, isMapMoveRecognitionAnomaly, mapRecognitionRecoveryZoom,
} from './navigation.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const resourceRoot = process.env.BETTERGI_SCRIPT_ROOT ?? path.join(project, 'third_party/bettergi/scripts');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (x = 10, y = 20, width = 20, height = 10) => ({ x, y, width, height });
const geometry = await loadMapCoordinates(sourceRoot);
const catalog = await loadTeleportCatalog(sourceRoot);

function fakeHost({ controller, recognize, onInput, onSleep, width = 1920, height = 1080 } = {}) {
  let clock = 0, sequence = 0;
  const calls = [], keys = new Set(), buttons = new Set(), captures = new Set(), disposed = new Set(), visionCalls = [];
  const host = {
    sourceRoot, signal: controller?.signal, calls, keys, buttons, captures, disposed, visionCalls,
    now: () => clock, random: () => 0.5,
    async sleep(ms) { clock += ms; await onSleep?.(ms, host); },
    async capture() { const handle = 'frame-' + (++sequence); captures.add(handle); return { handle, width, height }; },
    async input(method, args) {
      calls.push({ at: clock, method, args });
      if (method === 'keyDown') keys.add(args[0]);
      if (method === 'keyUp') keys.delete(args[0]);
      const button = /^(left|right|middle)Button(Down|Up)$/.exec(method);
      if (button?.[2] === 'Down') buttons.add(button[1]);
      if (button?.[2] === 'Up') buttons.delete(button[1]);
      if (method === 'releaseAll') { keys.clear(); buttons.clear(); }
      await onInput?.(method, args, host);
    },
    async vision(op, args) {
      visionCalls.push({ at: clock, op, args });
      if (op === 'recognition.load') { await readFile(args.path); return { original: args.objectName }; }
      if (op === 'image.dispose') { disposed.add(args.handle); return; }
      const value = await recognize?.(op, args.recognition?.original ?? args.recognition?.name, args, host);
      return value ?? (op === 'image.findMulti' || op === 'image.ocr' ? [] : empty);
    },
    log() {},
  };
  return host;
}
function assertReleased(host) {
  assert.equal(host.calls.at(-1)?.method, 'releaseAll');
  assert.equal(host.keys.size, 0); assert.equal(host.buttons.size, 0);
  assert.deepEqual(host.captures, host.disposed);
}
function waypoint(x = 100, y = 100, overrides = {}) {
  return { x, y, type: 'path', move_mode: 'walk', mapName: 'Teyvat', matchingMethod: 'TemplateMatch',
    point_ext_params: { misidentification: { type: ['unrecognized'], handling_mode: 'previousDetectedPoint' } }, ...overrides };
}

// The pinned corpus is the actual consumer of these defaults, control merges and parsers.
test('all original routes parse with source coordinate conversion and supported action vocabulary', async t => {
  const audit = await auditPathingCorpus(path.join(resourceRoot, 'repo/pathing'), { sourceRoot });
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.routes, 5308); assert.equal(audit.waypoints, 84708);
  assert.deepEqual(audit.maps, { Teyvat: 5104, TheChasm: 78, Enkanomiya: 60, AncientSacredMountain: 25, MoonCanon: 3, SeaOfBygoneEras: 28, TempleOfSpace: 10 });
  assert.deepEqual(audit.matchingMethods, { TemplateMatch: 5089, SIFT: 219 });
  assert.deepEqual(audit.types, { teleport: 6997, path: 65763, target: 10822, orientation: 1126 });
  assert.equal(audit.actions.combat_script, 8821); assert.equal(audit.actions.fight, 4070);
  for (const action of Object.keys(audit.actions).filter(a => a && a !== 'null')) assert.ok(PATHING_ACTIONS.includes(action), action);
  assert.equal(audit.diagnostics.length, 1);
  assert.equal(audit.diagnostics[0].kind, 'map_match_method');
  assert.equal(audit.diagnostics[0].upstreamBehavior, 'TemplateMatch');
  t.diagnostic('5308 original routes / 84708 waypoints parsed; this is data compatibility, not live route completion');
});

test('source JSON comments, defaults, per-route trigger replacement and raw metadata survive parsing', () => {
  const task = parsePathingTask('{/*comment*/"info":{"description":"https://test/a/*x*/,}",},"config":{"realtime_triggers":{"AutoPick":false}},"positions":[{"x":2,"y":3},],}', { geometry });
  assert.equal(task.info.description, 'https://test/a/*x*/,}');
  assert.deepEqual(task.config.realtime_triggers, { AutoPick: false });
  assert.equal(task.positions[0].type, 'path'); assert.equal(task.positions[0].move_mode, 'walk');
  assert.equal(task.positions[0].action, null);
  assert.deepEqual(task.positions[0].point_ext_params.misidentification, { type: ['unrecognized'], handling_mode: 'previousDetectedPoint', arrival_time: 0 });
  assert.deepEqual(task.raw.positions[0], { x: 2, y: 3 });
  assert.deepEqual([task.positions[0].x, task.positions[0].y], [32764, 24570]);
  assert.deepEqual(parsePathingTask({}).config.realtime_triggers, { AutoPick: true });
  assert.deepEqual(parsePathingTask({ config: { realtime_triggers: {} } }).config.realtime_triggers, {});
  const f32 = parsePathingTask({ positions: [{ x: 123.123456789, y: -8.7654321 }] }, { geometry }).positions[0];
  assert.deepEqual({ x: f32.x, y: f32.y }, geometry.gameToImage({ x: Math.fround(f32.gameX), y: Math.fround(f32.gameY) }));
});

test('source map selector falls back to TemplateMatch and preserves the actual target-point semantics', () => {
  assert.equal(parsePathingTask({ info: { map_match_method: 'unknown' } }).matchingMethod, 'TemplateMatch');
  assert.equal(parsePathingTask({ info: { map_name: 'MoonCanon', map_match_method: 'TemplateMatch' } }).matchingMethod, 'SIFT');
  const task = parsePathingTask({ positions: [
    { type: 'target', action: 'fight' }, { type: 'path', action: 'hydro_collect' },
    { type: 'target', action: 'up_down_grab_leaf' }, { type: 'orientation' }, { type: 'teleport' }, { type: 'path' }, { type: 'teleport' },
  ] });
  assert.deepEqual(task.positions.slice(0, 4).map(p => p.isTarget), [true, false, false, false]);
  assert.deepEqual(task.segments.map(s => s.length), [4, 2, 1]);
  assert.throws(() => parsePathingTask({ positions: [{ type: 'unknown' }] }), /Unknown waypoint/);
  assert.throws(() => parsePathingTask({ positions: [{ x: Infinity }] }), /finite/);
  assert.throws(() => parsePathingTask({ positions: [{ move_mode: 'teleport' }] }), /Unknown move/);
  assert.throws(() => parsePathingTask({ info: { map_name: 'UnknownScene' } }), UnsupportedNativeOperation);
});

test('control merge replaces arrays, covers selected objects and adds deduplicated arrays in source order', () => {
  const original = { info: { name: 'old', tags: ['a', 'a'], other: true }, nested: { keep: true }, positions: [1, 2] };
  const result = mergePathingControl(original, { global_cover: {
    info: { _arr_add: ['tags'], tags: ['a', 'b'] }, _obj_cover: ['nested'], nested: { replace: true }, positions: [3],
  }, json_list: [{ name: 'route', cover: { info: { name: 'first' } } }, { name: 'route', cover: { info: { name: 'second' } } }] }, 'route');
  assert.deepEqual(result, { info: { name: 'first', tags: ['a', 'b'], other: true }, nested: { replace: true }, positions: [3] });
  assert.equal(original.info.name, 'old');
});

test('route file only applies its immediate control, follows references, reports cycle fallback and gates new versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-route-'));
  try {
    const dir = path.join(root, 'child'); await mkdir(dir);
    const filename = path.join(dir, 'route.json');
    await writeFile(filename, JSON.stringify({ info: { name: 'original', enable_monster_loot_split: true }, positions: [{ action: 'combat_script', action_params: 'walk(w,0.1)' }] }));
    await writeFile(path.join(root, 'control.json5'), JSON.stringify({ global_cover: { info: { name: 'ancestor ignored' } } }));
    assert.equal((await loadPathingTask(filename, { sourceRoot })).info.name, 'original');
    await writeFile(path.join(dir, 'control.json5'), '{"ref":"../control.json5"}');
    let task = await loadPathingTask(filename, { sourceRoot });
    assert.equal(task.info.name, 'ancestor ignored');
    assert.equal(task.positions[0].point_ext_params.enable_monster_loot_split, true);
    assert.equal(task.positions[0].combatScript.commands[0].method, 'walk');
    await writeFile(path.join(root, 'control.json5'), '{"ref":"child/control.json5"}');
    task = await loadPathingTask(filename, { sourceRoot });
    assert.equal(task.info.name, 'original'); assert.match(task.diagnostics[0].message, /cycle/);
    await rm(path.join(dir, 'control.json5'));
    for (const bgi_version of ['0.66.2-alpha.3', '0.66.2', '0.67.0', '999.0.0']) {
      await writeFile(filename, JSON.stringify({ info: { bgi_version } }));
      await assert.rejects(loadPathingTask(filename, { sourceRoot }), /Route requires/);
    }
    for (const bgi_version of ['0.66.2-alpha.1', '0.66.1', 'invalid']) {
      await writeFile(filename, JSON.stringify({ info: { bgi_version } }));
      await loadPathingTask(filename, { sourceRoot });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('teleport catalog reuses all seven original scenes and coordinate axis conventions', async () => {
  assert.equal(catalog.scenes.size, 7); assert.equal(catalog.countries.size, 8);
  assert.equal([...catalog.scenes.values()].reduce((n, s) => n + s.points.length, 0), 936);
  for (const [mapName, scene] of catalog.scenes) for (const point of scene.points) {
    assert.equal(point.x, point.position[2]); assert.equal(point.y, point.position[0]); assert.equal(point.height, point.position[1]);
    const result = resolveTeleportTarget(catalog, point.x, point.y, mapName);
    assert.equal(result.x, point.x); assert.equal(result.y, point.y);
    assert.ok(result.finalZoom >= 1 && result.finalZoom <= (mapName === 'MoonCanon' ? 3 : 4.4));
  }
  const point = catalog.scenes.get('Teyvat').points[0];
  const forced = resolveTeleportTarget(catalog, point.x + 0.25, point.y - 0.25, 'Teyvat', true);
  assert.deepEqual([forced.x, forced.y, forced.country], [point.x + 0.25, point.y - 0.25, null]);
});

test('camera controller wraps around zero and follows source gain thresholds and midpoint-even rounding', () => {
  assert.deepEqual(cameraRotation(359, 1), { diff: -2, dx: 2 });
  assert.deepEqual(cameraRotation(1, 359), { diff: 2, dx: -2 });
  assert.deepEqual(cameraRotation(0, 180), { diff: -180, dx: 720 });
  assert.equal(cameraRotation(6, 0).dx, -12); assert.equal(cameraRotation(31, 0).dx, -93);
  assert.equal(cameraRotation(91, 0).dx, -364);
  assert.equal(cameraRotation(1, 0, 2.5).dx, -2); assert.equal(cameraRotation(0, 1, 2.5).dx, 2);
  assert.throws(() => cameraRotation(NaN, 0), /finite/);
});

test('map movement preserves original distance, recovery zoom and inertial anomaly thresholds', () => {
  assert.deepEqual(mapMoveState({ x: 10, y: 20 }, { x: 1010, y: -980 }, 2), { center: { x: 10, y: 20 }, dx: 1180.5, dy: -1180.5, distance: Math.hypot(1180.5, 1180.5) });
  assert.equal(mapRecognitionRecoveryZoom(4.4), 3.4000000000000004);
  assert.equal(mapRecognitionRecoveryZoom(5.8), 4.8); assert.equal(mapRecognitionRecoveryZoom(1), 2);
  assert.equal(mapRecognitionRecoveryZoom(3, 'MoonCanon'), 4);
  const origin = { x: 0, y: 0 }, predicted = { x: 2000, y: 0 };
  assert.equal(isMapMoveRecognitionAnomaly(origin, predicted, { x: 2000, y: 10 }), false);
  assert.equal(isMapMoveRecognitionAnomaly(origin, predicted, { x: 500, y: 0 }), true);
  assert.equal(isMapMoveRecognitionAnomaly(origin, predicted, { x: 4000, y: 0 }), true);
  assert.equal(isMapMoveRecognitionAnomaly(origin, predicted, { x: 0, y: 2000 }), true);
  assert.equal(isMapMoveRecognitionAnomaly(origin, { x: 10, y: 0 }, { x: 210.01, y: 0 }), true);
  assert.throws(() => mapMoveState(origin, predicted, 0), /positive/);
});

test('map drag conserves every integer delta in both directions and decelerates after the fast phase', () => {
  for (const delta of [-5000, -103, -1, 0, 1, 103, 5000]) for (const n of [1, 3, 5, 25, 60]) {
    const steps = generateMapDragSteps(delta, n);
    assert.equal(steps.length, n); assert.equal(steps.reduce((a, b) => a + b), delta);
    assert.ok(steps.every(x => Number.isInteger(x) && (delta === 0 || x === 0 || Math.sign(x) === Math.sign(delta))));
  }
  const steps = generateMapDragSteps(1000, 10);
  assert.equal(steps.slice(0, 5).reduce((a, b) => a + b), 850);
  assert.ok(steps[5] >= steps[9]);
});

test('icon alignment uses one-to-one matching and rejects unsafe single/two-icon corrections', () => {
  const expected = [{ x: 100, y: 100, types: ['TeleportWaypoint'] }, { x: 200, y: 100, types: ['Domain'] }, { x: 170, y: 230, types: ['Goddess'] }];
  const observed = expected.map(p => ({ ...p, x: p.x + 28, y: p.y - 16 }));
  const result = estimateMapIconAlignment(expected, observed);
  assert.deepEqual(result.offset, { x: 28, y: -16 }); assert.equal(result.pairs.length, 3); assert.equal(result.uncertainty, 4);
  for (const n of [1, 2]) assert.deepEqual(estimateMapIconAlignment(expected.slice(0, n), observed.slice(0, n)).offset, { x: 0, y: 0 });
  const duplicates = estimateMapIconAlignment([{ x: 100, y: 100, types: ['A'] }, { x: 103, y: 100, types: ['A'] }], [{ x: 100, y: 100, types: ['A'] }]);
  assert.equal(duplicates.pairs.length, 1);
  assert.equal(estimateMapIconAlignment(expected, observed.map(p => ({ ...p, types: ['Unknown'] }))).pairs.length, 0);
});

test('map open requires original UI recognition after M and disposes every capture', async () => {
  let opened = false;
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' && opened ? region() : empty,
    onInput: (method, args) => { if (method === 'keyPress' && args[0] === 'M') opened = true; } });
  assert.deepEqual(await new NavigationTasks(host).openMap(), { verified: true, attempts: 1 });
  assert.deepEqual(host.calls.map(c => [c.method, c.args]), [['releaseAll', []], ['keyPress', ['M']]]);
  assert.deepEqual(host.captures, host.disposed);
});

test('map open preserves two inner checks, main UI recovery and outer blessing handling', async () => {
  let opens = 0, mainRecoveries = 0, blessings = 0;
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' && opens >= 3 ? region() : empty,
    onInput: (method, args) => { if (method === 'keyPress' && args[0] === 'M') opens++; } });
  host.navigation = async op => { assert.equal(op, 'blessingOfTheWelkinMoon'); blessings++; };
  const nav = new NavigationTasks(host); nav.returnMainUi = async () => { mainRecoveries++; };
  assert.deepEqual(await nav.openMap(), { verified: true, attempts: 3 });
  assert.equal(mainRecoveries, 1); assert.equal(blessings, 1);
  assert.deepEqual(host.captures, host.disposed);
});

test('ground layer waits for the clicked selection to clear and never toggles underground afterward', async () => {
  let clickedAt = Infinity;
  const host = fakeHost({ recognize: (op, name, args, host) => {
    if (name === 'MapUndergroundToGroundButton' && host.now() < clickedAt) return region(10, 20);
    if (name === 'MapUndergroundSwitchButton' && host.now() < clickedAt + 160) return region(30, 40);
    return empty;
  }, onInput: (method, args, host) => { if (method === 'click') clickedAt = host.now(); } });
  assert.deepEqual(await new NavigationTasks(host).ensureGroundLayer(), { verified: true, clicked: true });
  assert.equal(host.calls.filter(c => c.method === 'click').length, 1);
  assert.deepEqual(host.captures, host.disposed);
});

test('map zoom measures original slider geometry and verifies actual wheel response', async () => {
  let zoom = 4;
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' ? region(100, 612 - (6 - zoom) * 144 / 5 - 1, 20, 2) : empty,
    onInput: (method, args) => { if (method === 'verticalScroll') zoom = Math.max(1, Math.min(6, zoom - args[0] * 0.085)); } });
  const nav = new NavigationTasks(host);
  assert.ok(Math.abs(await nav.bigMapZoom() - 4) < 1e-12);
  const result = await nav.adjustMapZoom(2);
  assert.ok(result.closeEnough); assert.ok(Math.abs(zoom - 2) < 0.1);
  assert.ok(host.calls.filter(c => c.method === 'verticalScroll').every(c => c.args[0] === 1));
  assert.deepEqual(host.captures, host.disposed);
});

test('returning from an independent map forces the target country switch', async () => {
  const nav = new NavigationTasks(fakeHost()); nav.lastMap = 'TheChasm';
  const selections = []; nav.switchArea = async name => selections.push(name);
  nav.locateBigMap = async () => { throw new Error('Must switch before recognizing incompatible map'); };
  await nav.switchTargetArea({ mapName: 'Teyvat', country: '璃月', x: 0, y: 0 });
  assert.deepEqual(selections, ['璃月']);
});

test('big map center recognition uses source position matcher with full-map previous coordinates', async () => {
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' ? region() : op === 'map.locateBigMap' ? { found: true, position: { x: 32748, y: 24536 }, genshin: { x: 10, y: 20 } } : undefined });
  const nav = new NavigationTasks(host);
  assert.deepEqual(await nav.locateBigMapCenter('Teyvat', { x: 12, y: 24 }), { x: 10, y: 20 });
  const call = host.visionCalls.find(c => c.op === 'map.locateBigMap');
  assert.equal(call.args.matchTarget, 'position'); assert.deepEqual(call.args.previous, { x: 32744, y: 24528 });
  assert.deepEqual(host.captures, host.disposed);
});

test('teleport final zoom recomputes clamped neighbor radius instead of scaling the old radius', async () => {
  const nav = new NavigationTasks(fakeHost()), target = { mapName: 'Teyvat', finalZoom: 2 };
  let zoomed = false;
  nav.evaluateView = async () => ({ safe: true, zoom: zoomed ? 2 : 4, point: { x: zoomed ? 1680 : 1320, y: 540 },
    frame: { width: 1920, height: 1080 }, nearest: zoomed ? 100 : 50, radius: zoomed ? 130 : 120 });
  nav.dragMap = async () => assert.fail('Predicted source radius leaves sufficient click space');
  nav.adjustMapZoom = async zoom => { assert.equal(zoom, 2); zoomed = true; return { achieved: 2, closeEnough: true }; };
  assert.equal((await nav.prepareTeleportView(target)).zoom, 2);
  nav.evaluateView = async () => ({ safe: true, zoom: 1.5, point: { x: 960, y: 540 }, frame: { width: 1920, height: 1080 }, nearest: 10, radius: 120 });
  nav.adjustMapZoom = async () => assert.fail('Source never zooms out solely for a close neighbor');
  assert.equal((await nav.prepareTeleportView(target)).zoom, 1.5);
});

test('unsafe teleport view uses proportional initial zoom and never hardcodes travel zoom five', async () => {
  const nav = new NavigationTasks(fakeHost()), target = { mapName: 'Teyvat', x: 1000, y: 0, finalZoom: 2 };
  let zoomed = false, chosen;
  nav.evaluateView = async () => ({ safe: zoomed, zoom: zoomed ? chosen : 2, nearest: 200, radius: 260, point: { x: 960, y: 540 }, frame: { width: 1920, height: 1080 } });
  nav.locateBigMapCenter = async () => ({ x: 0, y: 0 });
  nav.adjustMapZoom = async value => { chosen = value; zoomed = true; return { achieved: value, closeEnough: true }; };
  nav.moveMapToCore = async () => assert.fail('First proportional zoom should expose the target in this fixture');
  await nav.prepareTeleportView(target);
  assert.ok(Math.abs(chosen - 2.361) < 1e-12);
});

test('teleport safe-view movement keeps source zoom fixed and requires a newly observed rectangle', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), target = { mapName: 'Teyvat', x: 300 / 2.361 * 2, y: 0 };
  let moved = false;
  nav.bigMapZoom = async () => 2;
  nav.initialMapMoveState = async () => ({ state: mapMoveState({ x: 0, y: 0 }, target, 2), zoom: 2 });
  nav.evaluateView = async () => ({ point: { x: moved ? 960 : 20, y: 540 }, frame: { width: 1920, height: 1080 }, radius: 120 });
  nav.adjustMapZoom = async () => assert.fail('Teleport click-area movement uses allowZoom=false');
  nav.dragMap = async dx => { moved = true; return { dx, dy: 0 }; };
  nav.locateBigMapCenter = async () => ({ x: target.x, y: 0 });
  const result = await nav.moveMapToCore(target, { requiredVisibleRadius: 120 });
  assert.equal(result.safe, true); assert.equal(result.iterations, 1);
});

test('map inertial predictions stop after five consecutive unrecognized centers', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), target = { mapName: 'Teyvat', x: 100000, y: 0 };
  let misses = 0;
  nav.bigMapZoom = async () => 2;
  nav.initialMapMoveState = async () => ({ state: mapMoveState({ x: 0, y: 0 }, target, 2), zoom: 2 });
  nav.evaluateView = async () => ({ point: { x: 0, y: 0 }, frame: { width: 1920, height: 1080 } });
  nav.dragMap = async () => ({ dx: 10, dy: 0 });
  nav.locateBigMapCenter = async () => { misses++; throw Object.assign(new Error('No features'), { code: 'MAP_POSITION_NOT_RECOGNIZED' }); };
  await assert.rejects(nav.moveMapToCore(target), /exhausted five/);
  assert.equal(misses, 6);
});

test('initial center failure preserves original zoom recovery then nearest country jump', async () => {
  const nav = new NavigationTasks(fakeHost()), target = { mapName: 'Teyvat', x: 0, y: 0 };
  const [country, center] = [...catalog.countries].sort((a, b) => Math.hypot(a[1].x, a[1].y) - Math.hypot(b[1].x, b[1].y))[0];
  const events = [];
  nav.locateBigMapCenter = async () => { throw Object.assign(new Error('No features'), { code: 'MAP_POSITION_NOT_RECOGNIZED' }); };
  nav.adjustMapZoom = async zoom => { events.push(zoom); return { achieved: zoom }; };
  nav.switchArea = async area => events.push(area);
  const initial = await nav.initialMapMoveState(target, 5);
  assert.deepEqual(events, [4.4, country]);
  assert.deepEqual(initial.state.center, { x: Math.fround(center.x), y: Math.fround(center.y) });
  assert.equal(initial.zoom, 4.4);
});

test('candidate OCR fallback requires exactly one target-name match', async () => {
  let ambiguous = true;
  const host = fakeHost({ recognize: op => op === 'image.ocr' ? ambiguous ? [region(), region()].map(r => ({ ...r, text: '望风山地' })) : [{ ...region(1320, 200), text: '望风山地' }] : undefined });
  const nav = new NavigationTasks(host), target = { target: { name: '望风山地' } };
  assert.deepEqual(await nav.panelCandidates({ handle: 'frame', width: 1920, height: 1080 }, target), []);
  ambiguous = false;
  assert.equal((await nav.panelCandidates({ handle: 'frame', width: 1920, height: 1080 }, target)).length, 1);
});

test('candidate clicks retain original minimum animation wait before clicking and require a real teleport button', async () => {
  let clicked = false, firstSeen;
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' || (name === 'TeleportButton' && clicked) ? region() : undefined,
    onInput: method => { if (method === 'click') clicked = true; } });
  const nav = new NavigationTasks(host);
  nav.panelCandidates = async () => { firstSeen ??= host.now(); return [{ click: region(1300, 200) }]; };
  const result = await nav.confirmTeleportPanel({ target: { name: 'point' } });
  assert.equal(result.candidateClicks, 1);
  assert.ok(host.calls.find(c => c.method === 'click').at - firstSeen >= 200);
  assert.equal(host.calls.at(-1).args[0], 'F');
  assert.deepEqual(host.captures, host.disposed);
});

test('candidate panel checks wait600ms after each click before retrying and stop after two attempts', async () => {
  const host = fakeHost({ recognize: (op, name) => name === 'MapScaleButton' ? region() : undefined });
  const nav = new NavigationTasks(host);
  nav.panelCandidates = async () => [{ click: region(1300, 200) }];
  await assert.rejects(nav.confirmTeleportPanel({ target: { name: 'inactive' } }), error => error.code === 'TELEPORT_PANEL_NOT_OPEN');
  const clicks = host.calls.filter(c => c.method === 'click');
  assert.equal(clicks.length, 2);
  assert.ok(clicks[1].at - clicks[0].at >= 150 + 600 + 200);
  assert.ok(!host.calls.some(c => c.method === 'keyPress' && c.args[0] === 'F'));
  assert.deepEqual(host.captures, host.disposed);
});

test('teleport completion refuses an already-visible main UI and requires loading then stable return', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host);
  nav.isInMainUi = async () => true; nav.isInBigMapUi = async () => false;
  await assert.rejects(nav.waitTeleportComplete({ timeout: 1200 }), /loadingObserved=false/);
  const start = host.now();
  nav.isInMainUi = async () => host.now() - start < 200 || host.now() - start >= 500;
  nav.isInBigMapUi = async () => host.now() - start < 200;
  const result = await nav.waitTeleportComplete({ timeout: 2000 });
  assert.equal(result.sawLoading, true); assert.equal(result.elapsedMs, 1000);
  assert.deepEqual(host.captures, host.disposed);
});

test('teleport loading invokes the real blessing handler at original one-second intervals', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), events = [];
  nav.isInMainUi = async () => host.now() >= 2200; nav.isInBigMapUi = async () => false;
  host.navigation = async op => events.push([op, host.now()]);
  assert.equal((await nav.waitTeleportComplete({ timeout: 3000 })).elapsedMs, 2200);
  assert.deepEqual(events, [['blessingOfTheWelkinMoon', 1000], ['blessingOfTheWelkinMoon', 2000]]);
  assert.deepEqual(host.captures, host.disposed);
});

function instrumentTeleport(nav, { beforeView, panel, completion } = {}) {
  const original = nav.teleportOnce; let attempts = 0;
  return async function (x, y, options) {
    attempts++;
    this.openMap = async () => {}; this.ensureGroundLayer = async () => {}; this.switchTargetArea = async () => {};
    this.prepareTeleportView = async target => { await beforeView?.(this, attempts); return { target }; };
    this.alignedTeleportPoint = async () => ({ point: { x: 960, y: 540 }, originalPoint: { x: 960, y: 540 }, correctionTooLarge: false, alignment: { pairs: [], uncertainty: 16 } });
    this.confirmTeleportPanel = async target => panel?.(this, attempts, target) ?? { confirmed: true };
    this.waitTeleportComplete = async () => completion?.(this, attempts) ?? { verified: true, sawLoading: true, elapsedMs: 1000 };
    return original.call(this, x, y, options);
  };
}

test('teleport retries at most three attempts, copies successful state and keeps original host isolated', async () => {
  const controller = new AbortController(), host = fakeHost({ controller }), nav = new NavigationTasks(host);
  const original = NavigationTasks.prototype.teleportOnce, input = host.input;
  const signals = []; let seenAttempts = 0;
  NavigationTasks.prototype.teleportOnce = instrumentTeleport(nav, { beforeView: async (task, attempt) => {
    seenAttempts = attempt; signals.push(task.host.signal);
    assert.notEqual(task.host, host); assert.equal(host.signal, controller.signal);
    if (attempt < 3) throw new Error('Unrecognized map');
    task.wheelPerNotch = 0.09;
  } });
  try {
    const result = await nav.teleport(0, 0);
    assert.equal(result.attempts, 3); assert.equal(result.verified, true); assert.equal(seenAttempts, 3);
    assert.equal(nav.lastMap, 'Teyvat'); assert.equal(nav.wheelPerNotch, 0.09); assert.ok(nav.previous);
    assert.equal(signals[0], signals[2]); assert.notEqual(signals[0], controller.signal);
    assert.equal(host.input, input); assert.equal(host.signal, controller.signal);
    assert.equal(host.now(), 600); assertReleased(host);
  } finally { NavigationTasks.prototype.teleportOnce = original; }
});

test('teleport no-panel errors close map immediately, inactive-point errors close before every retry', async () => {
  for (const code of ['TELEPORT_PANEL_NOT_OPEN', 'TP_POINT_NOT_ACTIVATE']) {
    const host = fakeHost(), nav = new NavigationTasks(host), original = NavigationTasks.prototype.teleportOnce;
    let attempts = 0;
    NavigationTasks.prototype.teleportOnce = instrumentTeleport(nav, { panel: async (_, attempt) => { attempts = attempt; throw Object.assign(new Error(code), { code }); } });
    try {
      await assert.rejects(nav.teleport(0, 0), error => error.code === code);
      const expected = code === 'TELEPORT_PANEL_NOT_OPEN' ? 1 : 3;
      assert.equal(attempts, expected);
      assert.equal(host.calls.filter(c => c.method === 'keyPress' && c.args[0] === 'VK_ESCAPE').length, expected);
      assertReleased(host);
    } finally { NavigationTasks.prototype.teleportOnce = original; }
  }
});

test('single teleport total60second deadline prevents further input and releases held input', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), original = NavigationTasks.prototype.teleportOnce;
  let attempts = 0;
  NavigationTasks.prototype.teleportOnce = instrumentTeleport(nav, { beforeView: async (task, attempt) => {
    attempts = attempt; await task.host.input('keyDown', ['W']); await task.host.sleep(60000);
  } });
  try {
    await assert.rejects(nav.teleport(0, 0), /60 second deadline/);
    assert.equal(attempts, 1); assert.equal(host.now(), 60000);
    assert.ok(!host.calls.some(c => c.method === 'click')); assertReleased(host);
  } finally { NavigationTasks.prototype.teleportOnce = original; }
});

test('deadline crossing during capture disposes the just-created frame and cancellation stays linked', async () => {
  for (const condition of ['capture-deadline', 'cancel']) {
    const controller = new AbortController(), host = fakeHost({ controller }), nav = new NavigationTasks(host), original = NavigationTasks.prototype.teleportOnce;
    const capture = host.capture;
    if (condition === 'capture-deadline') host.capture = async () => { const frame = await capture(); await host.sleep(60000); return frame; };
    NavigationTasks.prototype.teleportOnce = instrumentTeleport(nav, { beforeView: async task => {
      await task.host.input('keyDown', ['W']);
      if (condition === 'cancel') controller.abort(new Error('User cancelled'));
      await task.captured(() => assert.fail('Capture callback must never run after abort'));
    } });
    try {
      await assert.rejects(nav.teleport(0, 0), condition === 'cancel' ? /User cancelled/ : /60 second deadline/);
      assertReleased(host);
    } finally { NavigationTasks.prototype.teleportOnce = original; }
  }
});

test('TemplateMatch localization uses the actual map bridge and stale fallback cannot verify arrival', async () => {
  let found = true;
  const host = fakeHost({ recognize: op => op === 'map.locateMinimap' ? { found, position: found ? { x: 100, y: 100 } : null } : undefined });
  const nav = new NavigationTasks(host), point = waypoint();
  assert.equal((await nav.locate(point)).fresh, true);
  assert.equal(host.visionCalls.find(c => c.op === 'map.locateMinimap').args.matchingMethod, 'TemplateMatch');
  await host.sleep(150); found = false;
  assert.deepEqual(await nav.locate(point), { position: { x: 100, y: 100 }, fresh: false, staleMs: 150, additionalMs: 0 });
  await assert.rejects(nav.moveTo(point), /stale position/);
  assertReleased(host);
});

test('map-recognition recovery uses observed big-map center and converts back to full-map image coordinates', async () => {
  const host = fakeHost({ recognize: op => op === 'map.locateMinimap' ? { found: false } : undefined });
  const nav = new NavigationTasks(host), center = { x: 123.125, y: -876.5 };
  nav.openMap = async () => host.sleep(300); nav.isInMainUi = async () => true;
  nav.locateBigMapCenter = async () => center;
  nav.locateBigMap = () => assert.fail('Rectangle matcher must not substitute for original center matcher');
  const result = await nav.locate(waypoint(100, 100, { point_ext_params: { misidentification: { type: ['unrecognized'], handling_mode: 'mapRecognition' } } }));
  assert.deepEqual(result.position, geometry.gameToImage(center));
  assert.equal(result.fresh, true); assert.equal(result.additionalMs, 500);
  assert.deepEqual(nav.previous, { position: result.position, at: 500 });
  assert.ok(host.calls.some(c => c.method === 'keyPress' && c.args[0] === 'VK_ESCAPE'));
  assert.deepEqual(host.captures, host.disposed);
});

test('absolute map precision failures retain inactive-point cleanup code before any click', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host);
  const target = resolveTeleportTarget(catalog, 0, 0);
  const view = { frame: { width: 1920, height: 1080 }, point: { x: 960, y: 540 }, nearest: 20, radius: 0, location: { rect: { x: 0, y: 0, width: 65536, height: 49152 } } };
  await assert.rejects(nav.alignedTeleportPoint(target, view), error => error.code === 'TP_POINT_NOT_ACTIVATE');
  assert.ok(!host.calls.some(c => c.method === 'click'));
  assert.deepEqual(host.captures, host.disposed);
});

test('camera rotation requires measurable angle changes and preserves cancellation cleanup', async () => {
  let angle = 90;
  const host = fakeHost({ recognize: op => op === 'map.cameraOrientation' ? { valid: true, angle } : undefined,
    onInput: method => { if (method === 'moveMouseBy') angle = 0; } });
  assert.deepEqual(await new NavigationTasks(host).rotateTo(0), { verified: true, angle: 0, attempts: 1 });
  assert.equal(host.calls[0].args[0], -270);
  assertReleased(host);
});

test('source final camera correction occurs before retry exhaustion and waypoint rotation recovers once', async () => {
  const host = fakeHost({ recognize: op => op === 'map.cameraOrientation' ? { valid: true, angle: 90 } : undefined });
  const nav = new NavigationTasks(host), events = [];
  await assert.rejects(nav.rotateTo(0, { maxTries: 0 }), error => error.code === 'CAMERA_ROTATION_TIMEOUT');
  assert.equal(host.calls.filter(c => c.method === 'moveMouseBy').length, 2); assert.equal(host.now(), 50);
  let attempts = 0; nav.rotation = async () => { if (++attempts === 1) throw Object.assign(new Error('Camera stuck'), { code: 'CAMERA_ROTATION_TIMEOUT' }); return { verified: true }; };
  host.navigation = async (operation, args) => events.push([operation, args.reason]);
  assert.equal((await nav.rotateForWaypoint(0, 5)).verified, true);
  assert.deepEqual(events, [['resolveAnomalies', 'rotation']]); assert.equal(attempts, 2);
  assertReleased(host);
});

test('waypoint movement uses fresh positions, toggles sprint once and releases held keys on completion', async () => {
  let x = 0;
  const host = fakeHost({ recognize: op => op === 'map.locateMinimap' ? { found: true, position: { x, y: 100 } } : op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : undefined,
    onSleep: (ms, host) => { if (host.keys.has('W')) x = Math.min(100, x + 25); } });
  const result = await new NavigationTasks(host).moveTo(waypoint(100, 100, { move_mode: 'run' }));
  assert.equal(result.verified, true); assert.equal(result.distance, 0);
  assert.equal(host.calls.filter(c => c.method === 'rightButtonDown').length, 1);
  assertReleased(host);
});

test('fly/jump movement uses source timing without an extra bottom frame delay', async () => {
  for (const mode of ['fly', 'jump']) {
    let x = 0;
    const host = fakeHost({ recognize: (op, name) => op === 'map.locateMinimap' ? { found: true, position: { x, y: 100 } } : op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : name === 'SpaceKey' ? empty : undefined,
      onSleep: () => { x = 100; } });
    await new NavigationTasks(host).moveTo(waypoint(100, 100, { move_mode: mode }));
    assert.equal(host.now(), mode === 'fly' ? 300 : 200);
    assertReleased(host);
  }
});

test('map recovery that releases W reasserts it before continuing movement', async () => {
  const host = fakeHost({ onSleep: (ms, host) => { if (host.keys.has('W')) host.arrived = true; } });
  const nav = new NavigationTasks(host); let calls = 0;
  nav.rotation = async () => {};
  nav.locate = async () => {
    if (++calls === 2) { await host.input('releaseAll', []); return { position: { x: 0, y: 100 }, fresh: true, additionalMs: 200 }; }
    return { position: { x: host.arrived ? 100 : 0, y: 100 }, fresh: true, additionalMs: 0 };
  };
  host.vision = async (op, args) => op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : op === 'image.dispose' ? host.disposed.add(args.handle) : undefined;
  assert.equal((await nav.moveTo(waypoint())).verified, true);
  assert.equal(host.calls.filter(c => c.method === 'keyDown').length, 2);
  assertReleased(host);
});

test('precise approach measures before turning, does not use coarse distance handling and never verifies an exhausted approach', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host);
  nav.rotation = () => assert.fail('Arrived precise target must not turn');
  nav.locate = async () => ({ fresh: true, position: { x: 100, y: 100 } });
  assert.equal((await nav.moveTo(waypoint(), { close: true })).verified, true);
  assert.equal(host.now(), 1000); assert.ok(!host.calls.some(c => c.method === 'keyDown'));
  assertReleased(host);
  const far = fakeHost(), stuck = new NavigationTasks(far);
  stuck.locate = async () => ({ fresh: true, position: { x: 0, y: 100 } }); stuck.rotation = async () => {};
  await assert.rejects(stuck.moveTo(waypoint(600, 100), { close: true }), /25 steps/);
  assert.equal(far.calls.filter(c => c.method === 'keyDown').length, 25);
  assert.equal(far.now(), 2000); assertReleased(far);
});

test('movement restores an externally released W and keeps far-distance retries across valid intermediate frames', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host); let samples = 0, recoveries = 0;
  host.isKeyDown = async key => host.keys.has(key);
  host.navigation = async (operation, args) => { assert.equal(operation, 'resolveAnomalies'); assert.equal(args.reason, 'distance'); recoveries++; };
  nav.rotation = async () => {};
  nav.locate = async () => {
    samples++; const x = samples === 1 || samples % 2 ? 0 : -500;
    nav.previous = { position: { x, y: 100 }, at: host.now() };
    if (samples === 3) await host.input('releaseAll', []);
    return { fresh: true, position: nav.previous.position, additionalMs: 0 };
  };
  host.vision = async (op, args) => op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : op === 'image.dispose' ? host.disposed.add(args.handle) : undefined;
  nav.escapeTrap = async () => {};
  await assert.rejects(nav.moveTo(waypoint()), /50 retries|trap recovery exhausted/);
  assert.ok(recoveries > 0); assert.ok(host.calls.filter(c => c.method === 'keyDown').length > 1);
  assertReleased(host);
});

test('hurry dispatch precedes ordinary fly inputs and gadget interval persists across waypoints', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host, { hurryAbility: true, gadgetInterval: 1000 }); let arrived = false;
  nav.rotation = async () => {}; nav.locate = async () => ({ fresh: true, position: { x: arrived ? 100 : 0, y: 100 }, additionalMs: 0 });
  host.navigation = async (op, args) => { assert.equal(op, 'movementAbilities'); assert.equal(args.phase, 'hurry'); arrived = true; return { handled: true }; };
  host.vision = async (op, args) => op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : op === 'image.dispose' ? host.disposed.add(args.handle) : undefined;
  assert.equal((await nav.moveTo(waypoint(100, 100, { move_mode: 'fly' }))).verified, true);
  assert.equal(host.now(), 100); assert.ok(!host.calls.some(c => c.method === 'keyPress')); assertReleased(host);
  nav.options.hurryAbility = false;
  const initial = host.sleep; host.sleep = async ms => { await initial(ms); arrived = true; };
  for (let i = 0; i < 2; i++) { arrived = false; await nav.moveTo(waypoint()); }
  assert.equal(host.calls.filter(c => c.method === 'keyPress' && c.args[0] === 'Z').length, 1);
  assertReleased(host);
});

test('TrapEscaper preserves source directional timing and bounds recovery without claiming arrival', async () => {
  for (const late of [false, true]) {
    const host = fakeHost(), nav = new NavigationTasks(host); nav.locate = async () => ({ fresh: true, position: { x: 0, y: 100 } });
    nav.rotation = async () => {}; nav.motionStatus = async () => 'Normal';
    if (late) await host.sleep(10000);
    const before = host.now(), result = await nav.escapeTrap(waypoint());
    const direction = late ? 'S' : 'A', events = host.calls.filter(c => c.args?.[0] === direction);
    assert.equal(events[1].at - events[0].at, late ? 1500 : 2000);
    assert.equal(result.direction, direction); assert.equal(result.verified, false);
    assert.ok(host.now() - before <= 575 + 2000 + 5100); assert.equal(result.elapsedMs, 5100);
    assert.equal(nav.trapState.randomAngle, 0); assertReleased(host);
  }
});

test('TrapEscaper unwinds held direction on cancellation during jump recovery', async () => {
  const controller = new AbortController(), host = fakeHost({ controller, onSleep: ms => { if (ms === 1700) controller.abort(new Error('Stop trap recovery')); } });
  await assert.rejects(new NavigationTasks(host).escapeTrap(waypoint()), /Stop trap recovery/);
  assert.ok(host.calls.some(c => c.method === 'keyUp' && c.args[0] === 'A')); assertReleased(host);
});

test('cancellation while moving or dragging releases input even when the signal is already aborted', async () => {
  for (const operation of ['move', 'drag']) {
    const controller = new AbortController();
    const host = fakeHost({ controller, recognize: op => op === 'map.locateMinimap' ? { found: true, position: { x: 0, y: 100 } } : op === 'map.cameraOrientation' ? { valid: true, angle: 0 } : undefined,
      onSleep: () => controller.abort(new Error('cancel navigation')) });
    const nav = new NavigationTasks(host);
    await assert.rejects(operation === 'move' ? nav.moveTo(waypoint()) : nav.dragMap(500, -100), /cancel navigation/);
    assert.ok(host.calls.some(c => c.method === (operation === 'move' ? 'keyUp' : 'leftButtonUp')));
    assertReleased(host);
  }
});

test('drag caps movement to safe screen endpoints and the summed events equal the returned displacement', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host);
  const result = await nav.dragMap(-10000, 8000);
  const points = host.calls.filter(c => c.method === 'moveMouseTo').map(c => c.args);
  const [start, end] = [points[0], points.at(-1)];
  assert.equal(end[0] - start[0], result.actualX); assert.equal(end[1] - start[1], result.actualY);
  for (const [x, y] of [start, end]) { assert.ok(x >= 115 && x <= 1805 && y >= 115 && y <= 965); assert.ok(x >= 360 || y >= 430); }
  assertReleased(host);
});

test('route execution refuses absent real-time trigger and external action handlers before pretending completion', async () => {
  const task = parsePathingTask({ positions: [] }, { geometry });
  const host = fakeHost();
  await assert.rejects(new NavigationTasks(host).execute(task), /navigation.beginRoute/);
  assertReleased(host);
  const actionHost = fakeHost();
  await assert.rejects(new NavigationTasks(actionHost).execute(parsePathingTask({ positions: [{ action: 'fishing' }] }, { geometry })), /navigation.action.fishing/);
  assertReleased(actionHost);
});

test('route execution can explicitly disable triggers, orders orientation/log operations and always ends managed routes', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), events = [];
  nav.returnMainUi = async () => events.push('main');
  nav.locate = async point => ({ fresh: true, position: { x: point.x - 1, y: point.y } });
  nav.rotation = async angle => events.push(angle);
  host.log = (level, text) => events.push(text);
  let result = await nav.execute(parsePathingTask({ positions: [{ type: 'orientation', action: 'log_output', action_params: 'look' }] }, { geometry }), { manageTriggers: false, manageParty: false });
  assert.deepEqual(events, ['main', 'look', 0]); assert.equal(result.completed, 1); assert.equal(result.managedTriggers, false);
  const managed = fakeHost(); managed.navigation = async op => events.push(op);
  const broken = new NavigationTasks(managed); broken.returnMainUi = async () => { throw new Error('UI failed'); };
  await assert.rejects(broken.execute(parsePathingTask({}, { geometry })), /UI failed/);
  assert.deepEqual(events.slice(-2), ['beginRoute', 'endRoute']);
  assertReleased(managed); assertReleased(host);
});

test('route party preparation is required by default and cannot silently bypass source validation', async () => {
  const task = parsePathingTask({ config: { realtime_triggers: {} }, positions: [{ type: 'path' }] }, { geometry });
  const host = fakeHost(), nav = new NavigationTasks(host);
  await assert.rejects(nav.execute(task), /navigation.prepareRoute/);
  assertReleased(host);
  host.navigation = async operation => operation === 'prepareRoute' ? { ready: false } : assert.fail(operation);
  await assert.rejects(nav.execute(task), /validation did not confirm readiness/);
  assert.ok(!host.calls.some(c => c.method === 'keyDown')); assertReleased(host);
});

test('prepared route party config reaches recovery and actions and is restored after failures', async () => {
  for (const failure of ['', 'action', 'endRoute']) {
    const host = fakeHost(), original = { MainAvatarIndex: 1 }, prepared = { MainAvatarIndex: 3, UseGadgetIntervalMs: 250 };
    const nav = new NavigationTasks(host, { partyConfig: original }), previousOptions = nav.options;
    const seen = [];
    host.navigation = async (operation, args) => {
      if (operation === 'prepareRoute') return { ready: true, partyConfig: prepared };
      if (['resolveAnomalies', 'recoverWhenLowHp', 'action.mining'].includes(operation)) {
        seen.push(operation); assert.equal(args.options.partyConfig, prepared);
        if (failure === 'action' && operation === 'action.mining') throw Error('action failed');
      }
      if (failure === 'endRoute' && operation === 'endRoute') throw Error('endRoute failed');
      return {};
    };
    nav.returnMainUi = async () => {}; nav.moveTo = async () => {};
    const task = parsePathingTask({ positions: [{ action: 'mining' }] }, { geometry });
    if (failure) await assert.rejects(nav.execute(task), new RegExp(failure + ' failed'));
    else assert.equal((await nav.execute(task)).completed, 1);
    assert.deepEqual(seen, ['resolveAnomalies', 'recoverWhenLowHp', 'action.mining']);
    assert.equal(nav.options, previousOptions); assertReleased(host);
  }
});

test('source segment retries skip completed actions before the resume point but replay combat scripts', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host), actions = [], movements = [], lifecycle = [];
  const task = parsePathingTask({ positions: [
    { x: 1, action: 'mining' }, { x: 2, action: 'combat_script' }, { x: 3, action: 'fight' },
  ] }, { geometry });
  host.navigation = async operation => { lifecycle.push(operation); return operation === 'prepareRoute' ? { ready: true } : {}; };
  nav.returnMainUi = async () => {}; nav.action = async point => actions.push(point.action);
  nav.moveTo = async point => {
    movements.push(point.gameX);
    if (movements.length === 3) throw Object.assign(new Error('Stuck'), { code: 'PATH_RETRY' });
  };
  const result = await nav.execute(task);
  assert.deepEqual(movements, [1, 2, 3, 1, 2, 3]);
  assert.deepEqual(actions, ['mining', 'combat_script', 'combat_script', 'fight']);
  assert.equal(result.completed, 3); assert.equal(result.segmentAttempts, 2);
  assert.equal(lifecycle[0], 'prepareRoute'); assert.equal(lifecycle[1], 'beginRoute');
  assert.equal(lifecycle.filter(op => op === 'resolveAnomalies').length, 2);
  assert.equal(lifecycle.at(-1), 'endRoute'); assertReleased(host);
});

test('segment exhaustion rejects completion, noncount retries remain linked and next teleport retains original delay', async () => {
  const host = fakeHost(), nav = new NavigationTasks(host);
  const task = parsePathingTask({ config: { realtime_triggers: {} }, positions: [{ x: 1 }] }, { geometry });
  nav.returnMainUi = async () => {}; let moves = 0;
  nav.moveTo = async () => { moves++; throw Object.assign(new Error('Retry exhausted'), { code: 'PATH_RETRY' }); };
  await assert.rejects(nav.execute(task, { manageParty: false }), /Retry exhausted/); assert.equal(moves, 2); assertReleased(host);
  moves = 0;
  nav.moveTo = async () => { moves++; if (moves === 1) throw Object.assign(new Error('Suspended'), { code: 'PATH_RETRY_NO_COUNT' }); };
  let result = await nav.execute(task, { manageParty: false }); assert.equal(moves, 2); assert.equal(result.segmentAttempts, 2);
  const timed = parsePathingTask({ config: { realtime_triggers: {} }, positions: [{ x: 1 }, { x: 2, type: 'teleport' }] }, { geometry });
  const started = host.now(); nav.teleport = async () => { assert.equal(host.now() - started, 1000); };
  result = await nav.execute(timed, { manageParty: false });
  assert.equal(host.now() - started, 1500); assert.equal(result.completed, 2); assertReleased(host);
});
