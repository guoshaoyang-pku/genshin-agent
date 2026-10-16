import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webKeyCode } from './cloud.mjs';

export const BETTERGI_SOURCE_COMMIT = 'c9db8b8291fe4ac25a600aee1582298005919eb2';
export const CURRENT_AVATAR = '当前角色';
const macroTypes = ['KeyDown', 'KeyUp', 'MouseMoveTo', 'MouseMoveBy', 'MouseDown', 'MouseUp', 'MouseWheel'];
const methods = {
  skill: ['skill', 'e'], burst: ['burst', 'q'], attack: ['attack', '普攻', '普通攻击'],
  charge: ['charge', '重击'], wait: ['wait', 'after', '等待'], ready: ['ready', '完成'],
  check: ['check', '检测'], walk: ['walk', '行走'], w: ['w'], a: ['a'], s: ['s'], d: ['d'],
  dash: ['dash', '冲刺'], jump: ['jump', 'j', '跳跃'], mousedown: ['mousedown'],
  mouseup: ['mouseup'], click: ['click'], moveby: ['moveby'], keydown: ['keydown'],
  keyup: ['keyup'], keypress: ['keypress'], scroll: ['scroll', 'verticalscroll'], round: ['round'],
};
const methodAliases = new Map(Object.entries(methods).flatMap(([name, aliases]) => aliases.map(alias => [alias, name])));
const macroMethods = new Set(['wait', 'mousedown', 'mouseup', 'click', 'moveby', 'keydown', 'keyup', 'keypress', 'scroll', 'ready']);

export class UnsupportedNativeOperation extends Error {
  constructor(operation) {
    super(`BetterGI native operation requires an implemented adapter: ${operation}`);
    this.name = 'UnsupportedNativeOperation';
    this.operation = operation;
  }
}

