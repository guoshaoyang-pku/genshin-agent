import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

// BetterGI c9db8b8291fe4ac25a600aee1582298005919eb2, GPL-3.0.
// AutoPickTrigger, AutoSkipTrigger, AutoEatTrigger and ExpeditionTask.
export class UnsupportedRealtimeOperation extends Error {
  constructor(operation, evidence) {
    super('BetterGI realtime adapter unavailable: ' + operation + '; source: ' + evidence);
    this.name = 'UnsupportedRealtimeOperation'; this.operation = operation; this.evidence = evidence;
  }
}
const priority = { AutoPick: 30, AutoEat: 25, AutoSkip: 20 };
const pickDefaults = { enabled: true, itemIconLeftOffset: 60, itemTextLeftOffset: 115, itemTextRightOffset: 400, ocrEngine: 'Paddle', fastModeEnabled: false, pickKey: 'F', mode: 'Whitelist', blacklistModePickEnabled: false, whitelistModeDoNotPickEnabled: true };
const skipDefaults = { enabled: true, quicklySkipConversationsEnabled: true, afterChooseOptionSleepDelay: 0, autoWaitDialogueOptionVoiceEnabled: false, dialogueOptionVoiceMaxWaitSeconds: 30, dialogueOptionVoiceVadDiagnosticEnabled: false, beforeClickConfirmDelay: 0, autoGetDailyRewardsEnabled: true, autoReExploreEnabled: true, clickChatOption: '优先选择第一个选项', customPriorityOptionsEnabled: false, customPriorityOptions: '', autoHangoutEventEnabled: false, autoHangoutEndChoose: '', autoHangoutChooseOptionSleepDelay: 0, autoHangoutPressSkipEnabled: true, runBackgroundEnabled: false, bringGameToFrontAfterBackgroundDialogEnabled: false, submitGoodsEnabled: true, pictureInPictureEnabled: false, closePopupPagedEnabled: true, skipBuiltInClickOptions: false };
const eatDefaults = { enabled: false, checkInterval: 150, eatInterval: 1000 };
const exists = r => !!r && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0;
const scale = frame => Math.min(frame.width / 1920, (frame.height ?? 1080) / 1080, 1);
const now = host => host.now ? host.now() : performance.now();
const retired = new Error('Realtime trigger was removed');
function field(value, key, fallback) { const name = Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : value[name]; }
function config(defaults, value) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    let option = field(value, key, fallback);
    if (typeof fallback === 'number') {
      option = Number(option);
      if (!Number.isFinite(option) || (/(Delay|Interval)$/.test(key) && option < 0)) throw new RangeError('Invalid BetterGI config ' + key);
    }
    return [key, option];
  }));
}
function check(host) { host.signal?.throwIfAborted(); }
async function sleep(host, ms) { check(host); if (ms > 0) await host.sleep(ms); check(host); }
async function input(host, method, args = []) { check(host); const result = await host.input(method, args); check(host); return result; }
async function click(host, r) {
  if (!exists(r)) throw new Error('Cannot click an empty BetterGI Region');
  return input(host, 'click', [(r.globalX ?? r.x) + r.width / 2, (r.globalY ?? r.y) + r.height / 2]);
}
async function captured(host, body) { check(host); const frame = await host.capture(); try { check(host); return await body(frame); } finally { await host.vision('image.dispose', { handle: frame.handle }); } }
async function released(host, body) {
  let failed;
  try { return await body(); } catch (error) { failed = error; throw error; }
  finally { try { await host.input('releaseAll', []); } catch (error) { if (!failed) throw error; host.log?.('error', error.message); } }
}
async function recognition(host, frame, group, name) {
  return host.vision('recognition.load', { path: path.join(host.sourceRoot, 'BetterGenshinImpact/GameTask', group, 'Assets/Recognition.json'), objectName: name, width: frame.width, height: frame.height });
}
async function find(host, frame, group, name, many = false, roi) {
  const ro = await recognition(host, frame, group, name);
  if (roi) ro.roi = roi;
  return host.vision(many ? 'image.findMulti' : 'image.find', { handle: frame.handle, recognition: ro });
}
async function ocr(host, frame, roi) { return host.vision('image.ocr', { handle: frame.handle, recognition: { type: 'Ocr', ...(roi && { roi }) } }); }
async function mat(host, handle, method, args = []) { return host.vision('image.mat', { handle, method, args }); }
async function dispose(host, values) { for (const value of values.reverse()) if (value?.handle != null) await host.vision('image.dispose', { handle: value.handle }); }
async function isMap(host, frame) { return exists(await find(host, frame, 'QuickTeleport', 'MapScaleButton')) || exists(await find(host, frame, 'QuickTeleport', 'MapSettingsButton')); }
async function isMain(host, frame) {
  if (!exists(await find(host, frame, 'Common/Element', 'PaimonMenu'))) return false;
  if (!exists(await find(host, frame, 'AutoFight', 'Confirm'))) return true;
  const text = (await ocr(host, frame, [0, 0, frame.width, Math.trunc(frame.height / 2)])).map(r => r.text ?? '').join('');
  return !text.includes(host.revivalText ?? '复苏');
}
function parseTextList(text) {
  let clean = '', quoted = false, escaped = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (line) { if (c === '\n' || c === '\r') { line = false; clean += c; } continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quoted) { clean += c; if (!escaped && c === '"') quoted = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') { quoted = true; clean += c; }
    else if (c === '/' && next === '/') { line = true; i++; clean += ' '; }
    else if (c === '/' && next === '*') { block = true; i++; clean += ' '; }
    else clean += c;
  }
  if (block) throw new SyntaxError('Unterminated BetterGI text-list comment');
  let json = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) { json += c; if (!escaped && c === '"') quoted = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && /^\s*[\]}]/.test(clean.slice(i + 1))) continue;
    json += c;
  }
  return JSON.parse(json.replace(/^\uFEFF/, ''));
}
async function readOptional(filename, json = false) {
  let text;
  try { text = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!json) return text.split(/[\r\n]/).filter(Boolean);
  const list = parseTextList(text);
  if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) throw new TypeError('Expected text list: ' + filename);
  return list;
}
export async function pickKeyRecognition(host, frame, key, chat = false) {
  const ro = await recognition(host, frame, 'AutoPick', 'F');
  const normalized = String(key || 'F').trim().toUpperCase().replace(/^VK_/, '');
  const s = Math.min(frame.width / 1920, 1);
  if (normalized !== 'F') {
    const filename = path.join(path.dirname(ro.template_path), normalized + '.png');
    try { await access(filename); } catch { host.log?.('error', '加载自定义拾取按键失败，继续使用默认的F键：' + normalized); return pickKeyRecognition(host, frame, 'F', chat); }
    ro.template_path = filename; ro.template = normalized + '.png';
    ro.roi = [Math.trunc(1090 * s), Math.trunc(330 * s), Math.trunc(60 * s), Math.trunc(420 * s)];
  }
  ro.name = chat ? 'chatPick' + normalized : normalized;
  if (chat) ro.roi = [Math.trunc(1200 * s), Math.trunc(350 * s), Math.trunc(50 * s), frame.height - Math.trunc(220 * s) - Math.trunc(350 * s)];
  return { recognition: ro, key: normalized };
}

