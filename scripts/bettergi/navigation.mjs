import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { NativeTasks, UnsupportedNativeOperation, loadAvatarCatalog, loadMapCoordinates,
  parseCombatScript, executeCombatScript, targetOrientation, waypointDistance } from './native.mjs';

const taskRoot = 'BetterGenshinImpact/GameTask';
const maps = ['Teyvat', 'TheChasm', 'Enkanomiya', 'SeaOfBygoneEras', 'AncientSacredMountain', 'TempleOfSpace', 'MoonCanon'];
const waypointTypes = new Set(['teleport', 'path', 'target', 'orientation']);
const moveModes = new Set(['walk', 'run', 'fly', 'jump', 'dash', 'climb', 'swim']);
export const PATHING_ACTIONS = Object.freeze(['stop_flying', 'force_tp', 'nahida_collect', 'pick_around', 'fight',
  'up_down_grab_leaf', 'hydro_collect', 'electro_collect', 'anemo_collect', 'pyro_collect', 'combat_script',
  'mining', 'linnea_mining', 'log_output', 'fishing', 'exit_and_relogin', 'wonderland_cycle', 'set_time',
  'use_gadget', 'pick_up_collect']);
const icons = ['TeleportWaypoint', 'StatueOfTheSeven', 'Domain', 'Domain2', 'ObsidianTotemPole',
  'PortableWaypoint', 'Mansion', 'SubSpaceWaypoint', 'NodKraiMeetingPoint', 'TabletOfTona', 'MarkTransPointMoonTower'];
const object = value => value != null && !Array.isArray(value) && typeof value === 'object';
const exists = region => region != null && region.width > 0 && region.height > 0;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const now = host => host.now?.() ?? performance.now();
const check = host => host.signal?.throwIfAborted();
const roundEven = value => { const n = Math.floor(value); return value - n === 0.5 ? (n % 2 ? n + 1 : n) : Math.round(value); };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function input(host, method, args = []) { check(host); return host.input(method, args); }
async function released(host, body) {
  let failure;
  try { return await body(); } catch (error) { failure = error; throw error; }
  finally {
    try { await host.input('releaseAll', []); }
    catch (error) { if (!failure) throw error; host.log?.('error', `Navigation input release failed: ${error.message}`); }
  }
}

// PathRecorder.JsonOptions: comments and trailing commas; quoted strings remain unchanged.
function routeJson(source) {
  if (typeof source !== 'string') return structuredClone(source);
  let clean = '', quoted = false, escaped = false, line = false, block = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === '\n') { line = false; clean += c; } continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quoted) { clean += c; if (!escaped && c === '"') quoted = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') { quoted = true; clean += c; }
    else if (c === '/' && next === '/') { line = true; i++; clean += ' '; }
    else if (c === '/' && next === '*') { block = true; i++; clean += ' '; }
    else clean += c;
  }
  let result = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) { result += c; if (!escaped && c === '"') quoted = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
    result += c;
  }
  return JSON.parse(result.replace(/^\uFEFF/, ''));
}
function defaults(value, base, label) {
  if (value === undefined) return structuredClone(base);
  if (!object(value)) throw new TypeError(`${label} requires an object`);
  return { ...structuredClone(base), ...value };
}

// Core/Script/Utils/JsonMerger.cs. Arrays replace unless explicitly listed in _arr_add.
export function mergePathingControl(original, control, name) {
  const target = structuredClone(original);
  const merge = (to, from) => {
    const skipped = new Set();
    if (Array.isArray(from._obj_cover)) {
      skipped.add('_obj_cover');
      for (const key of from._obj_cover) if (Object.hasOwn(from, key)) { to[key] = structuredClone(from[key]); skipped.add(key); }
    }
    if (Array.isArray(from._arr_add)) {
      skipped.add('_arr_add');
      for (const key of from._arr_add) if (Array.isArray(from[key])) {
        const seen = new Set();
        to[key] = [...(Array.isArray(to[key]) ? to[key] : []), ...from[key]].filter(item => {
          const encoded = JSON.stringify(item); if (seen.has(encoded)) return false; seen.add(encoded); return true;
        }).map(item => structuredClone(item));
        skipped.add(key);
      }
    }
    for (const [key, value] of Object.entries(from)) {
      if (skipped.has(key)) continue;
      if (object(value) && object(to[key])) merge(to[key], value);
      else to[key] = structuredClone(value);
    }
  };
  if (object(control.global_cover)) merge(target, control.global_cover);
  const item = control.json_list?.find(item => item.name === name);
  if (object(item?.cover)) merge(target, item.cover);
  return target;
}

export function parsePathingTask(source, { defaultMatchingMethod = 'TemplateMatch', geometry, aliases } = {}) {
  const raw = routeJson(source);
  if (!object(raw)) throw new TypeError('PathingTask requires an object');
  const diagnostics = [];
  const info = defaults(raw.info, { name: '', description: null, author: null, version: null, bgi_version: null,
    type: '', order: 0, tags: [], enable_monster_loot_split: false, map_name: 'Teyvat',
    map_match_method: defaultMatchingMethod, items: [] }, 'info');
  const mapName = maps.find(name => name.toLowerCase() === String(info.map_name).toLowerCase());
  if (!mapName) throw new UnsupportedNativeOperation(`map.coordinates.${info.map_name}`);
  const configured = info.map_match_method || defaultMatchingMethod;
  // MapManager chooses SIFT only on exact equality; the remaining four scenes always use SIFT.
  const matchingMethod = configured === 'SIFT' || !['Teyvat', 'TheChasm', 'Enkanomiya'].includes(mapName) ? 'SIFT' : 'TemplateMatch';
  if (!['SIFT', 'TemplateMatch', '', null].includes(info.map_match_method)) diagnostics.push({
    kind: 'map_match_method', value: info.map_match_method, upstreamBehavior: matchingMethod,
    message: 'Original MapManager treats every non-SIFT value as the default map implementation',
  });
  const config = defaults(raw.config, { realtime_triggers: { AutoPick: true } }, 'config');
  if (!object(config.realtime_triggers) || Object.values(config.realtime_triggers).some(value => typeof value !== 'boolean')) throw new TypeError('realtime_triggers requires boolean values');
  const farmingInfo = defaults(raw.farming_info, { allow_farming_count: false, normal_mob_count: 0, elite_mob_count: 0,
    primary_target: '', duration_seconds: 0, elite_details: '', total_mora: 0 }, 'farming_info');
  if (raw.positions !== undefined && !Array.isArray(raw.positions)) throw new TypeError('positions requires an array');
  const positions = (raw.positions ?? []).map((value, index) => {
    const point = defaults(value, { x: 0, y: 0, type: 'path', move_mode: 'walk', action: null, action_params: null, items: [] }, `positions[${index}]`);
    finite(point.x, `positions[${index}].x`); finite(point.y, `positions[${index}].y`);
    if (!waypointTypes.has(point.type)) throw new TypeError(`Unknown waypoint type ${point.type} at ${index}`);
    if (!moveModes.has(point.move_mode)) throw new TypeError(`Unknown move mode ${point.move_mode} at ${index}`);
    if (point.action != null && typeof point.action !== 'string') throw new TypeError(`Invalid action at ${index}`);
    if (point.action_params != null && typeof point.action_params !== 'string') throw new TypeError(`Invalid action_params at ${index}`);
    if (point.action && !PATHING_ACTIONS.includes(point.action)) diagnostics.push({ kind: 'unknown_action', index, action: point.action });
    point.point_ext_params = defaults(point.point_ext_params, { description: '', monster_tag: null, enable_monster_loot_split: false }, 'point_ext_params');
    point.point_ext_params.misidentification = defaults(point.point_ext_params.misidentification, { type: ['unrecognized'], handling_mode: 'previousDetectedPoint', arrival_time: 0 }, 'misidentification');
    if (!Array.isArray(point.point_ext_params.misidentification.type)) throw new TypeError(`Invalid misidentification.type at ${index}`);
    point.gameX = point.x; point.gameY = point.y; point.mapName = mapName; point.matchingMethod = matchingMethod;
    point.isTarget = point.type === 'target' && point.action !== 'up_down_grab_leaf';
    if (geometry) {
      const converted = geometry.gameToImage({ x: Math.fround(point.x), y: Math.fround(point.y) });
      point.x = converted.x; point.y = converted.y; point.matX = point.x; point.matY = point.y;
    }
    if (point.action === 'combat_script' && point.action_params != null && aliases) point.combatScript = parseCombatScript(point.action_params, { aliases, validate: false });
    return point;
  });
  const segments = []; let segment = [];
  for (const point of positions) {
    if (point.type === 'teleport' && segment.length) { segments.push(segment); segment = []; }
    segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return { info, config, farming_info: farmingInfo, positions, segments, mapName, matchingMethod,
    coordinates: geometry ? 'map-image' : 'game', diagnostics, raw };
}

async function readControl(filename, visited = new Set(), readSource = filename => readFile(filename, 'utf8')) {
  filename = path.resolve(filename);
  let source;
  try { source = await readSource(filename); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code !== 'EISDIR') throw error;
    filename = path.join(filename, 'control.json5');
    source = await readSource(filename);
  }
  if (visited.has(filename)) throw new Error(`control.json5 reference cycle: ${filename}`);
  visited.add(filename);
  const value = routeJson(source);
  return value.ref ? readControl(path.resolve(path.dirname(filename), value.ref), visited, readSource) : value;
}
const resources = new Map();
async function routeResources(sourceRoot) {
  if (!resources.has(sourceRoot)) resources.set(sourceRoot, (async () => ({
    geometries: Object.fromEntries(await Promise.all(maps.map(async name => [name, await loadMapCoordinates(sourceRoot, name)]))),
    aliases: (await loadAvatarCatalog(sourceRoot)).aliases,
    version: (await readFile(path.join(sourceRoot, 'BetterGenshinImpact/BetterGenshinImpact.csproj'), 'utf8')).match(new RegExp('<Version>([^<]+)</Version>'))?.[1],
  }))());
  return resources.get(sourceRoot);
}
function newerVersion(oldVersion, newVersion) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value ?? '');
  const a = parse(oldVersion), b = parse(newVersion);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +b[i] > +a[i];
  if (a[4] !== b[4]) {
    if (!a[4]) return false; if (!b[4]) return true;
    const left = a[4].split('.'), right = b[4].split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i] === right[i]) continue;
      if (left[i] === undefined) return true; if (right[i] === undefined) return false;
      const ln = /^\d+$/.test(left[i]), rn = /^\d+$/.test(right[i]);
      if (ln && rn) return +right[i] > +left[i];
      if (ln !== rn) return ln;
      return right[i] > left[i];
    }
  }
  return (b[5] ?? '') > (a[5] ?? '');
}
export async function loadPathingTask(filename, { sourceRoot, readSource = filename => readFile(filename, 'utf8'), ...options } = {}) {
  if (!sourceRoot) throw new TypeError('sourceRoot is required to load original coordinate definitions');
  const original = routeJson(await readSource(filename));
  let merged = original, controlError;
  try {
    const control = await readControl(path.join(path.dirname(filename), 'control.json5'), new Set(), readSource);
    if (control) merged = mergePathingControl(original, control, path.basename(filename, path.extname(filename)));
  } catch (error) { controlError = error.message; }
  const { geometries, aliases, version } = await routeResources(sourceRoot);
  const mapName = maps.find(name => name.toLowerCase() === (merged.info?.map_name ?? 'Teyvat').toLowerCase());
  const task = parsePathingTask(merged, { ...options, geometry: geometries[mapName], aliases });
  if (newerVersion(version, task.info.bgi_version)) throw new Error(`Route requires BetterGI ${task.info.bgi_version}; imported source is ${version}`);
  task.filename = path.basename(filename); task.fullPath = path.resolve(filename);
  for (const point of task.positions) point.point_ext_params.enable_monster_loot_split = task.info.enable_monster_loot_split;
  if (controlError) task.diagnostics.push({ kind: 'control_merge_failed', message: controlError, fallback: 'unmerged original' });
  return task;
}
export async function auditPathingCorpus(root, options) {
  const report = { routes: 0, waypoints: 0, maps: {}, matchingMethods: {}, types: {}, moveModes: {}, actions: {}, diagnostics: [], failures: [] };
  const count = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
  const walk = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(filename); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const task = await loadPathingTask(filename, options);
        report.routes++; report.waypoints += task.positions.length; count(report.maps, task.mapName); count(report.matchingMethods, task.matchingMethod);
        for (const p of task.positions) { count(report.types, p.type); count(report.moveModes, p.move_mode); count(report.actions, p.action ?? 'null'); }
        report.diagnostics.push(...task.diagnostics.map(item => ({ filename: path.relative(root, filename), ...item })));
      } catch (error) { report.failures.push({ filename: path.relative(root, filename), message: error.message }); }
    }
  };
  await walk(root); return report;
}