function checkAbort(host) { host.signal?.throwIfAborted(); }
async function sleep(host, ms) {
  checkAbort(host);
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Invalid delay: ${ms}`);
  if (ms > 0) await host.sleep(ms);
  checkAbort(host);
}
async function input(host, method, args = []) { checkAbort(host); return host.input(method, args); }
async function released(host, body) {
  let failed;
  try { return await body(); } catch (error) { failed = error; throw error; }
  finally {
    try { await host.input('releaseAll', []); } catch (error) {
      if (!failed) throw error;
      host.log?.('error', `Remote input release failed: ${error.message}`);
    }
  }
}
function number(value, label) {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n)) throw new TypeError(`Invalid ${label}: ${value}`);
  return n;
}
function integer(value, label) {
  const n = number(value, label);
  if (!Number.isInteger(n)) throw new TypeError(`Invalid integer ${label}: ${value}`);
  return n;
}
function roundEven(value) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
function jsonWithComments(source) {
  let text = '', quote = false, escaped = false, line = false, block = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === '\n') { line = false; text += c; } continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) { text += c; if (!escaped && c === '"') quote = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') { quote = true; text += c; }
    else if (c === '/' && next === '/') { line = true; i++; text += ' '; }
    else if (c === '/' && next === '*') { block = true; i++; text += ' '; }
    else text += c;
  }
  let clean = ''; quote = false; escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { clean += c; if (!escaped && c === '"') quote = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') quote = true;
    if (c === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) continue;
    clean += c;
  }
  return JSON.parse(clean.replace(/^\uFEFF/, ''));
}

// Core/Recorder/Model/KeyMouseScript.cs and KeyMouseMacroPlayer.cs.
export function parseKeyMouseScript(source, { width = 1920, height = 1080, x = 0, y = 0, dpi = 1 } = {}) {
  const script = typeof source === 'string' ? jsonWithComments(source) : structuredClone(source);
  if (!Array.isArray(script?.macroEvents)) throw new TypeError('Macro requires macroEvents');
  const info = script.info;
  const adapt = info && info.width > 0 && info.height > 0;
  if (![width, height, dpi].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid capture metrics');
  const events = script.macroEvents.map((event, index) => {
    const type = typeof event.type === 'number' ? macroTypes[event.type] : event.type;
    if (!macroTypes.includes(type)) throw new TypeError(`Unknown macro event type ${event.type} at ${index}`);
    const e = { ...event, type, time: number(event.time, 'event time'), mouseX: event.mouseX ?? 0, mouseY: event.mouseY ?? 0 };
    if (e.time < 0) throw new RangeError(`Negative macro event time at ${index}`);
    if (type === 'KeyDown' || type === 'KeyUp') e.keyCode = integer(e.keyCode, 'keyCode');
    if (adapt && ['MouseMoveTo', 'MouseDown', 'MouseUp'].includes(type)) {
      e.mouseX = Math.trunc(x + (e.mouseX - (info.x ?? 0)) * width / info.width);
      e.mouseY = Math.trunc(y + (e.mouseY - (info.y ?? 0)) * height / info.height);
    } else if (adapt && type === 'MouseMoveBy') {
      const recordDpi = info.recordDpi ?? 1;
      if (!(recordDpi > 0)) throw new RangeError('recordDpi must be positive');
      e.mouseX = roundEven(e.mouseX / recordDpi * dpi);
      e.mouseY = roundEven(e.mouseY / recordDpi * dpi);
    }
    if (![e.mouseX, e.mouseY].every(Number.isFinite)) throw new TypeError(`Invalid macro mouse coordinates at ${index}`);
    return e;
  });
  return { info: info ?? null, events };
}

export async function playKeyMouseScript(script, host) {
  const { events } = script.events ? script : parseKeyMouseScript(script);
  return released(host, async () => {
    const now = host.now ?? (() => performance.now());
    const start = now();
    for (const e of events) {
      checkAbort(host);
      const wait = e.time - (now() - start);
      if (wait > 0) await sleep(host, wait);
      else if (wait < -1) host.log?.('debug', `Macro ${e.type} behind by ${Math.round(-wait)}ms`);
      if (e.type === 'KeyDown' || e.type === 'KeyUp') await input(host, e.type, [e.keyCode]);
      else if (e.type === 'MouseMoveTo') await input(host, 'moveMouseTo', [e.mouseX, e.mouseY]);
      else if (e.type === 'MouseDown' || e.type === 'MouseUp') {
        const button = String(e.mouseButton).toLowerCase();
        if (button === 'none') continue;
        if (!['left', 'right', 'middle'].includes(button)) throw new UnsupportedNativeOperation(`macro mouse button ${e.mouseButton}`);
        await input(host, 'moveMouseTo', [e.mouseX, e.mouseY]);
        await input(host, `${button}Button${e.type === 'MouseDown' ? 'Down' : 'Up'}`);
      } else if (e.type === 'MouseWheel') {
        const ticks = Math.trunc(e.mouseY / 120);
        if (ticks) await input(host, 'verticalScroll', [ticks]);
      } else if (e.type === 'MouseMoveBy') {
        let dx = e.mouseX;
        if (e.cameraOrientation != null) {
          const capture = await host.capture();
          let actual;
          try {
            const orientation = await host.vision('map.cameraOrientation', { handle: capture.handle });
            actual = typeof orientation === 'number' ? orientation : orientation?.valid ? orientation.angle : null;
            if (!Number.isFinite(actual)) throw new Error('Camera orientation could not be observed for macro correction');
          }
          finally { await host.vision('image.dispose', { handle: capture.handle }); }
          let diff = (roundEven(actual) - e.cameraOrientation + 180) % 360 - 180;
          if (diff < -180) diff += 360;
          if (diff !== 0 && diff < 8 && diff > -8) dx -= diff;
        }
        await input(host, 'moveMouseBy', [dx, e.mouseY]);
      }
    }
    return { events: events.length, durationMs: now() - start };
  });
}

export async function loadAvatarCatalog(sourceRoot) {
  const avatars = JSON.parse(await readFile(path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoFight/Assets/combat_avatar.json'), 'utf8'));
  return { avatars, aliases: new Map(avatars.flatMap(avatar => avatar.alias.map(alias => [alias, avatar.name]))) };
}
function avatarName(name, aliases) {
  const standard = aliases.get(name);
  if (!standard) throw new Error(`角色名称校验失败：${name}`);
  return standard;
}
function parseRounds(args) {
  if (!args.length) throw new Error('round方法必须有入参');
  return args.flatMap(arg => {
    const parts = arg.split('-').map(part => integer(part.trim(), 'round'));
    if (parts.length > 2 || parts[0] <= 0 || (parts.length === 2 && parts[0] > parts[1])) throw new RangeError(`Invalid round: ${arg}`);
    return parts.length === 1 ? parts : Array.from({ length: parts[1] - parts[0] + 1 }, (_, i) => parts[0] + i);
  });
}
function validKey(key) {
  if (/^(VK_)?(LBUTTON|RBUTTON|MBUTTON|XBUTTON1|XBUTTON2)$/i.test(key)) return null;
  return webKeyCode(key);
}
function parseCommand(text, name) {
  const open = text.indexOf('('), close = text.indexOf(')');
  const rawMethod = (open > 0 ? text.slice(0, open) : text).trim();
  const method = methodAliases.get(rawMethod);
  if (!method) throw new Error(`战斗策略脚本中出现未知的方法：${rawMethod}`);
  if (open >= 0 && close < open) throw new Error('战斗脚本格式错误，指令括号无法配对');
  const args = open > 0 ? text.slice(open + 1, close).split(',').map(arg => arg.trim()) : [];
  const count = expected => { if (args.length !== expected) throw new Error(`${method}方法必须有${expected}个入参`); };
  if (method === 'walk') { count(2); if (!(number(args[1], 'walk time') > 0)) throw new RangeError('行走时间必须大于0'); }
  if (['w', 'a', 's', 'd'].includes(method)) count(1);
  if (method === 'moveby') count(2);
  if (['keydown', 'keyup', 'keypress'].includes(method)) { count(1); validKey(args[0]); }
  if (method === 'scroll') { count(1); integer(args[0], 'scroll'); }
  const ignoredSuffix = open > 0 ? text.slice(close + 1).trim() : '';
  return { name, method, args, activatingRound: null, ...(ignoredSuffix ? { ignoredSuffix } : {}) };
}

export function parseCombatLinePart(source, name) {
  const parts = source.split(',').filter(Boolean), commands = [];
  for (let i = 0; i < parts.length; i++) {
    let text = parts[i];
    if (text.includes('(') && !text.includes(')')) {
      while (++i < parts.length) {
        text += ',' + parts[i];
        if ((text.match(/\(/g) ?? []).length > 1) throw new Error('战斗脚本格式错误，指令括号无法配对');
        if (text.includes(')')) break;
      }
      if (!text.includes(')')) throw new Error('战斗脚本格式错误，指令括号不完整');
    }
    commands.push(parseCommand(text, name));
  }
  return commands;
}

export function parseCombatLineCommands(source, name) {
  return source.split('|').filter(Boolean).flatMap(part => {
    const commands = parseCombatLinePart(part, name);
    if (commands[0]?.method === 'round') {
      const rounds = parseRounds(commands.shift().args);
      for (const command of commands) command.activatingRound = rounds;
    }
    return commands;
  });
}

// GameTask/AutoFight/Script/{CombatScriptParser,CombatCommand,Method}.cs.
export function parseCombatScript(source, { aliases, validate = true, defaultAvatarName } = {}) {
  if (!aliases) throw new TypeError('Original combat avatar aliases are required');
  const commands = [], names = new Set();
  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = raw.trim().replaceAll('（', '(').replaceAll('，', ',');
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    for (const rawStatement of line.split(';').filter(Boolean)) {
      const statement = rawStatement.trim();
      let depth = 0, separator = -1;
      for (let i = 0; i < statement.length; i++) {
        if (statement[i] === '(') depth++;
        else if (statement[i] === ')') depth--;
        else if (statement[i] === ' ' && depth === 0) { separator = i; break; }
      }
      let name = CURRENT_AVATAR, commandText = statement;
      if (separator > 0) { name = avatarName(statement.slice(0, separator), aliases); commandText = statement.slice(separator + 1); }
      else if (defaultAvatarName != null) name = avatarName(defaultAvatarName, aliases);
      else if (validate) throw new Error('战斗脚本格式错误，必须以空格分隔角色和指令');
      names.add(name);
      for (const segment of commandText.split('|').filter(Boolean)) {
        const tokens = []; let token = ''; depth = 0;
        for (const char of segment) {
          if (char === '(') depth++;
          if (char === ')') depth--;
          if (depth < 0 || depth > 1) throw new Error('战斗脚本格式错误，指令括号无法配对');
          if (char === ',' && depth === 0) { if (token) tokens.push(token.trim()); token = ''; }
          else token += char;
        }
        if (depth !== 0) throw new Error('战斗脚本格式错误，指令括号不完整');
        if (token) tokens.push(token.trim());
        const parsed = tokens.filter(Boolean).map(text => parseCommand(text, name));
        if (parsed[0]?.method === 'round') {
          const rounds = parseRounds(parsed.shift().args);
          for (const command of parsed) command.activatingRound = rounds;
        }
        commands.push(...parsed);
      }
    }
  }
  const diagnostics = commands.flatMap((command, index) => command.ignoredSuffix ? [{ commandIndex: index, message: 'Original CombatCommand ignores text after the first closing parenthesis', ignoredSuffix: command.ignoredSuffix }] : []);
  return { avatarNames: [...names], commands, diagnostics };
}

async function combat(host, method, args) {
  checkAbort(host);
  if (typeof host.combat !== 'function') throw new UnsupportedNativeOperation(`combat.${method}`);
  return host.combat(method, args);
}
async function held(host, method, args, ms, endMethod = method.replace(/Down$/, 'Up')) {
  await input(host, method, args);
  try { await sleep(host, ms); } finally { await host.input(endMethod, args); }
}
async function charge(host, name, ms, dpi) {
  if (name === '桑多涅') return combat(host, 'charge', { name, ms });
  await input(host, 'leftButtonDown');
  try {
    if (!['那维莱特', '恰斯卡'].includes(name)) return await sleep(host, ms);
    let tick = -4;
    while (ms >= 0) {
      if (name === '那维莱特') { await input(host, 'moveMouseBy', [Math.trunc(1000 * dpi), 0]); await sleep(host, 50); ms -= 50; }
      else {
        const [rx, ry] = tick < 3 ? [50, 11.5] : tick < 40 ? [0.49, 0] : tick < 43 ? [50, 20] : tick < 70 ? [0.63, 0] : tick < 73 ? [50, 50] : [0.7, 0];
        await input(host, 'moveMouseBy', [Math.trunc(rx * 50 * dpi), Math.trunc(ry * 50 * dpi)]);
        tick = (tick + 1) % 100; await sleep(host, 25); ms -= 25;
      }
    }
  } finally { await host.input('leftButtonUp', []); }
}

export async function executeCombatCommand(command, host, { team, previous = command, round = 1, dpi = 1, checkFight = true } = {}) {
  checkAbort(host);
  const { method, args } = command;
  if (command.activatingRound && !command.activatingRound.includes(round)) return { executed: 0, skipped: 1, ended: false };
  const name = command.name === CURRENT_AVATAR ? await combat(host, 'currentAvatar', {}) : command.name;
  if (command.name === CURRENT_AVATAR && !team.some(avatar => avatar.name === name)) throw new Error('无法确认当前出战角色');
  const avatar = team.find(item => item.name === name);
  if (!avatar) return { executed: 0, skipped: 1, ended: false };
  if (command.name !== CURRENT_AVATAR && (previous.name !== command.name || !macroMethods.has(method))) await combat(host, 'switchAvatar', avatar);
  if (method === 'skill') {
    if (args.includes('fast') && !await combat(host, 'isSkillReady', { name })) return { executed: 0, skipped: 1, ended: false };
    if (!args.includes('fast') && args.includes('wait')) await combat(host, 'waitSkillCd', { name });
    await combat(host, 'useSkill', { name, hold: args.includes('hold') });
  } else if (method === 'burst') await combat(host, 'useBurst', { name });
  else if (method === 'attack') {
    let ms = args.length ? Math.trunc(number(args[0], 'attack time') * 1000) : 0;
    while (ms >= 0) { await input(host, 'leftButtonClick'); ms -= 200; await sleep(host, 200); }
  } else if (method === 'charge') await charge(host, name, args.length ? Math.trunc(number(args[0], 'charge time') * 1000) || 1000 : 1000, dpi);
  else if (method === 'walk' || ['w', 'a', 's', 'd'].includes(method)) {
    const key = method === 'walk' ? args[0] : method;
    const ms = Math.trunc(number(args[method === 'walk' ? 1 : 0], 'walk time') * 1000);
    if (['w', 'a', 's', 'd'].includes(key)) await held(host, 'keyDown', [key], ms);
  } else if (method === 'wait') await sleep(host, Math.trunc(number(args[0], 'wait time') * 1000));
  else if (method === 'dash') await held(host, 'rightButtonDown', [], args.length ? Math.trunc(number(args[0], 'dash time') * 1000) || 200 : 200);
  else if (method === 'jump') await input(host, 'keyPress', ['VK_SPACE']);
  else if (method === 'ready') await combat(host, 'ready', { name });
  else if (method === 'check') { if (checkFight && await combat(host, 'check', { name }) === true) return { executed: 1, skipped: 0, ended: true }; }
  else if (['mousedown', 'mouseup', 'click'].includes(method)) {
    const button = (args[0] ?? 'left').toLowerCase();
    if (['left', 'right', 'middle'].includes(button)) await input(host, `${button}Button${({ mousedown: 'Down', mouseup: 'Up', click: 'Click' })[method]}`);
  } else if (method === 'moveby') await input(host, 'moveMouseBy', args.map(value => integer(value, 'mouse delta')));
  else if (['keydown', 'keyup', 'keypress'].includes(method)) {
    await input(host, ({ keydown: 'keyDown', keyup: 'keyUp', keypress: 'keyPress' })[method], args);
    if (method !== 'keydown' && validKey(args[0]) === 'KeyE') await combat(host, 'afterUseSkill', { name });
  } else if (method === 'scroll') await input(host, 'verticalScroll', [integer(args[0], 'scroll')]);
  else if (method !== 'round') throw new UnsupportedNativeOperation(`combat.${method}`);
  return { executed: 1, skipped: 0, ended: false };
}

export async function executeCombatScript(script, host, { team, round = 1, dpi = 1 } = {}) {
  return released(host, async () => {
    team ??= await combat(host, 'initializeTeam', {});
    if (!Array.isArray(team) || !team.length) throw new Error('队伍识别未初始化成功');
    if (!script.avatarNames.includes(CURRENT_AVATAR) && !team.some(avatar => script.avatarNames.includes(avatar.name))) throw new Error('简易策略脚本要求的角色不存在');
    let executed = 0, skipped = 0;
    for (let i = 0; i < script.commands.length; i++) {
      const result = await executeCombatCommand(script.commands[i], host, { team, previous: script.commands[Math.max(0, i - 1)], round, dpi });
      executed += result.executed; skipped += result.skipped;
      if (result.ended) return { executed, skipped, ended: true };
    }
    return { executed, skipped, ended: false };
  });
}

// AutoFishing/RodNet.cs, originally adapted from myHuTao-qwq/HutaoFisher/src/rodnet.cpp.
export async function loadRodNet(sourceRoot) {
  const source = await readFile(path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoFishing/RodNet.cs'), 'utf8');
  const parameters = Object.fromEntries(['dz', 'h_coeff', 'weight', 'bias', 'offset'].map(name => {
    const match = source.match(new RegExp(`readonly double\\[[,]?\\] ${name} = (\\{[\\s\\S]*?\\});`));
    if (!match) throw new Error(`Original RodNet parameter missing: ${name}`);
    return [name, JSON.parse(match[1].replaceAll('{', '[').replaceAll('}', ']'))];
  }));
  const alphaExpression = source.match(/const double alpha = ([\d.]+) \/ ([\d.]+);/);
  if (!alphaExpression) throw new Error('Original RodNet alpha is missing');
  const alpha = Number(alphaExpression[1]) / Number(alphaExpression[2]);
  return {
    parameters,
    computeScores(input) {
      const label = integer(input.fish_label, 'fish label');
      if (label < 0 || label >= parameters.dz.length) throw new RangeError('Fish label is outside original RodNet classes');
      input = Object.fromEntries(['rod_x1', 'rod_x2', 'rod_y1', 'rod_y2', 'fish_x1', 'fish_x2', 'fish_y1', 'fish_y2'].map(name => [name, number(input[name], name)]));
      let a = (input.rod_x2 - input.rod_x1) / 2 / alpha;
      let b = (input.rod_y2 - input.rod_y1) / 2 / alpha;
      const h = (input.fish_y2 - input.fish_y1) / 2 / alpha;
      if (a < b) { b = Math.sqrt(a * b); a = b + 1e-6; }
      const v0 = (288 - (input.rod_y1 + input.rod_y2) / 2) / alpha;
      const u = (input.fish_x1 + input.fish_x2 - input.rod_x1 - input.rod_x2) / 2 / alpha;
      let v = (288 - (input.fish_y1 + input.fish_y2) / 2) / alpha;
      const y0 = Math.sqrt(Math.pow(a, 4) - b * b + a * a * (1 - b * b + v0 * v0)) / (a * a);
      const z0 = b / (a * a);
      const t = a * a * (y0 * b + v0) / (a * a - b * b);
      v -= h * parameters.h_coeff[label];
      const x = u * (z0 + parameters.dz[label]) * Math.sqrt(1 + t * t) / (t - v);
      const y = (z0 + parameters.dz[label]) * (1 + t * v) / (t - v);
      const distance = Math.sqrt(x * x + (y - y0) * (y - y0));
      const scores = parameters.weight[label].map((weight, i) => Math.exp(weight * distance + parameters.bias[label][i]));
      const sum = scores.reduce((total, score) => total + score, 0);
      for (let i = 0; i < scores.length; i++) scores[i] /= sum;
      scores[0] -= parameters.offset[label];
      if (!scores.every(Number.isFinite)) throw new RangeError('RodNet geometry produced non-finite scores');
      return scores;
    },
    getRodState(input) { const scores = this.computeScores(input); return scores.indexOf(Math.max(...scores)); },
  };
}

// Common/Map/Maps/Base/SceneBaseMap.cs; map constants stay in the original source.
export async function loadMapCoordinates(sourceRoot, name = 'Teyvat') {
  if (!['Teyvat', 'Enkanomiya', 'TheChasm', 'AncientSacredMountain', 'SeaOfBygoneEras', 'MoonCanon', 'TempleOfSpace'].includes(name)) throw new UnsupportedNativeOperation(`map.coordinates.${name}`);
  const source = await readFile(path.join(sourceRoot, `BetterGenshinImpact/GameTask/Common/Map/Maps/${name}Map.cs`), 'utf8');
  const constant = key => {
    const match = source.match(new RegExp(`readonly int ${key} = ([0-9]+);`));
    if (!match) throw new Error(`Original ${name} map constant missing: ${key}`);
    return Number(match[1]);
  };
  const blockMatch = source.match(/readonly int \w*MapImageBlockWidth = ([0-9]+);/);
  if (!blockMatch) throw new Error(`Original ${name} block width is missing`);
  const blockWidth = Number(blockMatch[1]), scale = blockWidth / 1024;
  const origin = { x: (constant('GameMapLeftCols') + 1) * blockWidth, y: (constant('GameMapUpRows') + 1) * blockWidth };
  const center = rect => ({ x: rect.x + Math.trunc(rect.width / 2), y: rect.y + Math.trunc(rect.height / 2) });
  return {
    origin, scale, width: constant('GameMapCols') * blockWidth, height: constant('GameMapRows') * blockWidth,
    imageToGame(point) { return point.x === 0 && point.y === 0 ? null : { x: (origin.x - point.x) / scale, y: (origin.y - point.y) / scale }; },
    gameToImage(point) { return point == null ? { x: 0, y: 0 } : { x: origin.x - point.x * scale, y: origin.y - point.y * scale }; },
    imageRectToGame(rect) {
      if (!rect || !(rect.x || rect.y || rect.width || rect.height)) return null;
      const point = this.imageToGame(center(rect));
      return point == null ? null : { x: Math.trunc(point.x - rect.width / 2 / scale), y: Math.trunc(point.y - rect.height / 2 / scale), width: Math.trunc(rect.width / scale), height: Math.trunc(rect.height / scale) };
    },
    gameRectToImage(rect) {
      if (rect == null) return { x: 0, y: 0, width: 0, height: 0 };
      const point = this.gameToImage(center(rect));
      return { x: roundEven(point.x - rect.width / 2 * scale), y: roundEven(point.y - rect.height / 2 * scale), width: roundEven(rect.width * scale), height: roundEven(rect.height * scale) };
    },
  };
}

// AutoPathing/Navigation.cs.
export function targetOrientation(waypoint, position) {
  const dx = waypoint.x - position.x, dy = waypoint.y - position.y, length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return 0;
  let angle = Math.acos(dx / length);
  if (dy < 0) angle = 2 * Math.PI - angle;
  return Math.trunc(angle * 180 / Math.PI);
}
export function waypointDistance(waypoint, position) { const dx = waypoint.x - position.x, dy = waypoint.y - position.y; return Math.sqrt(dx * dx + dy * dy); }

export async function loadTcgCatalog(sourceRoot) {
  return JSON.parse(await readFile(path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoGeniusInvokation/Assets/tcg_character_card.json'), 'utf8'));
}
const tcgElements = { 全: 'Omni', 冰: 'Cryo', 水: 'Hydro', 火: 'Pyro', 雷: 'Electro', 草: 'Dendro', 风: 'Anemo', 岩: 'Geo' };
function tcgElement(value) {
  const element = tcgElements[value] ?? Object.values(tcgElements).find(element => element.toLowerCase() === value.toLowerCase());
  if (!element) throw new Error('Unknown original TCG element: ' + value);
  return element;
}
function tcgNumber(value) { return integer(value.replace(/[^0-9]/g, ''), 'TCG number'); }
// AutoGeniusInvokation/ScriptParser.cs and Config/CharacterCard.cs.
export function parseTcgScript(source, { cards, aliases } = {}) {
  if (!cards || !aliases) throw new TypeError('Original TCG cards and avatar aliases are required');
  const characters = Array(4).fill(null), actionCommandQueue = [];
  let stage = '', lineNumber = 0;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    for (const raw of source.split(/\r\n|\r|\n/)) {
      lineNumber++;
      const line = raw.trim();
      if (line.includes(':')) { stage = line; continue; }
      if (!line || line === '---' || line.startsWith('//')) continue;
      if (stage === '角色定义:') {
        const [definition, skillDefinition] = line.split('{');
        const [slot, specification] = definition.split('=');
        const index = tcgNumber(slot.trim());
        require(index >= 1 && index <= 3, '角色序号必须在1-3之间');
        const [name, customElement] = specification.split('|');
        const character = { index, name, hp: -2, skills: [null] };
        if (customElement != null) {
          character.element = tcgElement(customElement.slice(0, 1));
          for (const entry of skillDefinition.replaceAll('}', '').split(',')) {
            const [skillName, cost] = entry.split('=');
            const index = tcgNumber(skillName), [specific, any] = cost.split('+');
            require(index >= 1 && index <= 5, '技能序号必须在1-5之间');
            const specificElementCost = integer(specific.slice(0, 1), 'specific dice');
            const anyElementCost = any == null ? 0 : integer(any.slice(0, 1), 'any dice');
            character.skills[index] = { index, type: tcgElement(specific.slice(1, 2)), specificElementCost, anyElementCost, allCost: specificElementCost + anyElementCost };
          }
        } else {
          const standard = cards.find(card => card.name === name)?.name ?? avatarName(name, aliases);
          const card = cards.find(card => card.name === standard);
          require(card, '角色【' + standard + '】暂无默认卡牌定义配置，请自行进行角色定义');
          character.element = tcgElement(card.element.replace('元素', ''));
          character.hp = card.hp;
          character.skills = Array(card.skills.length + 1).fill(null);
          let index = 0;
          for (const skill of [...card.skills].reverse()) {
            if (skill.skillTag.includes('被动技能')) continue;
            let type, specificElementCost = 0, anyElementCost = 0, specificTypes = 0;
            for (const cost of skill.cost) {
              if (cost.nameEn === 'unaligned_element') anyElementCost = cost.count;
              else if (cost.nameEn !== 'energy') { type = tcgElement(cost.nameEn); specificElementCost = cost.count; specificTypes++; }
            }
            require(specificTypes === 1, '技能[' + skill.name + ']默认技能数据技能解析失败');
            index++;
            character.skills[index] = { index, name: skill.name, type, specificElementCost, anyElementCost, allCost: specificElementCost + anyElementCost };
          }
        }
        characters[index] = character;
      } else if (stage === '策略定义:') {
        require(characters[3], '角色未定义');
        const parts = line.split(' ').filter(Boolean);
        require(parts.length >= 3 && parts.length <= 4 && parts[1] === '使用', '策略中的行动命令解析错误');
        const character = characters.slice(1).find(character => character?.name === parts[0]);
        require(character, '策略中的行动命令解析错误：角色名称无法从角色定义中匹配到');
        const targetIndex = tcgNumber(parts[2]);
        require(targetIndex < 5, '策略中的行动命令解析错误：技能编号错误');
        let diceDelta = 0;
        if (parts[3] != null) {
          require(parts[3].startsWith('骰子增加') || parts[3].startsWith('骰子减少'), '策略中的行动命令解析错误：骰子增减参数格式不正确');
          diceDelta = tcgNumber(parts[3]) * (parts[3].startsWith('骰子减少') ? -1 : 1);
        }
        actionCommandQueue.push({ action: 'UseSkill', character, targetIndex, diceDelta });
      } else throw new Error('未知的定义字段：' + stage);
    }
    require(characters[3], '角色未定义，请确认策略文本格式是否为UTF-8');
    return { characters, actionCommandQueue, roundNum: 1 };
  } catch (error) { throw new Error('解析脚本错误，行号：' + lineNumber + '，错误信息：' + error.message, { cause: error }); }
}

const exists = region => !!region && !(region.x === 0 && region.y === 0 && region.width === 0 && region.height === 0);
export class NativeTasks {
  constructor(host) { this.host = host; }
  async recognition(group, name, capture) {
    return this.host.vision('recognition.load', { path: path.join(this.host.sourceRoot, 'BetterGenshinImpact/GameTask', group, 'Assets/Recognition.json'), objectName: name, width: capture.width, height: capture.height });
  }
  async find(capture, group, name, many = false) {
    return this.host.vision(many ? 'image.findMulti' : 'image.find', { handle: capture.handle, recognition: await this.recognition(group, name, capture) });
  }
  async captured(body) {
    checkAbort(this.host);
    const capture = await this.host.capture();
    try { return await body(capture); } finally { await this.host.vision('image.dispose', { handle: capture.handle }); }
  }
  async click(region) {
    if (!exists(region)) throw new Error('Cannot click an empty BetterGI Region');
    return input(this.host, 'click', [(region.globalX ?? region.x) + region.width / 2, (region.globalY ?? region.y) + region.height / 2]);
  }
  async isInMainUi(capture) {
    if (!capture) return this.captured(frame => this.isInMainUi(frame));
    if (!exists(await this.find(capture, 'Common/Element', 'PaimonMenu'))) return false;
    if (!exists(await this.find(capture, 'AutoFight', 'Confirm'))) return true;
    const text = await this.host.vision('image.ocr', { handle: capture.handle, recognition: { roi: [0, 0, capture.width, Math.trunc(capture.height / 2)] } });
    return !text.some(region => region.text.includes(this.host.revivalText ?? '复苏'));
  }
  async returnMainUi() {
    if (await this.isInMainUi()) return { verified: true, attempts: 0 };
    for (let attempt = 1; attempt <= 8; attempt++) {
      await input(this.host, 'keyPress', ['VK_ESCAPE']);
      await sleep(this.host, 900);
      const exitDoor = await this.captured(frame => this.find(frame, 'Common/Element', 'BtnExitDoor'));
      if (exists(exitDoor)) { await this.click(exitDoor); await sleep(this.host, 5000); }
      if (await this.isInMainUi()) return { verified: true, attempts: attempt };
    }
    await sleep(this.host, 500); await input(this.host, 'keyPress', ['VK_RETURN']);
    await sleep(this.host, 500); await input(this.host, 'keyPress', ['VK_ESCAPE']);
    await sleep(this.host, 900);
    if (!await this.isInMainUi()) throw new Error('ReturnMainUiTask exhausted its source-defined attempts');
    return { verified: true, attempts: 9 };
  }
  async claimMailRewards() {
    return released(this.host, async () => {
      await this.returnMainUi(); await sleep(this.host, 200);
      await input(this.host, 'keyPress', ['VK_ESCAPE']); await sleep(this.host, 1300);
      const icon = await this.captured(frame => this.find(frame, 'Common/Element', 'EscMailReward'));
      let clicked = false;
      if (exists(icon)) {
        await this.click(icon); await sleep(this.host, 1000);
        const collect = await this.captured(frame => this.find(frame, 'Common/Element', 'Collect'));
        if (exists(collect)) { await this.click(collect); clicked = true; await sleep(this.host, 200); await input(this.host, 'keyPress', ['VK_ESCAPE']); }
      }
      await this.returnMainUi();
      return { rewardIconFound: exists(icon), collectClicked: clicked, mainUiVerified: true };
    });
  }
  async claimRewards({ maxClicks = 30, mode = 'clickOnce', scrollDownEnabled = false, scrollDownAmount = 1 } = {}) {
    if (!Number.isInteger(maxClicks) || maxClicks < 1 || maxClicks > 30) throw new RangeError('maxClicks must be 1..30');
    if (!['clickOnce', 'hold'].includes(mode)) throw new RangeError('Unknown reward claim mode');
    if (mode === 'hold' && !this.host.signal) throw new TypeError('Continuous reward claim requires a cancellation signal');
    if (!Number.isInteger(scrollDownAmount)) throw new TypeError('Reward scroll amount must be an integer');
    return released(this.host, async () => {
      let count = 0;
      while (mode === 'hold' || count < maxClicks) {
        checkAbort(this.host);
        const candidates = await this.captured(async frame => [
          ...await this.find(frame, 'QuickClaimReward', 'ClaimText', true),
          ...await this.find(frame, 'QuickClaimReward', 'ClaimGift', true),
        ]);
        candidates.sort((a, b) => a.y - b.y || a.x - b.x);
        if (!candidates.length) {
          if (mode !== 'hold') break;
          if (scrollDownEnabled) {
            let amount = Math.max(1, Math.abs(scrollDownAmount));
            while (amount > 0) { const chunk = Math.min(amount, 10); await input(this.host, 'verticalScroll', [-chunk]); amount -= chunk; }
            await sleep(this.host, 120);
          } else await sleep(this.host, 260);
          continue;
        }
        await this.click(candidates[0]); count++;
        for (let check = 0; check < 3; check++) {
          await sleep(this.host, 160);
          if (await this.captured(async frame => exists(await this.find(frame, 'QuickClaimReward', 'ClickBlankContinue')))) {
            await input(this.host, 'keyPress', ['VK_ESCAPE']); await sleep(this.host, 220); break;
          }
        }
        await sleep(this.host, 180);
      }
      return { clicked: count, limitReached: mode === 'clickOnce' && count === maxClicks };
    });
  }
  runKeyMouse(source, options) { return playKeyMouseScript(parseKeyMouseScript(source, options), this.host); }
  async runCombat(source, options = {}) {
    const { aliases } = await loadAvatarCatalog(this.host.sourceRoot);
    return executeCombatScript(parseCombatScript(source, { ...options, aliases }), this.host, options);
  }
}