export function processPickText(text) {
  let value = String(text ?? '').replace(/\s/gu, '').replace(/[【\[]/g, '「').replace(/[】\]]/g, '」');
  value = value.replace(/^[^「\u4e00-\u9fff]+/, '').replace(/[^」！\u4e00-\u9fff]+$/, '');
  if (value.includes('「') && !value.includes('」')) value += '」';
  else if (value.includes('」') && !value.includes('「')) value = '「' + value;
  return value;
}
export function doNotPick(text) {
  return text.includes('长时间') || (text.includes('我在') && ['声望', '回声', '悬木人', '流泉'].some(s => text.includes(s))) || text.includes('聚所') || (text.includes('霜月') && text.includes('坊')) || ['叮铃', '眶螂', '西风成垒', '望崖营壁', '魔女的花园', '月谕圣牌'].some(s => text.includes(s)) || (text.includes('蛋卷') && text.includes('坊'));
}
class AutoPick {
  constructor(dispatcher, external) { this.d = dispatcher; this.host = dispatcher.host; this.c = dispatcher.config.AutoPick; this.external = external; this.lastText = ''; this.lastFrame = -1; }
  async lists() {
    if (this.loadedVersion === this.d.listVersion) return;
    const defaults = name => readOptional(path.join(this.d.configRoot, 'Pick', name), true);
    const user = name => readOptional(path.join(this.d.userRoot, name));
    if (this.c.mode === 'Blacklist') {
      this.black = new Set([...(await defaults('default_pick_black_lists.json')), ...(await user('pick_black_lists.txt'))]);
      this.fuzzy = await user('pick_fuzzy_black_lists.txt');
      this.white = new Set(this.c.blacklistModePickEnabled ? await user('pick_white_lists.txt') : []);
    } else {
      this.white = new Set([...(await defaults('default_pick_white_lists.json')), ...(await user('pick_whitelist_mode_pick_lists.txt'))]);
      if (this.c.whitelistModeDoNotPickEnabled) for (const text of await user('pick_whitelist_mode_do_not_pick_lists.txt')) this.white.delete(text);
    }
    this.loadedVersion = this.d.listVersion;
  }
  async run(frame, index) {
    const { recognition: ro, key } = await pickKeyRecognition(this.host, frame, this.c.pickKey);
    const found = await this.host.vision('image.find', { handle: frame.handle, recognition: ro });
    if (!exists(found)) {
      // Source HasScrollIcon uses these exact unscaled pixel coordinates.
      if (frame.width <= 1062 || frame.height <= 554) return;
      const colors = await Promise.all([537, 524, 554].map(y => mat(this.host, frame.handle, 'At', [y, 1062])));
      if (JSON.stringify(colors) === '[[44,233,255],[255,255,255],[255,255,255]]') { await input(this.host, 'verticalScroll', [2]); await sleep(this.host, 50); }
      return;
    }
    if (field(this.external, 'forceInteraction', false)) return this.pick(key, '直接拾取', index);
    await this.lists();
    if (exists(await find(this.host, frame, 'AutoPick', 'L'))) return;
    const s = scale(frame), c = this.c;
    const iconRoi = [found.x + Math.trunc(c.itemIconLeftOffset * s), found.y, Math.trunc((c.itemTextLeftOffset - c.itemIconLeftOffset) * s), found.height];
    const excluded = exists(await find(this.host, frame, 'AutoSkip', 'ChatIcon', false, iconRoi)) || exists(await find(this.host, frame, 'AutoPick', 'SettingsIcon', false, iconRoi));
    if (excluded && (c.mode === 'Whitelist' || !c.blacklistModePickEnabled)) return;
    const roi = { x: found.x + Math.trunc(c.itemTextLeftOffset * s), y: found.y, width: Math.trunc((c.itemTextRightOffset - c.itemTextLeftOffset) * s), height: found.height };
    if (roi.x < 0 || roi.y < 0 || roi.x + roi.width > frame.width || roi.y + roi.height > frame.height || roi.width <= 0) return;
    const result = await this.host.vision('realtime.pickText', { handle: frame.handle, roi, ocrEngine: c.ocrEngine });
    if (result.alreadyPicking) return;
    const text = processPickText(result.text);
    if (text.length <= 1 || doNotPick(text)) return;
    if (c.mode === 'Whitelist') { if (this.white.has(text)) await this.pick(key, text, index); return; }
    if (c.blacklistModePickEnabled && this.white.has(text)) return this.pick(key, text, index);
    if (excluded || this.black.has(text) || this.fuzzy.some(item => text.includes(item))) return;
    return this.pick(key, text, index);
  }
  async pick(key, text, index) {
    if (text !== this.lastText || Math.abs(index - this.lastFrame) >= 5) this.host.log?.('info', '交互或拾取：' + text);
    this.lastText = text; this.lastFrame = index;
    await input(this.host, 'keyPress', [key]);
  }
}
class AutoEat {
  constructor(dispatcher) { this.host = dispatcher.host; this.c = dispatcher.config.AutoEat; this.previous = this.lastCheck = this.lastEat = this.lastResurrection = -Infinity; this.recovery = false; this.gadgetKey = dispatcher.gadgetKey; }
  async run(frame) {
    const time = now(this.host);
    if (time - this.previous <= this.c.checkInterval) return;
    this.previous = time;
    const s = scale(frame), pixel = await mat(this.host, frame.handle, 'At', [Math.trunc(1010 * s), Math.trunc(808 * s)]);
    if (JSON.stringify(pixel) === '[90,90,255]') {
      if (time - this.lastCheck >= 30000) { this.recovery = false; this.lastCheck = time; }
      if (this.recovery || exists(await find(this.host, frame, 'AutoEat', 'RecoveryIcon'))) {
        if (!this.recovery) { this.recovery = true; this.lastCheck = time; }
        if (time - this.lastEat >= this.c.eatInterval) { await input(this.host, 'keyPress', [this.gadgetKey]); this.lastEat = time; }
      }
    }
    if (exists(await find(this.host, frame, 'AutoEat', 'ResurrectionIcon')) && time - this.lastResurrection >= 2000) { await input(this.host, 'keyPress', [this.gadgetKey]); this.lastResurrection = time; }
  }
}