export async function loadTeleportCatalog(sourceRoot) {
  const raw = JSON.parse(await readFile(path.join(sourceRoot, taskRoot, 'AutoTrackPath/Assets/tp.json'), 'utf8'));
  const scenes = new Map(raw.data.map(scene => [scene.mapName, { ...scene, points: scene.points.map(point => ({
    ...point, id: String(point.id), x: point.position[2], y: point.position[0], height: point.position[1],
    tranX: point.tranPosition?.[2] ?? point.position[2], tranY: point.tranPosition?.[0] ?? point.position[0],
  })) }]));
  const source = await readFile(path.join(sourceRoot, taskRoot, 'Common/Element/Assets/MapLazyAssets.cs'), 'utf8');
  const countries = new Map([...source.matchAll(/\{\s*"([^"]+)",\s*\[(-?[\d.]+),\s*(-?[\d.]+)\]\s*\}/g)].map(match => [match[1], { x: +match[2], y: +match[3] }]));
  if (countries.size !== 8 || scenes.size !== 7) throw new Error('Original teleport scene/country definitions changed');
  return { version: raw.version, language: raw.language, scenes, countries };
}
export function resolveTeleportTarget(catalog, x, y, mapName = 'Teyvat', force = false) {
  finite(x, 'x'); finite(y, 'y');
  const scene = catalog.scenes.get(mapName);
  if (!scene || scene.points.length < 2) throw new UnsupportedNativeOperation(`teleport.catalog.${mapName}`);
  const [target, neighbor] = [...scene.points].sort((a, b) => distance(a, { x, y }) - distance(b, { x, y }));
  const separation = distance(target, neighbor);
  return { mapName, force, request: { x, y }, target, neighbor, x: force ? x : target.x, y: force ? y : target.y,
    country: force ? null : target.country, distanceToNear: separation, finalZoom: clamp(separation / 36, 1, mapName === 'MoonCanon' ? 3 : 4.4) };
}

// AutoPathing/CameraRotateTask.cs. Positive mouse delta rotates the camera clockwise.
export function cameraRotation(current, target, dpi = 1) {
  finite(current, 'camera angle'); finite(target, 'target angle'); finite(dpi, 'dpi');
  if (dpi <= 0) throw new RangeError('dpi must be positive');
  let diff = (current - target + 180) % 360 - 180;
  if (diff < -180) diff += 360;
  const magnitude = Math.abs(diff), ratio = magnitude > 90 ? 4 : magnitude > 30 ? 3 : magnitude > 5 ? 2 : 1;
  return { diff, dx: roundEven(-ratio * diff * dpi) };
}

export function mapMoveState(center, target, zoom) {
  finite(center.x, 'map center x'); finite(center.y, 'map center y');
  finite(target.x, 'map target x'); finite(target.y, 'map target y'); finite(zoom, 'map zoom');
  if (zoom <= 0) throw new RangeError('map zoom must be positive');
  const dx = 2.361 * (target.x - center.x) / zoom, dy = 2.361 * (target.y - center.y) / zoom;
  return { center, dx, dy, distance: Math.hypot(dx, dy) };
}
export function isMapMoveRecognitionAnomaly(center, predicted, actual) {
  const expected = { x: predicted.x - center.x, y: predicted.y - center.y }, observed = { x: actual.x - center.x, y: actual.y - center.y };
  const expectedLength = Math.hypot(expected.x, expected.y), actualLength = Math.hypot(observed.x, observed.y);
  const ratio = expectedLength > 0 ? actualLength / expectedLength : 0;
  const cosine = expectedLength <= 1 || actualLength <= 1 ? 1 : (expected.x * observed.x + expected.y * observed.y) / (expectedLength * actualLength);
  return distance(predicted, actual) > Math.max(200, expectedLength * 2)
    || (expectedLength > 1200 && (ratio < 0.55 || ratio > 1.85))
    || (expectedLength > 1200 && actualLength > 120 && cosine < 0.65);
}
export function mapRecognitionRecoveryZoom(current, mapName = 'Teyvat', tolerance = 0.06375) {
  current = clamp(finite(current, 'map zoom'), 1, 6);
  const display = mapName === 'MoonCanon' ? 3 : 4.4;
  if (Math.abs(current - display) <= tolerance) return current >= 3.5 ? Math.max(1, current - 1) : Math.min(6, current + 1);
  return current < display ? Math.min(display, current + 1) : Math.max(display, current - 1);
}

// TpTask.GenerateSteps: fast first 42% covers 85% of distance, then cosine deceleration.
export function generateMapDragSteps(delta, steps) {
  if (!Number.isInteger(delta) || !Number.isInteger(steps) || steps < 1) throw new TypeError('Map drag requires integer delta and positive steps');
  if (steps === 1) return [delta];
  const distribute = (value, count, weight) => {
    const weights = Array.from({ length: count }, (_, i) => Math.max(0.001, weight(i)));
    const sum = weights.reduce((a, b) => a + b, 0), result = weights.map(w => Math.trunc(value * w / sum));
    const remaining = value - result.reduce((a, b) => a + b, 0);
    for (let i = 0; i < Math.abs(remaining); i++) result[i % count] += Math.sign(remaining);
    return result;
  };
  const fast = clamp(Math.ceil(steps * 0.42), 1, steps), slow = steps - fast;
  if (!slow) return distribute(delta, steps, () => 1);
  const fastDelta = roundEven(delta * 0.85);
  return [...distribute(fastDelta, fast, () => 1), ...distribute(delta - fastDelta, slow, i => 0.2 + 0.8 * Math.cos((slow <= 1 ? 1 : i / (slow - 1)) * Math.PI / 2))];
}

function iconType(icon) {
  return ({ StatueOfTheSeven: 'Goddess', Domain2: 'Domain', ObsidianTotemPole: 'NatlanObsidianTotemPole', MarkTransPointMoonTower: 'TeleportWaypoint' })[icon] ?? icon;
}
function iconCompatible(icon, targetType) { return icon === 'Domain' ? ['OneTimeDomain', 'BlessDomain', 'ForgeryDomain', 'MasteryDomain', 'TrounceDomain'].includes(targetType) : icon === targetType; }
function assignment(costs) {
  // Rectangular Hungarian minimum-cost assignment, with a private dummy for every expected icon.
  const rows = costs.length, columns = costs[0]?.length ?? 0;
  const u = Array(rows + 1).fill(0), v = Array(columns + 1).fill(0), p = Array(columns + 1).fill(0), way = Array(columns + 1).fill(0);
  for (let row = 1; row <= rows; row++) {
    p[0] = row; let j0 = 0;
    const min = Array(columns + 1).fill(Infinity), used = Array(columns + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= columns; j++) if (!used[j]) {
        const cur = costs[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < min[j]) { min[j] = cur; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= columns; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      j0 = j1;
    } while (p[j0]);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = Array(rows).fill(-1);
  for (let j = 1; j <= columns; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}
export function estimateMapIconAlignment(expected, observed, scale = 1) {
  const compatible = (a, b) => a.types.some(type => b.types.includes(type));
  const assign = offset => {
    if (!expected.length || !observed.length) return [];
    const costs = expected.map(a => [...observed.map(b => {
      const error = Math.hypot(a.x + offset.x - b.x, a.y + offset.y - b.y);
      return compatible(a, b) && error <= 14 * scale ? Math.min(999999, roundEven(error * 1000)) : 10000000;
    }), ...expected.map(() => 1000000)]);
    return assignment(costs).flatMap((column, row) => column < observed.length && costs[row][column] < 1000000 ? [{
      expected: expected[row], observed: observed[column], error: Math.hypot(expected[row].x + offset.x - observed[column].x, expected[row].y + offset.y - observed[column].y),
    }] : []);
  };
  const make = offset => { const pairs = assign(offset); return { offset, pairs, meanError: pairs.length ? pairs.reduce((n, p) => n + p.error, 0) / pairs.length : 0 }; };
  const better = (a, b) => a.pairs.length !== b.pairs.length ? a.pairs.length > b.pairs.length : Math.abs(a.meanError - b.meanError) > 0.25 ? a.meanError < b.meanError : Math.hypot(a.offset.x, a.offset.y) < Math.hypot(b.offset.x, b.offset.y);
  const identity = make({ x: 0, y: 0 }); let best = identity;
  const buckets = new Map(), bucketSize = Math.max(1, 4 * scale);
  for (const a of expected) for (const b of observed) if (compatible(a, b)) {
    const x = b.x - a.x, y = b.y - a.y;
    if (Math.abs(x) > 60 * scale || Math.abs(y) > 60 * scale) continue;
    const key = `${roundEven(x / bucketSize)},${roundEven(y / bucketSize)}`;
    if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push({ x, y });
  }
  const meanLength = offsets => offsets.reduce((n, p) => n + Math.hypot(p.x, p.y), 0) / offsets.length;
  for (const offsets of [...buckets.values()].sort((a, b) => b.length - a.length || meanLength(a) - meanLength(b)).slice(0, 64)) {
    const candidate = make({ x: offsets.reduce((n, p) => n + p.x, 0) / offsets.length, y: offsets.reduce((n, p) => n + p.y, 0) / offsets.length });
    if (better(candidate, best)) best = candidate;
  }
  const correction = Math.hypot(best.offset.x, best.offset.y);
  if (!best.pairs.length || (best.pairs.length === 1 && correction > 8 * scale) || (best.pairs.length === 2 && correction > 10 * scale)) best = identity;
  else {
    const median = values => { values.sort((a, b) => a - b); const m = Math.floor(values.length / 2); return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2; };
    const refined = make({ x: median(best.pairs.map(p => p.observed.x - p.expected.x)), y: median(best.pairs.map(p => p.observed.y - p.expected.y)) });
    if (better(refined, best)) best = refined;
  }
  const count = best.pairs.length;
  return { ...best, uncertainty: count === 0 ? 16 * scale : count === 1 ? Math.max(10 * scale, best.meanError + 6 * scale) : count === 2 ? Math.max(7 * scale, best.meanError + 4 * scale) : Math.max(4 * scale, best.meanError + 3 * scale) };
}

function metrics(frame) { return { width: frame.width, height: frame.height, scale: Math.min(frame.width / 1920, 1) }; }
function clickable(point, frame, radius = 0) {
  const { width, height, scale } = metrics(frame), margin = 35 * scale + radius;
  return point.x >= margin && point.x <= width - margin && point.y >= margin && point.y <= height - margin && !(point.x < 360 * scale + radius && point.y < 430 * scale + radius);
}
function visibleRadius(nearest, frame) {
  const s = metrics(frame).scale;
  return Number.isFinite(nearest) && nearest > 0 ? clamp(nearest * 1.3, Math.max(120, 120 * s), Math.max(120, 260 * s)) : 0;
}
function project(point, rect, geometry, frame) {
  const p = geometry.gameToImage({ x: Math.fround(point.x), y: Math.fround(point.y) });
  return { x: (p.x - rect.x) / rect.width * frame.width, y: (p.y - rect.y) / rect.height * frame.height };
}
function cropRect(frame, x, y, width, height) {
  const left = clamp(Math.trunc(x), 0, frame.width), top = clamp(Math.trunc(y), 0, frame.height);
  return [left, top, Math.max(0, Math.min(frame.width, Math.trunc(x + width)) - left), Math.max(0, Math.min(frame.height, Math.trunc(y + height)) - top)];
}

export class NavigationTasks extends NativeTasks {
  constructor(host, options = {}) {
    super(host);
    this.options = { dpi: 1, frameInterval: 100, autoRun: true, teleportOperationDelay: 20, mapZoomEnabled: true,
      mapZoomOutDistance: 1000, mapZoomInDistance: 400, mapMoveTolerance: 200, mapMoveMaxIterations: 30, ...options };
    this.previous = null; this.lastMap = null; this.wheelPerNotch = 0.085;
    this.trapCount = 0;
    this.trapState = { lastActionAt: now(host), actionIndex: 0, randomAngle: 0 };
    this.gadgetLastUseAt = -Infinity; this.guardianLastUseAt = -Infinity;
  }
  async adapter(operation, args = {}) {
    check(this.host);
    if (typeof this.host.navigation !== 'function') throw new UnsupportedNativeOperation(`navigation.${operation}`);
    return this.host.navigation(operation, args);
  }
  async catalog() { return this._catalog ??= await loadTeleportCatalog(this.host.sourceRoot); }
  async geometry(mapName) { return (await routeResources(this.host.sourceRoot)).geometries[mapName]; }
  operationDelay(ms) { return Math.max(1, roundEven(ms * clamp(this.options.teleportOperationDelay, 2, 100) / 20)); }
  zoomClose(a, b) { return Math.abs(a - b) <= Math.max(0.05, this.wheelPerNotch * 0.75); }
  async isInBigMapUi(frame) {
    if (!frame) return this.captured(capture => this.isInBigMapUi(capture));
    return exists(await this.find(frame, 'QuickTeleport', 'MapScaleButton')) || exists(await this.find(frame, 'QuickTeleport', 'MapSettingsButton'));
  }
  async openMap(mapName = 'Teyvat', { retries = 3 } = {}) {
    let opens = 0;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await input(this.host, 'releaseAll'); await sleep(this.host, this.operationDelay(20));
        for (let checkAttempt = 0; checkAttempt < 2; checkAttempt++) {
          if (await this.isInBigMapUi()) return { verified: true, attempts: opens };
          await input(this.host, 'keyPress', ['M']); opens++; await sleep(this.host, 100);
          const start = now(this.host), limit = mapName === 'MoonCanon' ? 8000 : 5000;
          while (now(this.host) - start < limit) {
            if (await this.isInBigMapUi()) return { verified: true, attempts: opens };
            await sleep(this.host, 80);
          }
          if (checkAttempt === 0) { await this.returnMainUi(); await sleep(this.host, 500); }
        }
        throw new Error('BetterGI CheckInBigMapUi exhausted two open attempts');
      } catch (error) {
        check(this.host);
        if (error instanceof UnsupportedNativeOperation) throw error;
        if (retries > 1) await this.adapter('blessingOfTheWelkinMoon');
        if (attempt + 1 >= retries) throw error;
      }
    }
    throw new Error('BetterGI OpenBigMapUi has no attempts configured');
  }
  async ensureGroundLayer() {
    const start = now(this.host); let groundClicked = false, switchClicked = false;
    while (now(this.host) - start < 3000) {
      const result = await this.captured(async frame => ({ frame, ground: await this.find(frame, 'QuickTeleport', 'MapUndergroundToGroundButton'), underground: await this.find(frame, 'QuickTeleport', 'MapUndergroundSwitchButton') }));
      if (exists(result.ground) && !groundClicked) {
        await this.click(result.ground); groundClicked = true;
      } else if (groundClicked) {
        if (!exists(result.underground)) return { verified: true, clicked: true };
      } else if (exists(result.underground) && !switchClicked) {
        await this.click(result.underground); switchClicked = true;
      } else if (!switchClicked && !exists(result.ground) && !exists(result.underground) && now(this.host) - start >= 160) return { verified: true, clicked: false };
      await input(this.host, 'moveMouseTo', [result.frame.width / 2, result.frame.height / 2]);
      await sleep(this.host, 80);
    }
    throw new Error('BetterGI ground-map layer verification timed out');
  }
  async bigMapZoom(frame) {
    if (!frame) return this.captured(capture => this.bigMapZoom(capture));
    const slider = await this.find(frame, 'QuickTeleport', 'MapScaleButton');
    if (!exists(slider)) throw new Error('Cannot measure map zoom without original MapScaleButton');
    const scale = metrics(frame).scale, y1080 = (slider.y + slider.height / 2) / scale;
    return clamp(-5 * ((612 - y1080) / (612 - 468)) + 6, 1, 6);
  }
  async adjustMapZoom(target) {
    target = clamp(finite(target, 'map zoom'), 1, 6);
    let current = await this.bigMapZoom(), stalled = 0, batches = 0;
    while (Math.abs(current - target) > Math.max(0.05, this.wheelPerNotch * 0.75)) {
      if (++batches > 120) throw new Error('Map zoom adjustment exceeded bounded iterations');
      const before = current, diff = target - current, count = clamp(roundEven(Math.abs(diff) / Math.max(this.wheelPerNotch, 0.05)), 1, 16);
      const frame = await this.captured(capture => ({ width: capture.width, height: capture.height }));
      await input(this.host, 'moveMouseTo', [frame.width / 2, frame.height / 2]); await sleep(this.host, this.operationDelay(20));
      for (let i = 0; i < count; i++) { await input(this.host, 'verticalScroll', [-Math.sign(diff)]); if (i + 1 < count) await sleep(this.host, this.operationDelay(15)); }
      await sleep(this.host, Math.max(120, 90 + Math.min(120, count * 8)));
      current = await this.bigMapZoom();
      const delta = Math.abs(current - before);
      if (delta >= 0.025) this.wheelPerNotch = 0.7 * this.wheelPerNotch + 0.3 * delta / count;
      if (delta < 0.025 || Math.abs(target - current) >= Math.abs(diff) - 0.025) stalled++; else stalled = 0;
      if (stalled >= 2) break;
    }
    return { target, achieved: current, closeEnough: Math.abs(current - target) <= Math.max(0.05, this.wheelPerNotch * 0.75), batches };
  }
  async locateBigMap(mapName, frame) {
    if (!frame) {
      for (let retry = 0; retry < 5; retry++) {
        try { return await this.captured(capture => this.locateBigMap(mapName, capture)); }
        catch (error) { check(this.host); if (retry === 4 || error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; await sleep(this.host, 150); }
      }
    }
    if (!await this.isInBigMapUi(frame)) throw new Error('Big-map localization requires observed map UI');
    const result = await this.host.vision('map.locateBigMap', { handle: frame.handle, mapName, matchTarget: 'rect' });
    if (!result?.found || !result.rect || !(result.rect.width > 0 && result.rect.height > 0)) throw Object.assign(new Error(`Original big-map localization failed: ${mapName}`), { code: 'MAP_POSITION_NOT_RECOGNIZED' });
    return result;
  }
  async locateBigMapCenter(mapName, previous) {
    return this.captured(async frame => {
      if (!await this.isInBigMapUi(frame)) throw new Error('Big-map center recognition requires observed map UI');
      const prior = previous ? (await this.geometry(mapName)).gameToImage(previous) : undefined;
      const result = await this.host.vision('map.locateBigMap', { handle: frame.handle, mapName, matchTarget: 'position', previous: prior });
      if (!result?.found || !result.position) throw Object.assign(new Error(`Original big-map center recognition failed: ${mapName}`), { code: 'MAP_POSITION_NOT_RECOGNIZED' });
      return result.genshin ?? (await this.geometry(mapName)).imageToGame(result.position);
    });
  }
  async switchArea(area) {
    const normal = text => String(text).replace(/[\s"'“”‘’]/g, '').replaceAll('渊下宮', '渊下宫').replaceAll('蒙徳', '蒙德').replaceAll('娜塔', '纳塔');
    const regions = frame => this.host.vision('image.ocr', { handle: frame.handle, recognition: { roi: [Math.trunc(frame.width * 2 / 3), 0, Math.trunc(frame.width / 3), frame.height] } });
    const frame = await this.captured(capture => ({ width: capture.width, height: capture.height })), s = metrics(frame).scale;
    await input(this.host, 'click', [frame.width - 160 * s, frame.height - 60 * s]); await sleep(this.host, 50);
    const start = now(this.host);
    while (now(this.host) - start < 1500) {
      const matches = await this.captured(async capture => (await regions(capture)).filter(r => normal(r.text) === normal(area)).sort((a, b) => b.y - a.y));
      if (matches.length) {
        await this.click(matches[0]); await sleep(this.host, 50);
        const center = (await this.catalog()).countries.get(area);
        if (center) this.areaSwitchCenter = { mapName: 'Teyvat', position: { x: Math.fround(center.x), y: Math.fround(center.y) } };
        const applied = now(this.host); let missing = 0;
        while (now(this.host) - applied < 600) {
          const visible = await this.captured(async capture => (await regions(capture)).some(r => normal(r.text) === normal(area)));
          missing = !visible && now(this.host) - applied >= 120 ? missing + 1 : 0;
          if (missing >= 2) return { selected: area, selectionDismissed: true };
          await sleep(this.host, 80);
        }
        this.host.log?.('debug', `Original area selection animation wait reached limit: ${area}`);
        return { selected: area, selectionDismissed: false };
      }
      await sleep(this.host, 80);
    }
    throw new Error(`Original map area OCR did not find ${area}`);
  }
  async switchTargetArea(target) {
    const catalog = await this.catalog();
    if (target.mapName !== 'Teyvat') {
      if (this.lastMap !== target.mapName) await this.switchArea(catalog.scenes.get(target.mapName).description);
      return;
    }
    if (target.country && this.lastMap && this.lastMap !== 'Teyvat') {
      await this.switchArea(target.country); return;
    }
    let center;
    try { center = await this.locateBigMapCenter('Teyvat'); } catch (error) { check(this.host); this.host.log?.('debug', error.message); }
    let best = center ? distance(target, center) : Infinity, country;
    if (best < 50 && this.lastMap !== 'MoonCanon') return;
    for (const [name, point] of catalog.countries) {
      const d = distance(target, point); if (d < best) { best = d; country = name; }
    }
    if (country) await this.switchArea(target.country ?? country);
  }
  async dragMap(dx, dy, frame) {
    return released(this.host, async () => {
      if (!frame) frame = await this.captured(capture => ({ width: capture.width, height: capture.height }));
      const { width, height, scale: s } = metrics(frame), edge = 115 * s;
      const minX = edge, maxX = width - edge, minY = edge, maxY = height - edge;
      let ratio = Math.min(1, dx ? (maxX - minX) / Math.abs(dx * s) : 1, dy ? (maxY - minY) / Math.abs(dy * s) : 1), selected;
      const safe = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY && !(x < 360 * s && y < 430 * s);
      for (let attempt = 0; attempt < 12; attempt++) {
        const xDelta = Math.trunc(dx * ratio), yDelta = Math.trunc(dy * ratio), ax = xDelta * s, ay = yDelta * s;
        const x0 = Math.max(minX, minX - ax), x1 = Math.min(maxX, maxX - ax), y0 = Math.max(minY, minY - ay), y1 = Math.min(maxY, maxY - ay);
        if (x0 <= x1 && y0 <= y1) {
          const random = this.host.random ?? Math.random;
          const preferred = { x: width / 2 - ax / 2 + (random() - 0.5) * width / 12, y: height / 2 - ay / 2 + (random() - 0.5) * height / 12 };
          const pad = Math.max(4, 6 * s), xs = [preferred.x, x0, x1, 360 * s + pad, 360 * s + pad - ax], ys = [preferred.y, y0, y1, 430 * s + pad, 430 * s + pad - ay];
          const candidates = xs.flatMap(x => ys.map(y => ({ x: clamp(x, x0, x1), y: clamp(y, y0, y1) }))).filter(p => safe(p.x, p.y) && safe(p.x + ax, p.y + ay)).sort((a, b) => distance(a, preferred) - distance(b, preferred));
          if (candidates.length) { selected = { ...candidates[0], dx: xDelta, dy: yDelta }; break; }
        }
        ratio *= 0.85;
      }
      if (!selected) throw new Error('No safe original map drag start/end pair');
      const length = Math.hypot(selected.dx, selected.dy), steps = length ? clamp(Math.ceil(length / 48), 5, 60) : 3;
      const xs = generateMapDragSteps(selected.dx, steps), ys = generateMapDragSteps(selected.dy, steps);
      await input(this.host, 'moveMouseTo', [selected.x, selected.y]); await input(this.host, 'leftButtonDown');
      try {
        let movedX = 0, movedY = 0;
        for (let i = 0; i < steps; i++) {
          await sleep(this.host, clamp(this.options.teleportOperationDelay, 2, 100)); movedX += xs[i]; movedY += ys[i];
          await input(this.host, 'moveMouseTo', [selected.x + movedX * s, selected.y + movedY * s]);
        }
        await sleep(this.host, 60);
      } finally { await this.host.input('leftButtonUp', []); }
      return { ...selected, steps, actualX: selected.dx * s, actualY: selected.dy * s };
    });
  }
  async evaluateView(target) {
    const geometry = await this.geometry(target.mapName), catalog = await this.catalog();
    const evaluate = () => this.captured(async frame => {
      const location = await this.locateBigMap(target.mapName, frame), zoom = await this.bigMapZoom(frame);
      const point = project(target, location.rect, geometry, frame);
      const neighbor = catalog.scenes.get(target.mapName).points.filter(tp => tp.id !== target.target?.id).sort((a, b) => distance(a, target) - distance(b, target))[0];
      const nearest = neighbor ? distance(project(neighbor, location.rect, geometry, frame), point) : NaN;
      const radius = visibleRadius(nearest, frame);
      return { frame: { width: frame.width, height: frame.height }, point, nearest, radius, location, zoom, safe: clickable(point, frame, radius) };
    });
    for (let retry = 0; retry < 5; retry++) {
      try { return await evaluate(); }
      catch (error) { check(this.host); if (retry === 4 || error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; await sleep(this.host, 150); }
    }
  }
  async recoverMapMoveCenter(target, zoom) {
    if (!this.options.mapZoomEnabled) return { center: null, zoom };
    const next = mapRecognitionRecoveryZoom(zoom, target.mapName, Math.max(0.05, this.wheelPerNotch * 0.75));
    if (this.zoomClose(zoom, next)) return { center: null, zoom };
    zoom = (await this.adjustMapZoom(next)).achieved;
    try { return { center: await this.locateBigMapCenter(target.mapName), zoom }; }
    catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; return { center: null, zoom }; }
  }
  async initialMapMoveState(target, zoom) {
    if (this.areaSwitchCenter?.mapName === target.mapName) {
      const center = this.areaSwitchCenter.position; this.areaSwitchCenter = null;
      return { state: mapMoveState(center, target, zoom), zoom };
    }
    try { return { state: mapMoveState(await this.locateBigMapCenter(target.mapName), target, zoom), zoom }; }
    catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
    let recovered = await this.recoverMapMoveCenter(target, zoom);
    if (recovered.center) return { state: mapMoveState(recovered.center, target, recovered.zoom), zoom: recovered.zoom };
    const catalog = await this.catalog();
    if (target.mapName === 'Teyvat') {
      const [area, center] = [...catalog.countries].sort((a, b) => distance(a[1], target) - distance(b[1], target))[0];
      await this.switchArea(area); this.areaSwitchCenter = null;
      return { state: mapMoveState({ x: Math.fround(center.x), y: Math.fround(center.y) }, target, recovered.zoom), zoom: recovered.zoom };
    }
    await this.switchArea(catalog.scenes.get(target.mapName).description);
    try { return { state: mapMoveState(await this.locateBigMapCenter(target.mapName), target, recovered.zoom), zoom: recovered.zoom }; }
    catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
    recovered = await this.recoverMapMoveCenter(target, recovered.zoom);
    if (recovered.center) return { state: mapMoveState(recovered.center, target, recovered.zoom), zoom: recovered.zoom };
    throw new Error('Original initial map recognition and zoom/area recovery all failed');
  }
  async moveMapToCore(target, { finalZoom = 1, allowZoom = false, requiredVisibleRadius = 0 } = {}) {
    const minimumZoom = clamp(finalZoom, 1, 6), initial = await this.initialMapMoveState(target, await this.bigMapZoom());
    let { state, zoom } = initial, failures = 0;
    const rescale = next => { state = mapMoveState(state.center, target, next); zoom = next; };
    if (allowZoom && this.options.mapZoomEnabled && state.distance > this.options.mapZoomOutDistance) {
      rescale((await this.adjustMapZoom(Math.min(6, zoom * state.distance / this.options.mapZoomOutDistance))).achieved);
    }
    for (let iteration = 0; iteration < this.options.mapMoveMaxIterations; iteration++) {
      let view;
      try { view = await this.evaluateView(target); }
      catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
      if (view && clickable(view.point, view.frame, requiredVisibleRadius)) {
        if (allowZoom && this.options.mapZoomEnabled && zoom > minimumZoom + 0.05) {
          rescale((await this.adjustMapZoom(minimumZoom)).achieved);
          try { state = mapMoveState(await this.locateBigMapCenter(target.mapName), target, zoom); failures = 0; }
          catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
          try { view = await this.evaluateView(target); }
          catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; view = null; }
          if (!view || !clickable(view.point, view.frame, requiredVisibleRadius)) continue;
        }
        return { safe: true, iterations: iteration, view };
      }
      if (allowZoom && this.options.mapZoomEnabled && state.distance < this.options.mapZoomInDistance && zoom > minimumZoom + 0.05) {
        rescale((await this.adjustMapZoom(Math.max(minimumZoom, zoom * state.distance / this.options.mapZoomInDistance))).achieved);
      }
      if (state.distance < this.options.mapMoveTolerance) {
        if (requiredVisibleRadius <= 0 || !view) return { safe: false, iterations: iteration, reason: 'source move tolerance' };
        // Source recenters the target when the visible icon-pattern radius still intersects map UI.
        const rect = view.location.rect, center = (await this.geometry(target.mapName)).imageToGame({ x: Math.fround(rect.x + rect.width / 2), y: Math.fround(rect.y + rect.height / 2) });
        state = mapMoveState(center, target, zoom);
        if (state.distance < 3) return { safe: false, iterations: iteration, reason: 'source center tolerance' };
      }
      const drag = await this.dragMap(roundEven(state.dx), roundEven(state.dy), view?.frame);
      await sleep(this.host, 30);
      const predicted = { x: Math.fround(state.center.x + Math.fround(drag.dx * zoom / 2.361)), y: Math.fround(state.center.y + Math.fround(drag.dy * zoom / 2.361)) };
      let center;
      try {
        center = await this.locateBigMapCenter(target.mapName, predicted);
        if (isMapMoveRecognitionAnomaly(state.center, predicted, center)) throw Object.assign(new Error('Original map-center recognition jumped after drag'), { code: 'MAP_POSITION_NOT_RECOGNIZED' });
        failures = 0;
      } catch (error) {
        check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error;
        if (++failures > 5) throw new Error('Original map inertial prediction exhausted five recognition failures');
        center = predicted;
      }
      state = mapMoveState(center, target, zoom);
    }
    return { safe: false, iterations: this.options.mapMoveMaxIterations, reason: 'source map iteration limit' };
  }
  async prepareTeleportView(target) {
    let moveZoomAdjusted = false, stopAtDisplayZoom = false;
    const display = target.mapName === 'MoonCanon' ? 3 : 4.4, finalZoom = clamp(target.finalZoom, 1, display);
    for (let retry = 0; retry <= 5; retry++) {
      let view;
      try { view = await this.evaluateView(target); }
      catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
      if (view?.safe) {
        const needsZoom = this.options.mapZoomEnabled && (view.zoom > display + 0.05
          || (Number.isFinite(view.nearest) && view.nearest > 0 && view.nearest < 96 * metrics(view.frame).scale && view.zoom > finalZoom + 0.05 && !this.zoomClose(view.zoom, finalZoom)));
        if (stopAtDisplayZoom || !needsZoom) return view;
        const factor = view.zoom / finalZoom, predicted = { x: view.frame.width / 2 + (view.point.x - view.frame.width / 2) * factor, y: view.frame.height / 2 + (view.point.y - view.frame.height / 2) * factor };
        const radius = Number.isFinite(view.nearest) && view.nearest > 0 ? visibleRadius(view.nearest * factor, view.frame) : view.radius;
        if (!clickable(predicted, view.frame, radius)) {
          const s = metrics(view.frame).scale, dx = roundEven(view.frame.width / 2 - view.point.x), dy = roundEven(view.frame.height / 2 - view.point.y);
          if (Math.abs(dx) >= 3 || Math.abs(dy) >= 3) await this.dragMap(Math.trunc(dx / s), Math.trunc(dy / s), view.frame);
          await sleep(this.host, 80); continue;
        }
        const result = await this.adjustMapZoom(finalZoom);
        if (!result.closeEnough) {
          if (result.achieved > display + 0.05) throw Object.assign(new Error('Map zoom never reached teleport-icon display level'), { code: 'TP_POINT_NOT_ACTIVATE' });
          stopAtDisplayZoom = true;
        }
        continue;
      }
      if (retry >= 5) break;
      if (!moveZoomAdjusted) {
        moveZoomAdjusted = true;
        if (this.options.mapZoomEnabled) {
          const zoom = view?.zoom ?? await this.bigMapZoom();
          let center = this.areaSwitchCenter?.mapName === target.mapName ? this.areaSwitchCenter.position : null;
          if (!center) {
            try { center = await this.locateBigMapCenter(target.mapName); }
            catch (error) { check(this.host); if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; }
          }
          if (center) {
            const d = mapMoveState(center, target, zoom).distance, desired = d > this.options.mapZoomOutDistance ? clamp(zoom * d / this.options.mapZoomOutDistance, 1, 6) : zoom;
            if (!this.zoomClose(zoom, desired)) { await this.adjustMapZoom(desired); continue; }
          }
        }
      }
      await this.moveMapToCore(target, { requiredVisibleRadius: view?.radius ?? 0 });
      await sleep(this.host, 80);
    }
    throw new Error('Target teleport point did not enter the original safe clickable map region');
  }
  async iconRecognition(frame, icon, roi, threshold) {
    return { type: 'TemplateMatch', template_path: path.join(this.host.sourceRoot, taskRoot, 'QuickTeleport/Assets/1920x1080', `${icon}.png`),
      template_scale: metrics(frame).scale, roi, threshold, name: icon };
  }
  async alignedTeleportPoint(target, view) {
    const geometry = await this.geometry(target.mapName), catalog = await this.catalog(), expected = [];
    for (const tp of catalog.scenes.get(target.mapName).points) {
      const types = [...new Set(icons.map(iconType).filter(type => iconCompatible(type, tp.type)))];
      if (!types.length) continue;
      const point = project(tp, view.location.rect, geometry, view.frame);
      if (clickable(point, view.frame)) expected.push({ ...point, types });
    }
    return this.captured(async frame => {
      const allowed = new Set(expected.flatMap(p => p.types)), observed = [];
      for (const icon of icons) if (allowed.has(iconType(icon))) {
        const matches = await this.host.vision('image.findMulti', { handle: frame.handle, recognition: await this.iconRecognition(frame, icon, [0, 0, frame.width, frame.height], 0.65) });
        for (const match of matches) {
          const point = { x: match.x + match.width / 2, y: match.y + match.height / 2, types: [iconType(icon)] };
          if (!clickable(point, frame)) continue;
          const duplicate = observed.find(p => distance(p, point) <= 18);
          if (duplicate) {
            if (!duplicate.types.includes(point.types[0])) duplicate.types.push(point.types[0]);
            if (distance(point, view.point) < distance(duplicate, view.point)) { duplicate.x = point.x; duplicate.y = point.y; }
          } else observed.push(point);
        }
      }
      observed.sort((a, b) => a.y - b.y || a.x - b.x);
      const s = metrics(frame).scale, alignment = estimateMapIconAlignment(expected, observed, s);
      const point = { x: view.point.x + alignment.offset.x, y: view.point.y + alignment.offset.y };
      const allowedError = Number.isFinite(view.nearest) && view.nearest > 0 ? Math.max(8 * s, view.nearest * 0.25) : Infinity;
      if (!clickable(point, frame, view.radius)) throw Object.assign(new Error('Aligned teleport point lies outside the original safe clickable area'), { code: 'TP_POINT_NOT_ACTIVATE' });
      if (alignment.uncertainty > allowedError) throw Object.assign(new Error(`Original map click precision insufficient: ${alignment.uncertainty} > ${allowedError}`), { code: 'TP_POINT_NOT_ACTIVATE' });
      const correctionTooLarge = Math.hypot(alignment.offset.x, alignment.offset.y) > allowedError;
      return { point, alignment, correctionTooLarge, originalPoint: view.point };
    });
  }
  async panelCandidates(frame, target) {
    const s = metrics(frame).scale, candidates = [];
    const roi = cropRect(frame, 1270 * s, 100 * s, 50 * s, frame.height - 200 * s);
    for (const icon of icons) {
      const matches = await this.host.vision('image.findMulti', { handle: frame.handle, recognition: await this.iconRecognition(frame, icon, roi, this.options.hdr ? 0.7 : 0.8) });
      for (const match of matches.sort((a, b) => a.y - b.y)) {
        if (candidates.some(c => Math.abs(c.icon.x - match.x) <= 6 && Math.abs(c.icon.y - match.y) <= 6)) continue;
        const textRoi = cropRect(frame, match.x + match.width, match.y - 8, 220, match.height + 16);
        const text = (await this.host.vision('image.ocr', { handle: frame.handle, recognition: { type: 'ColorRangeAndOcr', roi: textRoi,
          ColorConversionCode: 'BGR2HLS', LowerColor: [0, 245, 0], UpperColor: [180, 255, 15] } })).map(r => r.text).join('').replace(/[>＞]/g, '').trim();
        if (text.length > 1) candidates.push({ icon: match, text, click: { x: textRoi[0], y: textRoi[1], width: textRoi[2], height: textRoi[3] } });
      }
    }
    const normalized = text => String(text ?? '').replace(/[\s\-－·]/g, '');
    const name = normalized(target.target.name);
    if (!candidates.length && name) {
      const rows = await this.host.vision('image.ocr', { handle: frame.handle, recognition: { roi: cropRect(frame, 1308 * s, 100 * s, 220 * s, frame.height - 200 * s) } });
      const matched = rows.filter(row => {
        const text = normalized(row.text);
        return text.length > 0 && row.text.length < 10 && (name.includes(text) || text.includes(name));
      });
      if (matched.length === 1) {
        for (const row of matched) {
          const rect = cropRect(frame, row.x - 12 * s, row.y - 8 * s, Math.max(220 * s, row.width + 24 * s), row.height + 16 * s);
          candidates.push({ icon: row, text: row.text, click: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } });
        }
      }
    }
    return candidates.sort((a, b) => a.icon.y - b.icon.y).map(candidate => ({ ...candidate, score: [...normalized(candidate.text)].filter(ch => name.includes(ch)).length })).sort((a, b) => b.score - a.score);
  }
  async confirmTeleportPanel(target, timeout = 900) {
    const configuredDelay = this.options.waitTeleportPanelDelay ?? 50;
    const limit = Math.max(timeout, 900, clamp(configuredDelay <= 0 ? 50 : configuredDelay, 50, 300) * 18);
    let candidateClicks = 0;
    const readState = (checkCandidates = true) => this.captured(async frame => {
        if (!await this.isInBigMapUi(frame)) return { leftMap: true };
        if (exists(await this.find(frame, 'QuickTeleport', 'TeleportButton'))) return { confirm: true };
        return { candidates: checkCandidates ? await this.panelCandidates(frame, target) : [] };
    });
    const confirmed = async state => {
      if (state.leftMap) return { confirmed: true, candidateClicks, leftMap: true };
      if (state.confirm) { await input(this.host, 'keyPress', ['F']); await sleep(this.host, 30); return { confirmed: true, candidateClicks, leftMap: false }; }
      return null;
    };
    const clickCandidate = async candidate => {
      await sleep(this.host, Math.max(200, this.options.teleportListClickDelay ?? 200));
      await this.click(candidate.click); candidateClicks++; await sleep(this.host, 150);
    };
    await sleep(this.host, Math.max(200, clamp(configuredDelay, 0, 500)));
    const start = now(this.host);
    for (let poll = 0; poll === 0 || now(this.host) - start < limit; poll++) {
      if (poll > 0) await sleep(this.host, 80);
      let state = await readState(), result = await confirmed(state);
      if (result) return result;
      if (!state.candidates?.length) continue;
      await clickCandidate(state.candidates[0]);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const waitStart = now(this.host); let nextVerify = 600;
        for (let i = 0; i === 0 || now(this.host) - waitStart < 5000; i++) {
          await sleep(this.host, 80);
          state = await readState(now(this.host) - waitStart >= nextVerify); result = await confirmed(state);
          if (result) return result;
          if (now(this.host) - waitStart >= nextVerify) {
            if (state.candidates?.length) break;
            nextVerify = now(this.host) - waitStart + 100;
          }
        }
        if (attempt >= 2) throw Object.assign(new Error('Original teleport candidate did not activate after two attempts'), { code: 'TELEPORT_PANEL_NOT_OPEN' });
        state = await readState();
        if (!state.candidates?.length) throw Object.assign(new Error('Original teleport candidate disappeared without an active TeleportButton'), { code: 'TELEPORT_PANEL_NOT_OPEN' });
        await clickCandidate(state.candidates[0]);
      }
    }
    throw Object.assign(new Error('Teleport panel never exposed an active original TeleportButton'), { code: 'TELEPORT_PANEL_NOT_OPEN' });
  }
  async waitTeleportComplete({ timeout = 60000 } = {}) {
    const start = now(this.host); let sawLoading = false, blessingAt = 1000;
    while (now(this.host) - start < timeout) {
      const state = await this.captured(async frame => ({ main: await this.isInMainUi(frame), map: await this.isInBigMapUi(frame) }));
      if (!state.main && !state.map) sawLoading = true;
      if (sawLoading && state.main && now(this.host) - start >= 1000) return { verified: true, sawLoading, elapsedMs: now(this.host) - start };
      await sleep(this.host, 100);
      if (sawLoading && !state.main && now(this.host) - start >= blessingAt) {
        await this.adapter('blessingOfTheWelkinMoon'); blessingAt = now(this.host) - start + 1000;
      }
    }
    throw new Error(`Teleport completion unverified: loadingObserved=${sawLoading}`);
  }
  async teleport(x, y, { mapName = 'Teyvat', force = false } = {}) {
    const originalHost = this.host, controller = new AbortController(), start = now(originalHost);
    const timeoutError = new Error('Single teleport exceeded original 60 second deadline');
    const timer = setTimeout(() => controller.abort(timeoutError), 60000); timer.unref?.();
    const scopedHost = Object.create(originalHost);
    scopedHost.signal = originalHost.signal ? AbortSignal.any([originalHost.signal, controller.signal]) : controller.signal;
    const verifyDeadline = () => {
      if (now(originalHost) - start >= 60000) controller.abort(timeoutError);
      scopedHost.signal.throwIfAborted();
    };
    for (const method of ['capture', 'vision', 'sleep', 'input', 'navigation']) {
      if (typeof originalHost[method] !== 'function') continue;
      scopedHost[method] = async (...args) => {
        const release = method === 'input' && /^(releaseall|keyup|(left|right|middle)buttonup)$/i.test(args[0]);
        const dispose = method === 'vision' && args[0] === 'image.dispose';
        if (!release && !dispose) verifyDeadline();
        const result = await originalHost[method].apply(scopedHost, args);
        if (!release && !dispose) {
          try { verifyDeadline(); }
          catch (error) {
            if (method === 'capture' && result?.handle) await originalHost.vision.call(scopedHost, 'image.dispose', { handle: result.handle });
            throw error;
          }
        }
        return result;
      };
    }
    const task = new NavigationTasks(scopedHost, this.options);
    task.lastMap = this.lastMap; task._catalog = this._catalog; task.wheelPerNotch = this.wheelPerNotch;
    let failure;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await task.teleportOnce(x, y, { mapName, force });
          this.lastMap = task.lastMap; this.previous = task.previous; this.wheelPerNotch = task.wheelPerNotch;
          return { ...result, attempts: attempt };
        } catch (error) {
          verifyDeadline();
          if (error instanceof UnsupportedNativeOperation) throw error;
          if (error.code === 'TELEPORT_PANEL_NOT_OPEN') { await input(scopedHost, 'keyPress', ['VK_ESCAPE']); await sleep(scopedHost, 300); throw error; }
          if (error.code === 'TP_POINT_NOT_ACTIVATE') await input(scopedHost, 'keyPress', ['VK_ESCAPE']);
          originalHost.log?.('warn', `Original teleport attempt ${attempt}/3 failed: ${error.message}`);
          await sleep(scopedHost, 300);
          if (attempt === 3) throw error;
        }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      clearTimeout(timer);
      try { await originalHost.input('releaseAll', []); }
      catch (error) { if (!failure) throw error; originalHost.log?.('error', `Teleport input release failed: ${error.message}`); }
    }
  }
  async teleportOnce(x, y, { mapName = 'Teyvat', force = false } = {}) {
    return released(this.host, async () => {
      this.areaSwitchCenter = null;
      const target = resolveTeleportTarget(await this.catalog(), x, y, mapName, force);
      await this.openMap(mapName, { retries: 1 }); await this.ensureGroundLayer(); await this.switchTargetArea(target);
      const view = await this.prepareTeleportView(target), alignment = await this.alignedTeleportPoint(target, view);
      const clickPoint = alignment.correctionTooLarge ? alignment.originalPoint : alignment.point;
      await input(this.host, 'click', [clickPoint.x, clickPoint.y]);
      let panel;
      try { panel = await this.confirmTeleportPanel(target); }
      catch (error) {
        if (!alignment.correctionTooLarge || error.code !== 'TELEPORT_PANEL_NOT_OPEN') throw error;
        await input(this.host, 'click', [alignment.point.x, alignment.point.y]);
        panel = await this.confirmTeleportPanel(target);
      }
      const completion = await this.waitTeleportComplete(); this.lastMap = mapName;
      const geometry = await this.geometry(mapName); this.previous = { position: geometry.gameToImage(target), at: now(this.host) };
      return { ...completion, position: { x: target.x, y: target.y }, targetId: target.target.id, panel, alignment: { pairs: alignment.alignment.pairs.length, uncertainty: alignment.alignment.uncertainty } };
    });
  }
  async rotation(target, tolerance = 5, maxTries = 50) {
    for (let count = 0; count <= maxTries + 1; count++) {
      const angle = await this.captured(frame => this.host.vision('map.cameraOrientation', { handle: frame.handle }));
      if (!angle?.valid || !Number.isFinite(angle.angle)) throw new Error('Original camera orientation is not observable');
      const step = cameraRotation(angle.angle, target, this.options.dpi);
      if (step.diff !== 0) await input(this.host, 'moveMouseBy', [step.dx, 0]);
      if (Math.abs(step.diff) < tolerance) return { verified: true, angle: angle.angle, attempts: count };
      if (count > maxTries) break;
      await sleep(this.host, 50);
    }
    throw Object.assign(new Error(`Original camera rotation exceeded ${maxTries} retries`), { code: 'CAMERA_ROTATION_TIMEOUT' });
  }
  async rotateTo(target, options = {}) { return released(this.host, () => this.rotation(target, options.tolerance ?? 5, options.maxTries ?? 50)); }
  async rotateForWaypoint(target, tolerance) {
    try { return await this.rotation(target, tolerance); }
    catch (error) {
      check(this.host); if (error.code !== 'CAMERA_ROTATION_TIMEOUT') throw error;
      await this.adapter('resolveAnomalies', { reason: 'rotation' });
      return this.rotation(target, tolerance);
    }
  }
  async locate(waypoint, frame) {
    if (!frame) return this.captured(capture => this.locate(waypoint, capture));
    const args = { handle: frame.handle, mapName: waypoint.mapName, previous: this.matchHint ?? this.previous?.position, matchingMethod: waypoint.matchingMethod };
    const result = await this.host.vision('map.locateMinimap', args);
    const fresh = result?.found && result.position && Number.isFinite(result.position.x) && Number.isFinite(result.position.y);
    const mis = waypoint.point_ext_params?.misidentification ?? { type: ['unrecognized'], handling_mode: 'previousDetectedPoint' };
    const tooFar = fresh && distance(waypoint, result.position) > 500;
    const recover = (!fresh && mis.type.includes('unrecognized')) || (tooFar && mis.type.includes('pathTooFar'));
    if (recover && mis.handling_mode === 'previousDetectedPoint' && this.previous) {
      return { position: this.previous.position, fresh: false, staleMs: now(this.host) - this.previous.at, additionalMs: 0 };
    }
    if (recover && mis.handling_mode === 'mapRecognition') {
      const start = now(this.host);
      await this.openMap(waypoint.mapName); let location;
      try { location = await this.locateBigMapCenter(waypoint.mapName); }
      finally { await input(this.host, 'keyPress', ['VK_ESCAPE']); }
      let returned = false;
      for (let i = 0; i < 10; i++) { await sleep(this.host, 200); if (await this.isInMainUi()) { returned = true; break; } }
      if (!returned) throw new Error('Map-recognition recovery failed to return to observed main UI');
      const position = (await this.geometry(waypoint.mapName)).gameToImage({ x: Math.fround(location.x), y: Math.fround(location.y) });
      this.previous = { position, at: now(this.host) }; this.matchHint = null;
      return { position, fresh: true, additionalMs: now(this.host) - start };
    }
    if (!fresh) throw new Error(`Original minimap localization failed: ${waypoint.mapName}`);
    this.previous = { position: result.position, at: now(this.host) }; this.matchHint = null;
    return { position: result.position, fresh: true, additionalMs: 0 };
  }
  async motionStatus(frame) {
    if (!frame) return this.captured(capture => this.motionStatus(capture));
    if (!exists(await this.find(frame, 'Common/Element', 'SpaceKey'))) return 'Normal';
    return exists(await this.find(frame, 'Common/Element', 'XKey')) ? 'Climb' : 'Fly';
  }
  async escapeTrap(waypoint) {
    return released(this.host, async () => {
      const state = this.trapState, random = () => this.host.random?.() ?? Math.random();
      const increaseAngle = () => { state.randomAngle += 30 + Math.floor(random() * 15); };
      increaseAngle();
      await input(this.host, 'keyUp', ['W']); await input(this.host, 'keyPress', ['X']); await sleep(this.host, 75);
      await input(this.host, 'leftButtonClick'); await sleep(this.host, 500);
      state.actionIndex = now(this.host) - state.lastActionAt >= 10000 ? 0 : state.actionIndex + 1;
      const direction = state.actionIndex % 3, key = ['S', 'A', 'D'][direction], baseDelay = direction === 0 ? 1000 : 700;
      await input(this.host, 'keyDown', [key]);
      try {
        await sleep(this.host, direction === 0 ? 500 : 300); await input(this.host, 'keyPress', ['VK_SPACE']);
        await sleep(this.host, baseDelay + state.actionIndex * 1000);
      } finally { await this.host.input('keyUp', [key]); }
      if (direction !== 0) await input(this.host, 'keyPress', ['X']);
      state.lastActionAt = now(this.host);
      const start = now(this.host), initial = await this.locate(waypoint);
      if (!initial.fresh) throw new Error('Original trap recovery requires an observed starting position');
      state.lastActionAt = now(this.host);
      await this.rotation(targetOrientation(waypoint, initial.position), 5);
      await input(this.host, 'keyDown', ['W']);
      let corrections = 0;
      try {
        while (now(this.host) - state.lastActionAt <= 5000 && now(this.host) - start <= 25000) {
          const location = await this.locate(waypoint);
          if (!location.fresh) throw new Error('Original trap recovery lost observable position');
          await this.rotation(targetOrientation(waypoint, location.position) + state.randomAngle, 5);
          await input(this.host, 'keyDown', ['W']);
          if (state.randomAngle !== 0) {
            state.randomAngle %= 360;
            if (now(this.host) - state.lastActionAt > 1500) state.randomAngle = 0;
          }
          if (!['climb', 'fly'].includes(waypoint.move_mode) && await this.motionStatus() === 'Climb') {
            await input(this.host, 'keyUp', ['W']); await input(this.host, 'keyPress', ['X']); await sleep(this.host, 75);
            await input(this.host, 'keyDown', ['S']);
            try { await sleep(this.host, 700); } finally { await this.host.input('keyUp', ['S']); }
            state.lastActionAt = now(this.host); increaseAngle(); corrections++; continue;
          }
          await sleep(this.host, 100);
        }
      } finally { await this.host.input('keyUp', ['W']); }
      return { performed: true, verified: false, direction: key, corrections, elapsedMs: now(this.host) - start };
    });
  }
  async moveTo(waypoint, { close = false } = {}) {
    return released(this.host, async () => {
      if (!close && this.options.mainAvatarIndex) await this.adapter('switchAvatar', { index: this.options.mainAvatarIndex, needSkill: false });
      const switchAvatarAt = now(this.host); let lastNotTooFar;
      if (!close) {
        const initial = await this.locate(waypoint);
        if (!initial.fresh) throw new Error('Cannot begin waypoint movement from a stale position');
        lastNotTooFar = this.previous;
        await this.rotateForWaypoint(targetOrientation(waypoint, initial.position), 5);
      }
      const start = now(this.host), hurryState = {};
      let lastDash = -Infinity, lastSample = start, tooFar = 0, deviationStart = null, frames = 0, deviationFrames = 0, fastMode = false;
      const samples = [];
      if (!close) await input(this.host, 'keyDown', ['W']);
      try {
        while (now(this.host) - start <= 240000) {
          frames++;
          if (close && frames > 25) throw new Error('Precise waypoint approach exceeded original 25 steps');
          if (!close && typeof this.host.isKeyDown === 'function' && !await this.host.isKeyDown('W')) await input(this.host, 'keyDown', ['W']);
          const located = await this.locate(waypoint), position = located.position, d = waypointDistance(waypoint, position);
          if (d < (close ? 2 : 4) && located.fresh) { if (close) await sleep(this.host, 1000); return { verified: true, distance: d, frames, elapsedMs: now(this.host) - start }; }
          if (!close && located.additionalMs > 0) { await input(this.host, 'keyDown', ['W']); fastMode = false; }
          if (!close && d > 500) {
            if (++tooFar > 50) throw new Error('Waypoint remains more than 500 map pixels away after 50 retries');
            if (tooFar % 10 === 0) { await this.adapter('resolveAnomalies', { waypoint, reason: 'distance' }); await input(this.host, 'keyDown', ['W']); this.previous = lastNotTooFar; await sleep(this.host, 500); }
            await sleep(this.host, 50); continue;
          }
          lastNotTooFar = this.previous;
          if (close) {
            await this.rotateForWaypoint(targetOrientation(waypoint, position), 2);
            await input(this.host, 'keyDown', ['W']);
            try { await sleep(this.host, 60); } finally { await this.host.input('keyUp', ['W']); }
            await sleep(this.host, 20); continue;
          }
          if (waypoint.move_mode !== 'climb' && now(this.host) - lastSample > 1000 + (located.additionalMs > 0 ? located.additionalMs + 1000 : 0)) {
            samples.push(position); lastSample = now(this.host);
            if (samples.length > 8) {
              const before = samples[samples.length - 8];
              if (Math.abs(before.x - position.x) + Math.abs(before.y - position.y) < 3) {
                if (++this.trapCount > 2) throw Object.assign(new Error('Original waypoint trap recovery exhausted'), { code: 'PATH_RETRY' });
                await this.escapeTrap(waypoint); fastMode = false; await input(this.host, 'keyDown', ['W']); continue;
              }
            }
          }
          const target = targetOrientation(waypoint, position);
          const camera = await this.captured(frame => this.host.vision('map.cameraOrientation', { handle: frame.handle }));
          if (!camera?.valid) throw new Error('Camera orientation missing during movement');
          const rotation = cameraRotation(camera.angle, target, this.options.dpi);
          if (rotation.diff !== 0) await input(this.host, 'moveMouseBy', [rotation.dx, 0]);
          if (now(this.host) - start > 2000 && frames >= 5 && Math.abs(rotation.diff) > 5) {
            deviationStart ??= now(this.host); deviationFrames++;
            if (now(this.host) - deviationStart > 2000 && deviationFrames >= 3) {
              await input(this.host, 'keyUp', ['W']); await this.rotateForWaypoint(target, 2); await input(this.host, 'keyDown', ['W']); deviationStart = null; deviationFrames = 0;
            }
          } else { deviationStart = null; deviationFrames = 0; }
          if (this.options.hurryAbility) {
            const hurry = await this.adapter('movementAbilities', { phase: 'hurry', waypoint, distance: d, diff: rotation.diff, frames, state: hurryState, options: this.options });
            if (hurry?.handled === true) { await sleep(this.host, clamp(this.options.frameInterval, 5, 150)); continue; }
          }
          if (waypoint.move_mode === 'fly') { if (await this.motionStatus() !== 'Fly') { await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, 200); } await sleep(this.host, 100); continue; }
          else if (waypoint.move_mode === 'jump') { await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, 200); continue; }
          else if (waypoint.move_mode === 'run' && fastMode !== (d > 20)) { await input(this.host, d > 20 ? 'rightButtonDown' : 'rightButtonUp'); fastMode = d > 20; }
          else if (waypoint.move_mode === 'dash' && d > 20 && now(this.host) - lastDash > 1000) { await input(this.host, 'rightButtonClick'); lastDash = now(this.host); }
          else if (!['run', 'dash', 'climb'].includes(waypoint.move_mode)) {
            if (d > 10 && this.options.guardianAbility && this.options.guardianInterval > 0 && now(this.host) - this.guardianLastUseAt > this.options.guardianInterval) {
              if (this.options.guardianInterval < 1000) throw new RangeError('Original guardian skill interval must be at least one second');
              if (now(this.host) - switchAvatarAt < 1000 && this.options.mainAvatarIndex && this.options.guardianAvatarIndex !== this.options.mainAvatarIndex) await sleep(this.host, 800);
              await this.adapter('movementAbilities', { phase: 'guardian', waypoint, distance: d, options: this.options }); this.guardianLastUseAt = now(this.host);
            }
            if (this.options.autoRun && d > 20 && now(this.host) - lastDash > 2500) { await input(this.host, 'rightButtonClick'); lastDash = now(this.host); }
          }
          if (this.options.gadgetInterval > 0 && now(this.host) - this.gadgetLastUseAt > this.options.gadgetInterval) { await input(this.host, 'keyPress', [this.options.gadgetKey ?? 'Z']); this.gadgetLastUseAt = now(this.host); }
          await sleep(this.host, clamp(this.options.frameInterval, 5, 150));
        }
        throw Object.assign(new Error('Waypoint movement exceeded original 240 second timeout'), { code: 'PATH_RETRY' });
      } finally { await this.host.input('keyUp', ['W']); await this.host.input('rightButtonUp', []); }
    });
  }
  async stopFlying(waypoint) {
    if (/^[+-]?\d+$/.test(waypoint.action_params?.trim() ?? '')) {
      const delay = +waypoint.action_params; if (delay < 0) throw new RangeError('stop_flying delay must be nonnegative');
      await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, delay); await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, 300);
    }
    await input(this.host, 'leftButtonClick');
    for (let i = 0; i < 50; i++) { if (await this.motionStatus() !== 'Fly') return { verified: true }; await sleep(this.host, 300); }
    throw new Error('Original stop-flying action failed to observe landing');
  }
  async action(waypoint) {
    const action = waypoint.action;
    if (!action || ['force_tp', 'log_output', 'stop_flying', 'up_down_grab_leaf'].includes(action)) return;
    if (action === 'combat_script' && waypoint.combatScript) await executeCombatScript(waypoint.combatScript, this.host, { dpi: this.options.dpi });
    else await this.adapter(`action.${action}`, { waypoint, options: this.options });
    await sleep(this.host, 1000);
  }
  async execute(taskOrFilename, { manageTriggers = true, manageParty = true } = {}) {
    return released(this.host, async () => {
      const task = typeof taskOrFilename === 'string' ? await loadPathingTask(taskOrFilename, { sourceRoot: this.host.sourceRoot }) : taskOrFilename;
      if (task.coordinates !== 'map-image') throw new TypeError('Execute requires original source coordinate conversion via loadPathingTask');
      const external = task.positions.filter(p => p.action && !['stop_flying', 'force_tp', 'combat_script', 'log_output'].includes(p.action));
      if (external.length && !this.host.navigation) throw new UnsupportedNativeOperation(`navigation.action.${external[0].action}`);
      const lifecycle = manageTriggers && (Object.keys(task.config.realtime_triggers).length > 0 || task.farming_info.allow_farming_count);
      let begun = false, completed = 0, attempts = 0; const observed = new Set();
      const previousOptions = this.options;
      try {
        if (manageParty && task.positions.length) {
          const preparation = await this.adapter('prepareRoute', { task, options: this.options });
          if (preparation?.ready !== true) throw new Error('Original route party validation did not confirm readiness');
          if (preparation.partyConfig) this.options = { ...this.options, partyConfig: preparation.partyConfig };
        }
        if (lifecycle) { await this.adapter('beginRoute', { task }); begun = true; }
        await this.returnMainUi();
        for (const [segmentIndex, segment] of task.segments.entries()) {
          let resumeIndex = -1;
          for (let attempt = 0; attempt < 2; attempt++) {
            let pointIndex = 0; attempts++;
            try {
              if (manageParty) await this.adapter('resolveAnomalies', { task, reason: 'segment', options: this.options });
              if (segment[0]?.type !== 'teleport') { this.previous = null; this.matchHint = { x: segment[0].x, y: segment[0].y }; }
              for (const point of segment) {
                check(this.host);
                if (manageParty) {
                  const recovery = await this.adapter('recoverWhenLowHp', { task, waypoint: point, options: this.options });
                  if (recovery?.retry) throw Object.assign(new Error('Original low-HP recovery requires route retry'), { code: 'PATH_RETRY' });
                }
                if (point.type === 'teleport') {
                  const before = task.segments[segmentIndex - 1]?.at(-1);
                  if (before && before.type !== 'teleport' && !['fight', 'nahida_collect', 'pick_around'].includes(before.action)) await sleep(this.host, 1000);
                  await this.teleport(point.gameX, point.gameY, { mapName: task.mapName, force: point.action === 'force_tp' }); await sleep(this.host, 500);
                } else {
                  if (point.action === 'log_output') this.host.log?.('info', point.action_params ?? '');
                  if (point.action === 'up_down_grab_leaf') {
                    await input(this.host, 'middleButtonClick'); await sleep(this.host, 300);
                    const location = await this.locate(point); if (!location.fresh) throw new Error('Leaf action needs a fresh position');
                    await this.rotateForWaypoint(targetOrientation(point, location.position), 10); await this.adapter('action.up_down_grab_leaf', { waypoint: point, options: this.options });
                  } else if (point.type === 'orientation') {
                    const location = await this.locate(point); if (!location.fresh) throw new Error('Facing a waypoint needs a fresh position');
                    await this.rotateForWaypoint(targetOrientation(point, location.position), 2); await sleep(this.host, 500);
                  } else await this.moveTo(point);
                  if (point.move_mode === 'fly' && point.action === 'stop_flying') await this.stopFlying(point);
                  if (point.isTarget) await this.moveTo(point, { close: true });
                  if (pointIndex >= resumeIndex || point.action === 'combat_script') await this.action(point);
                }
                observed.add(point); completed = observed.size; pointIndex++;
              }
              break;
            } catch (error) {
              check(this.host);
              if (!['PATH_RETRY', 'PATH_RETRY_NO_COUNT'].includes(error.code)) throw error;
              resumeIndex = pointIndex;
              if (error.code === 'PATH_RETRY_NO_COUNT') attempt--;
              else if (attempt === 1) throw error;
              this.host.log?.('warn', `Original segment retry at point ${pointIndex + 1}: ${error.message}`);
            } finally {
              await this.host.input('keyUp', ['W']); await this.host.input('rightButtonUp', []); await this.host.input('leftButtonUp', []);
            }
          }
        }
        return { verified: true, completed, total: task.positions.length, segmentAttempts: attempts, managedTriggers: lifecycle, managedParty: manageParty, diagnostics: task.diagnostics };
      } finally {
        try { if (begun) await this.host.navigation('endRoute', { task, completed }); }
        finally { this.options = previousOptions; }
      }
    });
  }
}