export class RealtimeDispatcher {
  constructor(host, options = {}) {
    this.host = host;
    this.configRoot = options.configRoot ?? path.join(path.dirname(host.sourceRoot), 'assets/bettergi.assets.other/Assets/Config');
    this.userRoot = options.userRoot ?? path.resolve(host.sourceRoot, '../../../data/bettergi/User');
    this.random = options.random ?? Math.random; this.gadgetKey = options.gadgetKey ?? 'Z';
    this.fishing = options.fishing;
    this.config = { AutoPick: config(pickDefaults, field(options.config, 'AutoPick', field(options.config, 'AutoPickConfig'))), AutoSkip: config(skipDefaults, field(options.config, 'AutoSkip', field(options.config, 'AutoSkipConfig'))), AutoEat: config(eatDefaults, field(options.config, 'AutoEat', field(options.config, 'AutoEatConfig'))) };
    const pick = field(options.config, 'AutoPick', field(options.config, 'AutoPickConfig'));
    if (field(pick, 'whiteListEnabled') != null) { this.config.AutoPick.mode = 'Blacklist'; this.config.AutoPick.blacklistModePickEnabled = field(pick, 'whiteListEnabled'); }
    this.config.AutoPick.mode = [0, '0', 'blacklist'].includes(typeof this.config.AutoPick.mode === 'string' ? this.config.AutoPick.mode.toLowerCase() : this.config.AutoPick.mode) ? 'Blacklist' : 'Whitelist';
    this.leases = []; this.states = new Map(); this.listVersion = 0; this.frameIndex = 0; this.routeStack = [];
    this.inTask = options.inTask ?? !options.useGlobalConfig;
    if (options.useGlobalConfig) for (const name of Object.keys(priority)) if (this.config[name].enabled) this.addTrigger({ name });
    this.globalLeases = options.useGlobalConfig ? this.leases.splice(0) : [];
  }
  addTimer(timer) { this.clearAllTriggers(); return this.addTrigger(timer); }
  addTrigger(timer) {
    if (this.closed) throw new Error('RealtimeDispatcher is closed');
    if (!timer || !field(timer, 'name')) throw new TypeError('实时任务名称不能为空');
    const name = field(timer, 'name');
    if (!Object.hasOwn(priority, name)) throw new UnsupportedRealtimeOperation('Dispatcher.AddTrigger(' + name + ')', 'TaskTriggerDispatcher.ScriptTriggerTypes');
    const interval = Number(field(timer, 'interval', 50));
    if (!Number.isFinite(interval) || interval < 0) throw new RangeError('RealtimeTimer.Interval must be a nonnegative finite number');
    const options = field(timer, 'config', null);
    if (name === 'AutoSkip') {
      const c = options == null ? this.config.AutoSkip : config(skipDefaults, options);
      for (const [key, evidence] of [['autoWaitDialogueOptionVoiceEnabled', 'AutoSkip/Audio/DialogueOptionAudioWaiter.cs requires process audio and Silero VAD'], ['dialogueOptionVoiceVadDiagnosticEnabled', 'AutoSkip/Audio/DialogueOptionAudioWaiter.cs requires process audio and Silero VAD diagnostics'], ['pictureInPictureEnabled', 'View/Windows/PictureInPictureWindow.xaml'], ['bringGameToFrontAfterBackgroundDialogEnabled', 'AutoSkipTrigger.TryBringToFrontAfterBackgroundDialog/SystemControl.ActivateWindow']]) if (c[key]) throw new UnsupportedRealtimeOperation('AutoSkip.' + key, evidence);
    }
    const previous = this.states.get(name); previous?.controller.abort(retired); this.states.delete(name);
    const lease = { name, interval, config: options, disposed: false, dispose: () => {
      if (lease.disposed) return;
      lease.disposed = true; this.leases = this.leases.filter(value => value !== lease);
      const state = this.states.get(name);
      if (state?.lease === lease) { state.controller.abort(retired); this.states.delete(name); }
    } };
    this.leases.push(lease); return lease;
  }
  clearAllTriggers() { this.leases = []; for (const state of this.states.values()) state.controller.abort(retired); this.states.clear(); }
  beginTask() { this.clearAllTriggers(); this.inTask = true; }
  endTask() { this.clearAllTriggers(); this.inTask = false; }
  reloadLists() { this.listVersion++; }
  pauseAutoPick() {
    this.pickPauseCount = (this.pickPauseCount ?? 0) + 1;
    let disposed = false;
    return { dispose: () => { if (!disposed) { disposed = true; this.pickPauseCount--; } } };
  }
  beginRoute(task = {}) {
    if (this.closed) throw new Error('RealtimeDispatcher is closed');
    const scope = { leases: this.leases.slice(), disposed: false }; this.routeStack.push(scope); this.clearAllTriggers();
    try {
      const taskConfig = field(task, 'config', {});
      const triggers = field(taskConfig, 'realtime_triggers', field(taskConfig, 'realtimeTriggers', field(task, 'realtime_triggers', field(task, 'realtimeTriggers', { AutoPick: true }))));
      for (const [name, enabled] of Object.entries(triggers)) if (enabled) this.addTrigger({ name });
    } catch (error) { this.endRoute(scope); throw error; }
    return { dispose: () => this.endRoute(scope) };
  }
  endRoute(scope = this.routeStack.at(-1)) {
    if (!scope || scope.disposed) return;
    scope.disposed = true;
    while (this.routeStack.at(-1)?.disposed) { this.clearAllTriggers(); this.leases = this.routeStack.pop().leases.filter(lease => !lease.disposed); }
  }
  async tick(frame, signal) {
    signal?.throwIfAborted();
    if (this.closed || this.running) return { skipped: true, reason: this.closed ? 'closed' : 'reentrant' };
    this.running = true;
    this.idle = new Promise(resolve => { this.finish = resolve; });
    try {
      const tickHost = Object.create(this.host);
      const signals = [this.host.signal, signal].filter(Boolean);
      tickHost.signal = signals.length ? AbortSignal.any(signals) : undefined;
      check(tickHost);
      const latest = new Map((this.inTask ? this.leases : this.globalLeases).map(lease => [lease.name, lease]));
      for (const name of this.states.keys()) if (!latest.has(name)) this.states.delete(name);
      const time = now(this.host), due = [];
      for (const [name, lease] of latest) {
        if (name === 'AutoPick' && this.pickPauseCount > 0) continue;
        let state = this.states.get(name);
        if (state?.lease !== lease) {
          const controller = new AbortController();
          const triggerHost = Object.create(this.host);
          triggerHost.signal = controller.signal;
          const trigger = name === 'AutoPick' ? new AutoPick(this, lease.config) : name === 'AutoEat' ? new AutoEat(this) : new AutoSkip(this, lease.config);
          trigger.host = triggerHost;
          state = { lease, trigger, controller, next: -Infinity }; this.states.set(name, state);
        }
        if (time >= state.next) due.push(state);
      }
      const fishing = !this.inTask && this.fishing?.enabled ? this.fishing : null;
      if (this.host.realtimePauseCount > 0) return { skipped: true, reason: 'paused' };
      if (!due.length && !fishing) return { skipped: true, reason: 'notDue' };
      due.sort((a, b) => priority[b.lease.name] - priority[a.lease.name]);
      if (fishing?.exclusive) due.length = 0;
      const run = async capture => {
        this.frameIndex++;
        for (const state of due) {
          state.trigger.host.signal = tickHost.signal ? AbortSignal.any([tickHost.signal, state.controller.signal]) : state.controller.signal;
          check(state.trigger.host); state.next = time + state.lease.interval; await state.trigger.run(capture, this.frameIndex); check(state.trigger.host);
        }
        const result = { frameIndex: this.frameIndex, triggers: due.map(state => state.lease.name) };
        if (fishing) {
          result.fishing = await fishing.tick(capture, tickHost.signal); check(tickHost);
          result.triggers.push('AutoFishing');
        }
        return result;
      };
      return frame ? await run(frame) : await captured(tickHost, run);
    } catch (error) {
      try { await this.host.input('releaseAll', []); } catch (releaseError) { this.host.log?.('error', releaseError.message); }
      if (this.closed || error === retired) return { skipped: true, reason: this.closed ? 'closed' : 'changed' };
      throw error;
    } finally { this.running = false; this.finish(); this.finish = null; }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.clearAllTriggers(); this.routeStack = [];
    this.closePromise = (async () => {
      try { await this.fishing?.close(); }
      finally { if (this.running) await this.idle; await this.host.input('releaseAll', []); }
    })();
    return this.closePromise;
  }
}

async function isOrange(host, frame, r) {
  const handles = [];
  try {
    const crop = await host.vision('image.crop', { handle: frame.handle, x: r.x, y: r.y, width: r.width, height: r.height }); handles.push(crop);
    const rgb = await mat(host, crop.handle, 'CvtColor', ['BGR2RGB']); handles.push(rgb);
    const mask = await mat(host, rgb.handle, 'InRange', [[243, 195, 48], [255, 205, 55]]); handles.push(mask);
    return (await mat(host, mask.handle, 'CountNonZero')) / (crop.width * crop.height) > 0.06;
  } finally { await dispose(host, handles); }
}
function normalizeHangout(text) { return String(text ?? '').replace(/[\s\p{P}]/gu, ''); }
export function selectHangoutOption(options, keywords = []) {
  const matches = [];
  for (const keyword of keywords.map(normalizeHangout).filter(Boolean)) for (const option of options) {
    const text = normalizeHangout(option.text);
    if (text.includes(keyword)) matches.push({ option, exact: text === keyword, length: keyword.length });
  }
  matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.length - a.length || a.option.icon.y - b.option.icon.y);
  return matches[0]?.option ?? options.find(option => !option.selected) ?? options[0];
}
export function filterDialogueOcr(regions) {
  const sorted = regions.slice().sort((a, b) => a.y - b.y);
  return sorted.filter((r, i) => r.text && !(r.text.length < 5 && /^[a-zA-Z0-9]+$/.test(r.text)) && (i === sorted.length - 1 || sorted[i + 1].y - r.y <= 150));
}
class AutoSkip {
  constructor(dispatcher, external) {
    this.d = dispatcher; this.host = dispatcher.host;
    this.c = external == null ? dispatcher.config.AutoSkip : config(skipDefaults, external);
    this.custom = external != null;
    this.previous = this.playing = this.lastClick = this.lastHangout = this.dailyReward = this.lastItem = -Infinity;
    this.waitUntil = null; this.recheckUntil = -Infinity; this.pageSince = null;
  }
  async keywords() {
    if (this.pause) return;
    if (this.custom) { this.defaultPause = this.pause = this.select = []; return; }
    const load = name => readOptional(path.join(this.d.configRoot, 'Skip', name), true);
    this.defaultPause = await load('default_pause_options.json'); this.pause = await load('pause_options.json'); this.select = await load('select_options.json');
  }
  async scene(frame) { return this.host.vision('realtime.skipScene', { handle: frame.handle }); }
  async hasOption(frame) {
    if (exists(await find(this.host, frame, 'AutoSkip', 'OptionIcon'))) return true;
    const pick = await pickKeyRecognition(this.host, frame, this.d.config.AutoPick.pickKey, true);
    return exists(await this.host.vision('image.find', { handle: frame.handle, recognition: pick.recognition })) || exists(await find(this.host, frame, 'AutoSkip', 'ExclamationIcon'));
  }
  prepare() {
    const time = now(this.host);
    if (time <= this.recheckUntil) return true;
    if (this.waitUntil != null) return false;
    if (this.c.afterChooseOptionSleepDelay > 0) { this.waitUntil = time + this.c.afterChooseOptionSleepDelay; return false; }
    return true;
  }
  async choose(r, type = '') {
    if (!type && !this.prepare()) return false;
    await click(this.host, r); this.lastClick = now(this.host);
    this.host.log?.('info', '自动剧情：' + (r.text || type || '点击选项'));
    return true;
  }
  async run(frame) {
    await this.keywords();
    const time = now(this.host), isPlaying = exists(await find(this.host, frame, 'AutoSkip', 'DisabledUiButton'));
    let scene;
    const getScene = async () => scene ??= await this.scene(frame);
    if (this.waitUntil != null) {
      const target = (isPlaying && await this.hasOption(frame)) || (!(await isMain(this.host, frame)) && !(await isMap(this.host, frame)) && !!(await getScene()).bottomTriangle);
      if (!target) { this.waitUntil = null; this.recheckUntil = -Infinity; }
      else { if (time >= this.waitUntil) { this.waitUntil = null; this.recheckUntil = time + 1200; } this.pageSince = null; return; }
    }
    if (this.flow) { if (time >= this.flow.due) await this.advanceFlow(frame); return; }
    if (time - this.previous <= 200) return;
    this.previous = time;
    const background = this.c.runBackgroundEnabled && !(await this.host.isGameActive?.());
    if (this.c.autoGetDailyRewardsEnabled && time - this.dailyReward <= 10000 && exists(await find(this.host, frame, 'AutoSkip', 'Primogem'))) {
      const s = scale(frame);
      await sleep(this.host, 100); await input(this.host, 'click', [960 * s, 900 * s]); this.dailyReward = -Infinity; return;
    }
    if (!isPlaying && time - this.playing <= 10000) {
      if (this.c.closePopupPagedEnabled) {
        if (await this.closePage(frame)) return;
        if (time - this.lastItem >= 1000 && !(await isMain(this.host, frame)) && !(await isMap(this.host, frame))) {
          const triangle = (await getScene()).bottomTriangle;
          if (triangle && this.prepare()) { await click(this.host, triangle); this.lastItem = this.playing = time; return; }
        }
        const popup = (await getScene()).characterPopup;
        if (popup) {
          if (background) await click(this.host, popup);
          else await input(this.host, 'click', [100, 100]);
          this.playing = time; return;
        }
      } else this.pageSince = null;
      if (time - this.playing < 3000 && this.c.submitGoodsEnabled && exists(await find(this.host, frame, 'AutoSkip', 'SubmitExclamationIcon'))) {
        const goods = (await getScene()).goodsRects ?? [];
        if (goods.length) { await click(this.host, goods[0]); this.flow = { kind: 'goods', stage: 'put', rects: goods, index: 0, due: time + 800 }; return; }
      }
    } else this.pageSince = null;
    if (!isPlaying) {
      if (time - this.lastClick > 1200) { const rate = (await getScene()).blackRate; if (rate >= 0.5 && rate < 0.98999) { await input(this.host, 'leftButtonClick'); this.lastClick = time; } }
      return;
    }
    this.playing = time;
    if (this.c.quicklySkipConversationsEnabled) { await sleep(this.host, this.c.beforeClickConfirmDelay); await input(this.host, 'keyPress', ['SPACE']); }
    const hasOption = background ? await this.chooseWithKey(frame) : await this.chooseWithMouse(frame);
    if (this.c.autoHangoutEventEnabled && !hasOption && time - this.lastHangout >= 1200) { this.lastHangout = time; await this.hangout(frame); }
  }
  async closePage(frame) {
    if (!exists(await find(this.host, frame, 'AutoSkip', 'PageClose'))) { this.pageSince = null; return false; }
    const time = now(this.host);
    if (this.pageSince == null) { this.pageSince = time; return false; }
    if (time - this.pageSince < 200) return false;
    for (const name of ['GuidingNotes', 'ChatHistory', 'ValiantChronicles']) if (exists(await find(this.host, frame, 'AutoSkip', name))) return false;
    if (await isMap(this.host, frame)) return false;
    await input(this.host, 'keyPress', ['ESCAPE']); this.pageSince = null; return true;
  }
  async chooseWithKey(frame) {
    if (this.c.clickChatOption === '不选择选项') return false;
    const pick = await pickKeyRecognition(this.host, frame, this.d.config.AutoPick.pickKey, true);
    if (!exists(await find(this.host, frame, 'AutoSkip', 'OptionIcon')) && !exists(await this.host.vision('image.find', { handle: frame.handle, recognition: pick.recognition }))) return false;
    if (!this.prepare()) return true;
    if (this.c.clickChatOption === '随机选择选项') { for (let i = 0, n = Math.floor(this.d.random() * 5); i < n; i++) { await input(this.host, 'keyPress', ['S']); await sleep(this.host, 100); } await sleep(this.host, 50); }
    else if (this.c.clickChatOption !== '优先选择第一个选项') { await input(this.host, 'keyPress', ['W']); await sleep(this.host, 100); }
    await input(this.host, 'keyPress', [pick.key]); this.lastClick = now(this.host); return true;
  }
  async chooseWithMouse(frame) {
    const c = this.c;
    if (c.clickChatOption !== '不选择选项') { const exclamation = await find(this.host, frame, 'AutoSkip', 'ExclamationIcon'); if (exists(exclamation)) { await this.choose(exclamation); return true; } }
    const icons = (await find(this.host, frame, 'AutoSkip', 'OptionIcon', true)).sort((a, b) => b.y - a.y);
    if (!icons.length) {
      const pick = await pickKeyRecognition(this.host, frame, this.d.config.AutoPick.pickKey, true);
      if (exists(await this.host.vision('image.find', { handle: frame.handle, recognition: pick.recognition }))) await input(this.host, 'keyPress', [pick.key]);
      return false;
    }
    const low = icons[0], s = scale(frame);
    const regions = filterDialogueOcr(await ocr(this.host, frame, [Math.trunc(low.x + low.width + 8 * s), Math.trunc(frame.height / 12), Math.trunc(535 * s), Math.trunc(low.y + low.height + 30 * s - frame.height / 12)]));
    if (!regions.length) { await this.choose(c.clickChatOption === '优先选择第一个选项' ? icons.at(-1) : low); return true; }
    if (c.customPriorityOptionsEnabled && c.customPriorityOptions) {
      const words = c.customPriorityOptions.split(/[\r\n;；]/).map(value => value.trim()).filter(Boolean);
      for (const r of regions) if (words.some(word => r.text.includes(word))) { await this.choose(r); return true; }
    }
    if (c.clickChatOption === '不选择选项') return false;
    if (!c.skipBuiltInClickOptions) {
      for (const r of regions) {
        if (this.select.some(word => r.text.includes(word))) { await this.choose(r); return true; }
        if (this.pause.some(word => r.text.includes(word))) return true;
      }
      for (const r of regions) if (await isOrange(this.host, frame, r)) {
        if (c.autoGetDailyRewardsEnabled && /每日|委托/.test(r.text)) { await this.choose(r, '每日委托'); this.flow = { kind: 'daily', due: now(this.host) + 800 }; }
        else if (c.autoReExploreEnabled && /探索|派遣/.test(r.text)) { await this.choose(r, '探索派遣'); this.flow = { kind: 'expedition', machine: new ExpeditionMachine(), due: now(this.host) + 800 }; }
        else if (!/每日|委托|探索|派遣/.test(r.text)) await this.choose(r);
        return true;
      }
      if (regions.some(r => this.defaultPause.some(word => r.text.includes(word)))) return true;
    }
    const selected = c.clickChatOption === '优先选择第一个选项' ? regions[0] : c.clickChatOption === '随机选择选项' ? regions[Math.floor(this.d.random() * regions.length)] : regions.at(-1);
    await this.choose(selected); return true;
  }
  async advanceFlow(frame) {
    const flow = this.flow, time = now(this.host);
    if (flow.kind === 'daily') { const confirm = await find(this.host, frame, 'Common/Element', 'BtnBlackConfirm'); if (exists(confirm)) await click(this.host, confirm); this.dailyReward = time; this.flow = null; return; }
    if (flow.kind === 'expedition') { const done = await flow.machine.tick(this.host, frame); if (done) { this.d.lastExpedition = flow.machine.result; this.flow = null; } else flow.due = flow.machine.due; return; }
    if (flow.stage === 'put') {
      const confirm = await find(this.host, frame, 'Common/Element', 'BtnBlackConfirm');
      if (!exists(confirm)) throw new Error('AutoSkip.SubmitGoods: 放入按钮未观察到');
      await click(this.host, confirm); flow.stage = ++flow.index < flow.rects.length ? 'next' : 'deliver'; flow.due = time + (flow.stage === 'next' ? 200 : 700); return;
    }
    if (flow.stage === 'next') { await click(this.host, flow.rects[flow.index]); flow.stage = 'put'; flow.due = time + 800; return; }
    const confirm = await find(this.host, frame, 'Common/Element', 'BtnWhiteConfirm');
    if (!exists(confirm)) throw new Error('AutoSkip.SubmitGoods: 交付按钮未观察到');
    await click(this.host, confirm); this.flow = null;
  }
  async hangout(frame) {
    const selected = await find(this.host, frame, 'AutoSkip', 'HangoutSelected', true), unselected = await find(this.host, frame, 'AutoSkip', 'HangoutUnselected', true);
    const options = [];
    for (const [icons, wasSelected] of [[selected, true], [unselected, false]]) for (const icon of icons) {
      const s = scale(frame), x = icon.x + icon.width > frame.width / 2 ? icon.x + icon.width : Math.trunc(10 * s);
      const width = icon.x > frame.width / 2 ? frame.width - x - Math.trunc(10 * s) : icon.x + icon.width < frame.width / 2 ? icon.x - x : 0;
      if (width < frame.width / 8) continue;
      const roi = [x, icon.y - Math.trunc(icon.height * 2 / 3), width, icon.height + Math.trunc(icon.height * 4 / 3)];
      options.push({ icon, selected: wasSelected, text: (await ocr(this.host, frame, roi)).map(r => r.text ?? '').join('') });
    }
    if (options.length) {
      if (!this.hangoutOptions) this.hangoutOptions = JSON.parse((await readFile(path.join(this.host.sourceRoot, 'BetterGenshinImpact/GameTask/AutoSkip/Assets/hangout.json'), 'utf8')).replace(/^\uFEFF/, ''));
      const chosen = selectHangoutOption(options, this.hangoutOptions[this.c.autoHangoutEndChoose]);
      await sleep(this.host, this.c.autoHangoutChooseOptionSleepDelay); await click(this.host, chosen.icon); this.lastClick = now(this.host);
    } else if (!selected.length && !unselected.length && this.c.autoHangoutPressSkipEnabled) { const skip = await find(this.host, frame, 'AutoSkip', 'HangoutSkip'); if (exists(skip)) await click(this.host, skip); }
  }
}

class ExpeditionMachine {
  constructor() { this.stage = 'collect'; this.due = -Infinity; this.attempts = 0; this.evidence = []; }
  async tick(host, frame) {
    const time = now(host);
    if (time < this.due) return false;
    if (this.stage === 'collect') {
      const collect = await find(host, frame, 'AutoSkip', 'Collect');
      this.evidence.push({ stage: this.stage, found: exists(collect) });
      if (!exists(collect)) { if (++this.attempts >= 2) throw new Error('OneKeyExpedition: 未找到领取按钮（2帧）'); this.due = time + 1000; return false; }
      await click(host, collect); this.stage = 'redispatch'; this.attempts = 0; this.due = time + 1101; return false;
    }
    if (this.stage === 'redispatch') {
      const re = await find(host, frame, 'AutoSkip', 'Re');
      this.evidence.push({ stage: this.stage, found: exists(re) });
      if (!exists(re)) { if (++this.attempts >= 3) throw new Error('OneKeyExpedition: 未检测到再次派遣菜单（3帧）'); this.due = time + 1001; return false; }
      await click(host, re); this.stage = 'exit'; this.due = time + 500; return false;
    }
    if (this.stage === 'exit') { await input(host, 'keyPress', ['ESCAPE']); this.stage = 'verify'; this.due = time + 500; return false; }
    const remains = exists(await find(host, frame, 'AutoSkip', 'Collect')) || exists(await find(host, frame, 'AutoSkip', 'Re'));
    if (remains) throw new Error('OneKeyExpedition: 派遣页面在退出后仍可见');
    this.result = { collected: true, redispatchClicked: true, pageExited: true, verified: true, evidence: this.evidence, verification: 'original Collect/Re recognition followed by their disappearance after Escape; expedition inventory and timers not independently read' };
    return true;
  }
}
export async function runOneKeyExpedition(host) {
  return released(host, async () => {
    const machine = new ExpeditionMachine();
    for (let attempt = 0; attempt < 9; attempt++) {
      await sleep(host, Math.max(0, machine.due - now(host)));
      if (await captured(host, frame => machine.tick(host, frame))) return machine.result;
    }
    throw new Error('OneKeyExpedition: bounded transition limit reached');
  });
}
export function parseExpeditionCards(regions, { width = 1920, assetScale = Math.min(width / 1920, 1) } = {}) {
  const sorted = regions.filter(r => r.x + r.width < width / 2).slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const addition = text => /时间缩短|奖励增加|暂无加成/.test(text);
  const cards = [];
  for (const r of sorted) if (addition(r.text)) {
    const card = { name: null, idle: true, addition: r.text, rects: [r] };
    for (const line of sorted) if (line.y > r.y - 50 * assetScale && line.y + line.height < r.y + r.height) {
      if (/探险完成|探险中/.test(line.text)) { card.idle = false; const name = line.text.replaceAll('探险完成', '').replaceAll('探险中', '').replaceAll('/', '').trim(); if (name) card.name = name; }
      else if (!addition(line.text)) card.name = line.text;
      card.rects.push(line);
    }
    if (card.name) cards.push(card);
  }
  return cards;
}
export function selectExpeditionCard(cards, preferences = []) {
  const preferred = typeof preferences === 'string' ? preferences.replaceAll('，', ',').split(',').map(value => value.trim()) : preferences;
  return cards.find(card => card.idle && preferred.includes(card.name)) ?? cards.find(card => card.idle) ?? null;
}
export async function runLegacyExpedition(host, options = {}) {
  return released(host, async () => {
    let dispatched = 0, metrics; const characters = [];
    const scan = () => captured(host, frame => { metrics = { width: frame.width, height: frame.height }; return ocr(host, frame); });
    const clickText = async word => { const r = (await scan()).find(r => r.text.includes(word)); if (!r) throw new Error('ExpeditionTask: 找不到 ' + word); await click(host, r); return r; };
    const area = async () => {
      for (let i = 0; i < 5 && dispatched < 5; i++) {
        const complete = (await scan()).find(r => r.text.includes('探险完成'));
        if (!complete) return;
        const s = scale(metrics);
        await click(host, { x: complete.x, y: complete.y + Math.trunc(50 * s), width: complete.width, height: Math.trunc(80 * s) }); await sleep(host, 100);
        const collect = await clickText('领取'); await sleep(host, 200); await click(host, collect); await sleep(host, 250);
        await clickText('选择角色'); await sleep(host, 400);
        const regions = await scan(); if (!regions.some(r => r.text.includes('角色选择'))) throw new Error('ExpeditionTask: 未进入角色选择');
        const card = selectExpeditionCard(parseExpeditionCards(regions, { width: metrics.width, assetScale: scale(metrics) }), field(options, 'autoReExploreCharacter', field(options, 'characters', '')));
        if (!card) throw new Error('ExpeditionTask: 无可用空闲角色');
        await click(host, card.rects[0]); await sleep(host, 500); dispatched++; characters.push(card.name);
      }
    };
    await area();
    for (let region = 0; region <= 4 && dispatched < 5; region++) { const s = scale(metrics); await click(host, { x: Math.trunc(110 * s), y: Math.trunc((145 + 70 * region) * s), width: Math.trunc(60 * s), height: Math.trunc(33 * s) }); await sleep(host, 500); await area(); }
    return { dispatched, characters, verified: false, verification: 'original obsolete v4.3 OCR/card-selection flow replayed; new expedition timers were not observed' };
  });
}
