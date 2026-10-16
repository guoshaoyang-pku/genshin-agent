import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DailyTasks } from './daily.mjs';
import { BETTERGI_SOURCE_COMMIT, UnsupportedNativeOperation, executeCombatScript, loadAvatarCatalog, parseCombatScript } from './native.mjs';
import { ScanPickJob, LinneaMiningJob, parseLinneaParams } from './action-jobs.mjs';

// BetterGI AutoPathing/Handler and Common/Job, GPL-3.0. Resources remain in the imported source.
const handlerRoot = 'BetterGenshinImpact/GameTask/AutoPathing/Handler';
const exists = region => !!region && region.width > 0 && region.height > 0;
const params = waypoint => waypoint?.action_params ?? waypoint?.ActionParams ?? '';
function roundEven(value) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
function tryInt(value, fallback = 0) {
  const text = String(value).trim(), number = Number(text);
  return /^[+-]?\d+$/.test(text) && Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : fallback;
}
function tryDouble(value) {
  const text = String(value).trim();
  if (!/^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return 0;
  const number = Number(text.replaceAll(',', ''));
  return Number.isFinite(number) ? number : 0;
}

function originalStrings(source, name) {
  const start = source.indexOf(name + ' =');
  if (start < 0) throw new Error('Original action array missing: ' + name);
  const open = source.indexOf('[', start), close = source.indexOf('];', open);
  if (open < 0 || close < 0) throw new Error('Original action array is incomplete: ' + name);
  const body = source.slice(open + 1, close), entries = [];
  let current = '', index = 0, hasString = false;
  while (index < body.length) {
    const char = body[index];
    if (/\s/.test(char) || char === '+') { index++; continue; }
    if (char === ',') { if (hasString) entries.push(current); current = ''; hasString = false; index++; continue; }
    if (char !== '"') throw new Error('Unsupported original C# action string expression: ' + name);
    let end = index + 1, escaped = false;
    for (; end < body.length; end++) {
      if (body[end] === '"' && !escaped) break;
      escaped = !escaped && body[end] === '\\';
    }
    if (end === body.length) throw new Error('Unterminated original action string: ' + name);
    current += JSON.parse(body.slice(index, end + 1)); hasString = true; index = end + 1;
  }
  if (hasString) entries.push(current);
  if (!entries.length) throw new Error('Original action array is empty: ' + name);
  return entries;
}

export async function loadPathingActionResources(sourceRoot) {
  const files = ['MiningHandler.cs', 'PickUpCollectHandler.cs', 'ElementalCollectHandler.cs'];
  const source = await Promise.all(files.map(file => readFile(path.join(sourceRoot, handlerRoot, file), 'utf8')));
  const elemental = [...source[2].matchAll(/new ElementalCollectAvatar\("([^"]+)",\s*ElementalType\.(\w+),\s*(true|false),\s*(true|false)\)/g)]
    .map(([, name, element, normalAttack, elementalSkill]) => ({ name, element, normalAttack: normalAttack === 'true', elementalSkill: elementalSkill === 'true' }));
  if (!elemental.length) throw new Error('Original elemental collection configs are missing');
  return {
    mining: originalStrings(source[0], '_miningActions'), pickup: originalStrings(source[1], 'PickUpActions'), elemental,
    provenance: { sourceCommit: BETTERGI_SOURCE_COMMIT, files: Object.fromEntries(files.map((file, index) => [handlerRoot + '/' + file, createHash('sha256').update(source[index]).digest('hex')])) },
  };
}

export function circularMotion(index, speed = 1.1) {
  if (!Number.isInteger(index) || index < 0 || !(speed > 0)) throw new RangeError('Invalid circular motion arguments');
  const circleT = 33000, radiusT = circleT / (2 * Math.PI), viewResetT = 350 * speed;
  const mixAngle = (viewResetT / circleT + 0.25) * 2 * Math.PI;
  const arc = (radius, angle) => [radius * (1 - Math.cos(angle)), radius * Math.sin(angle)];
  const [mixX, mixY] = arc(viewResetT / mixAngle, mixAngle), edgeT = 600 + index * 400;
  const angle = (edgeT / circleT + 0.25) * Math.PI, [restX, restY] = arc(radiusT, 2 * angle - mixAngle);
  const x = mixX - restX, y = mixY + restY;
  return { edgeT: edgeT / speed, radiusT: Math.hypot(x, y) / (2 * Math.sin(angle)) / speed, endAngle: angle - mixAngle + Math.atan2(x, y) + Math.PI / 2 };
}

export class PathingActionError extends Error {
  constructor(action, code, message) { super(message); this.name = 'PathingActionError'; this.action = action; this.code = code; }
}

export class PathingActions extends DailyTasks {
  constructor(host, options = {}) {
    super(host); this.options = options; this.daily = options.daily ?? this; this.dpi = options.dpi ?? 1;
    if (!(this.dpi > 0) || !Number.isFinite(this.dpi)) throw new RangeError('dpi must be positive');
    this.modelRoot = options.modelRoot ?? path.resolve(host.sourceRoot, '../assets/bettergi.assets.model/Assets/Model');
  }
  checkAbort() { this.host.signal?.throwIfAborted(); }
  async sleep(ms) {
    this.checkAbort();
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid delay: ' + ms);
    if (ms) await this.host.sleep(ms);
    this.checkAbort();
  }
  async input(method, args = []) { this.checkAbort(); return this.host.input(method, args); }
  async released(body) {
    let failure;
    try { this.checkAbort(); const result = await body(); this.checkAbort(); return result; }
    catch (error) { failure = error; throw error; }
    finally {
      try { await this.host.input('releaseAll', []); }
      catch (error) { if (!failure) throw error; this.host.log?.('error', 'Remote input release failed: ' + error.message); }
    }
  }
  async held(method, args, ms, endMethod = method.replace(/Down$/, 'Up')) {
    await this.input(method, args);
    try { await this.sleep(ms); } finally { await this.host.input(endMethod, args); }
  }
  now() { return this.host.now?.() ?? performance.now(); }
  fail(action, code, message) { throw new PathingActionError(action, code, message); }
  async resources() { return this.resourcePromise ??= this.options.resources ? Promise.resolve(this.options.resources) : loadPathingActionResources(this.host.sourceRoot); }
  async aliases() { return (await (this.catalogPromise ??= loadAvatarCatalog(this.host.sourceRoot))).aliases; }
  async combat(operation, args = {}) {
    this.checkAbort();
    if (typeof this.host.combat !== 'function') throw new UnsupportedNativeOperation('combat.' + operation);
    return this.host.combat(operation, args);
  }
  async team() {
    const team = await this.combat('initializeTeam');
    if (!Array.isArray(team) || !team.length || team.some(avatar => typeof avatar.name !== 'string')) this.fail('team', 'missingTeam', '队伍识别未初始化成功');
    return team;
  }
  async switch(avatar) {
    if (!avatar) this.fail('switch', 'missingAvatar', 'Required collection avatar is absent from the observed team');
    const result = await this.combat('switchAvatar', avatar);
    if (result !== true && result?.switched !== true) this.fail('switch', 'switchUnverified', '切人失败: ' + avatar.name);
  }
  async strategy(text, team) {
    const script = parseCombatScript(text, { aliases: await this.aliases() });
    // Native scripts may switch per command; verify those switches before any following input.
    const host = Object.create(this.host), action = this;
    host.combat = async function(operation, args) {
      if (operation === 'switchAvatar') { await action.switch(args); return true; }
      return action.combat(operation, args);
    };
    return executeCombatScript(script, host, { team, dpi: this.dpi });
  }
  async motion() {
    return this.captured(async frame => {
      if (!exists(await this.find(frame, 'Common/Element', 'SpaceKey'))) return 'Normal';
      return exists(await this.find(frame, 'Common/Element', 'XKey')) ? 'Climb' : 'Fly';
    });
  }

  async run(action, { waypoint = {}, config } = {}) {
    return this.released(async () => {
      const value = params(waypoint);
      if (action === 'nahida_collect') return this.nahida();
      if (['hydro_collect', 'electro_collect', 'anemo_collect', 'pyro_collect'].includes(action)) return this.elemental(action.slice(0, -8));
      if (action === 'pick_around') return this.pickAround(value);
      if (action === 'mining') return this.mining(value);
      if (action === 'pick_up_collect') return this.pickup(value);
      if (action === 'use_gadget') return this.gadget(value);
      if (action === 'up_down_grab_leaf') return this.leaf(value);
      if (action === 'stop_flying') return this.stopFlying(value);
      if (action === 'linnea_mining') {
        await this.switch((await this.team()).find(avatar => avatar.name === '莉奈娅')); await this.sleep(500);
        return new LinneaMiningJob(this).run(parseLinneaParams(value));
      }
      if (action === 'set_time') {
        if (!value) return { skipped: true, reason: 'emptyParams' };
        const fields = value.split(':'), hour = tryInt(fields[0], NaN), minute = tryInt(fields[1], NaN);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new TypeError('set_time requires integer hour and minute');
        let skipAnimation = true;
        if (fields.length > 2) { const bool = fields[2].trim().toLowerCase(); if (!['true', 'false'].includes(bool)) throw new TypeError('Invalid set_time skipAnimation'); skipAnimation = bool === 'true'; }
        return this.daily.setTime(hour, minute, skipAnimation);
      }
      if (action === 'exit_and_relogin') return this.exitAndRelogin();
      if (action === 'wonderland_cycle') return this.wonderland();
      if (action === 'normal_attack' || action === 'elemental_skill') {
        await this.input(action === 'normal_attack' ? 'leftButtonClick' : 'keyPress', action === 'normal_attack' ? [] : ['VK_E']);
        await this.sleep(1000); return { executed: true, outcomeVerified: false };
      }
      if (action === 'combat_script') {
        const script = waypoint.combatScript ?? parseCombatScript(value, { aliases: await this.aliases(), validate: false });
        const team = await this.team(), host = Object.create(this.host), owner = this;
        host.combat = async function(op, args) { if (op === 'switchAvatar') { await owner.switch(args); return true; } return owner.combat(op, args); };
        return executeCombatScript(script, host, { team, dpi: this.dpi });
      }
      if (action === 'fight') return this.fight(waypoint, config);
      if (action === 'fishing') { const result = await this.task('autoFishing', { config: this.options.autoFishingConfig ?? {}, waypoint }); await this.sleep(1000); return result; }
      throw new UnsupportedNativeOperation('navigation.action.' + action);
    });
  }

  async nahida() {
    const avatar = (await this.team()).find(item => item.name === '纳西妲');
    await this.switch(avatar); await this.combat('waitSkillCd', { name: avatar.name });
    const x = Math.trunc(400 * this.dpi); let y = Math.trunc(-30 * this.dpi);
    await this.input('moveMouseBy', [0, 10000]); await this.sleep(200);
    await this.input('keyDown', ['VK_E']);
    try {
      await this.sleep(200);
      for (let i = 0; i < 15; i++) { await this.input('moveMouseBy', [x, 500]); await this.sleep(30); }
      for (let i = 59; i >= 0; i--) { if (i === 40) y -= Math.trunc(20 * this.dpi); await this.input('moveMouseBy', [x, y]); await this.sleep(30); }
    } finally {
      await this.host.input('keyUp', ['VK_E']);
      if (!this.host.signal?.aborted) { await this.sleep(200); await this.combat('afterUseSkill', { name: avatar.name }); }
    }
    await this.sleep(800); await this.input('middleButtonClick'); await this.sleep(1000);
    return { executed: true, avatar: avatar.name, outcomeVerified: false };
  }
  async elemental(element) {
    const configs = (await this.resources()).elemental.filter(item => item.element.toLowerCase() === element);
    const avatar = (await this.team()).find(item => configs.some(config => config.name === item.name));
    await this.switch(avatar);
    const config = configs.find(item => item.name === avatar.name);
    if (config.normalAttack) { await this.input('leftButtonClick'); await this.sleep(200); }
    else if (config.elementalSkill) { await this.combat('waitSkillCd', { name: avatar.name }); await this.combat('useSkill', { name: avatar.name, hold: false }); }
    return { executed: true, avatar: avatar.name, element, outcomeVerified: false };
  }
  async pickAround(value) {
    const turns = tryInt(value, 1); let oldRadius = 0, angle = 0;
    const moveAfterTurn = async (key, ms) => {
      await this.input('keyPress', [key]); await this.sleep(200); await this.input('middleButtonClick'); await this.sleep(500);
      if (ms > 0) { await this.held('keyDown', ['VK_W'], ms, 'keyUp'); await this.sleep(200); }
    };
    for (let i = 0; i < turns; i++) {
      const circle = circularMotion(i), x = circle.radiusT - oldRadius * Math.cos(angle), y = oldRadius * Math.sin(angle);
      await this.input('middleButtonClick'); await this.sleep(500);
      await moveAfterTurn('VK_S', roundEven(y) + 200); await moveAfterTurn('VK_A', roundEven(x));
      await this.input('keyDown', ['VK_A']);
      try { await this.sleep(30); for (let side = 0; side < 6; side++) { await this.input('middleButtonClick'); await this.sleep(roundEven(circle.edgeT)); } }
      finally { await this.host.input('keyUp', ['VK_A']); }
      await this.sleep(200); oldRadius = circle.radiusT; angle = circle.endAngle;
    }
    return { turns: Math.max(0, turns), outcomeVerified: false };
  }
  async mining(value) {
    const team = await this.team(), aliases = await this.aliases();
    const script = (await this.resources()).mining.find(text => team.some(avatar => avatar.name === aliases.get(text.slice(0, text.indexOf(' ')))));
    if (!script) this.fail('mining', 'missingAvatar', 'No original mining strategy matches the observed team');
    const result = await this.strategy(script, team); let scan;
    if (value.toLowerCase().includes('disablepickuparound')) { await this.sleep(1000); scan = await this.scanPick(); }
    return { ...result, ...(scan ? { scan } : {}), outcomeVerified: false };
  }
  async pickup(value) {
    const team = await this.team(), resources = await this.resources(), aliases = await this.aliases();
    const names = [...new Set(resources.pickup.map(text => text.split(' ')[0].split('-')[0]))];
    const requests = value ? value.split(',').map(token => aliases.get(token) ?? token) : [names.find(name => team.some(avatar => avatar.name === name))].filter(Boolean);
    const executed = [];
    for (const request of requests) {
      const name = names.find(item => request.startsWith(item)) ?? request, avatar = team.find(item => item.name === name);
      if (!avatar) continue;
      let text = resources.pickup.find(item => item.toLowerCase().startsWith(request.toLowerCase() + ' '));
      const specific = !!text;
      if (!text && names.includes(request)) text = resources.pickup.find(item => item.startsWith(request));
      if (!text) this.fail('pick_up_collect', 'unknownCommand', 'No original pickup command matches ' + request);
      await this.switch(avatar); await this.combat('waitSkillCd', { name });
      await this.strategy(name + text.slice(text.indexOf(' ')), team);
      if (specific) { await this.sleep(200); await this.combat('afterUseSkill', { name }); }
      executed.push(request);
    }
    if (!executed.length) this.fail('pick_up_collect', 'missingAvatar', 'No original pickup command can execute with the observed team');
    return { executed, outcomeVerified: false };
  }
  async gadget(value) {
    await this.input('keyPress', ['VK_Z']); let cooldown = null, waitMs = 0;
    if (!value.toLowerCase().includes('not_wait')) {
      const maximum = value ? tryDouble(value) : 100;
      cooldown = await this.captured(async frame => {
        const scale = Math.min(frame.width / 1920, 1), handles = [];
        try {
          const crop = await this.host.vision('image.crop', { handle: frame.handle, x: frame.width - Math.trunc(130 * scale), y: Math.trunc(814 * scale), width: Math.trunc(60 * scale), height: Math.trunc(24 * scale) }); handles.push(crop.handle);
          const hsv = await this.host.vision('image.mat', { handle: crop.handle, method: 'CvtColor', args: ['BGR2HSV'] }); handles.push(hsv.handle);
          const mask = await this.host.vision('image.mat', { handle: hsv.handle, method: 'InRange', args: [[0, 0, 235], [0, 25, 255]] }); handles.push(mask.handle);
          const text = await this.host.vision('image.ocrWithoutDetector', { handle: mask.handle });
          return tryDouble(typeof text === 'string' ? text : text.text);
        } finally { for (const handle of handles.reverse()) await this.host.vision('image.dispose', { handle }); }
      });
      if (cooldown > 0 && cooldown <= 100) { waitMs = cooldown > maximum ? Math.trunc(maximum * 1000) : Math.trunc(cooldown * 1000) + 100; await this.sleep(waitMs); }
    }
    await this.input('keyPress', ['VK_Z']); await this.sleep(300);
    return { executed: true, cooldownObserved: cooldown, waitMs, outcomeVerified: false };
  }
  async detectLeaf() {
    return this.captured(async frame => {
      // Original helper skips out-of-bounds points, even if an entire group is outside the frame.
      for (const shift of [0, 120, -104]) {
        let match = true;
        for (const [x, y] of [[1500, 1000], [1508, 1041], [1500, 987], [1500, 1010]]) {
          if (x + shift < 0 || x + shift >= frame.width || y < 0 || y >= frame.height) continue;
          const pixel = await this.host.vision('image.mat', { handle: frame.handle, method: 'At', args: [y, x + shift] });
          if (!Array.isArray(pixel) || pixel.length < 3 || pixel.slice(0, 3).some(channel => channel < 245 || channel > 255)) { match = false; break; }
        }
        if (match) return true;
      }
      return false;
    });
  }
  async leaf(value) {
    let vertical = 1000 * (!value || value === 'up' ? 1 : -1), remaining = 40, consecutive = 0;
    while (remaining > 0) {
      this.checkAbort(); if (remaining % 10 === 0) vertical = -vertical;
      if (await this.detectLeaf()) {
        if (++consecutive >= 2) {
          await this.input('keyPress', ['VK_T']); await this.sleep(200); await this.input('middleButtonClick');
          for (let i = 0; i < 20; i++) {
            if (await this.motion() === 'Fly') { await this.sleep(200); return { executed: true, flyingVerified: true }; }
            await this.input('keyPress', ['VK_SPACE']); await this.sleep(500);
          }
          await this.sleep(200); this.fail('up_down_grab_leaf', 'flightUnverified', 'Leaf interaction did not reach the source Fly state');
        }
        await this.sleep(150);
      } else { consecutive = 0; await this.input('moveMouseBy', [0, vertical]); await this.sleep(100); remaining--; }
    }
    await this.input('middleButtonClick'); await this.sleep(300);
    this.fail('up_down_grab_leaf', 'leafNotFound', '没有找到四叶印');
  }
  async stopFlying(value) {
    const wait = tryInt(value, null);
    if (value && wait !== null) { await this.input('keyPress', ['VK_SPACE']); await this.sleep(wait); await this.input('keyPress', ['VK_SPACE']); await this.sleep(300); }
    await this.input('leftButtonClick');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await this.motion() !== 'Fly') return { executed: true, flyingEndedVerified: true, attempts: attempt + 1 };
      await this.sleep(300);
    }
    this.fail('stop_flying', 'landingTimeout', 'StopFlying exhausted the original 50 motion checks');
  }
  scanPick(seconds = this.options.autoFightConfig?.PickDropsAfterFightSeconds ?? 15) { return new ScanPickJob(this).run(seconds); }

  async waitElement(group, name, action, count, interval, { disappear = false, screenshotAction = false } = {}) {
    for (let attempt = 1; attempt <= count; attempt++) {
      this.checkAbort();
      if (!screenshotAction) { await action?.(); await this.sleep(interval); }
      const found = await this.captured(async frame => {
        const region = await this.find(frame, group, name), present = exists(region);
        if (screenshotAction && present) await action(frame, region);
        return present;
      });
      if (found !== disappear) return { verified: true, attempts: attempt };
      if (screenshotAction) await this.sleep(interval);
    }
    this.fail(name, disappear ? 'elementStillPresent' : 'elementAbsent', 'Source retry limit exhausted for ' + group + '/' + name);
  }
  async exitAndRelogin() {
    if (this.options.login3rdParty === 'Bilibili') throw new UnsupportedNativeOperation('login3rdParty.Bilibili');
    const auto = 'AutoWood';
    await this.waitElement(auto, 'MenuBag', () => this.input('keyPress', ['VK_ESCAPE']), 10, 1200);
    await this.waitElement(auto, 'Confirm', () => this.captured(frame => { const scale = Math.min(frame.width / 1920, frame.height / 1080); return this.input('click', [50 * scale, frame.height - 50 * scale]); }), 5, 800);
    await this.waitElement(auto, 'Confirm', (_, region) => this.click(region), 5, 1000, { disappear: true, screenshotAction: true });
    await this.sleep(1000);
    await this.waitElement(auto, 'EnterGame', null, 120, 1000);
    await this.waitElement(auto, 'EnterGame', () => this.fixed('click', 955, 666), 120, 1000, { disappear: true });
    await this.waitElement('Common/Element', 'PaimonMenu', null, 120, 1000); await this.sleep(500);
    return { verified: true, completion: 'mainUiAfterRelogin' };
  }
  async wonderland() {
    const common = 'Common/Element';
    await this.waitElement(common, 'WonderlandClose', () => this.input('keyPress', ['VK_F6']), 10, 1000);
    await this.waitElement(common, 'BtnBlackConfirm', () => this.fixed('click', 680, 310), 5, 800);
    await this.waitElement(common, 'BtnBlackConfirm', (_, region) => this.click(region), 5, 1000, { disappear: true, screenshotAction: true });
    await this.sleep(1000); await this.waitElement(common, 'PaimonMenu', null, 120, 1000); await this.sleep(500);
    await this.waitElement(common, 'BtnBackTeyvat', () => this.input('keyPress', ['VK_ESCAPE']), 20, 800);
    await this.waitElement(common, 'BtnBlackConfirm', () => this.captured(async frame => { const region = await this.find(frame, common, 'BtnBackTeyvat'); if (exists(region)) await this.click(region); }), 5, 800);
    await this.waitElement(common, 'BtnBlackConfirm', (_, region) => this.click(region), 5, 1000, { disappear: true, screenshotAction: true });
    await this.sleep(1000); await this.waitElement(common, 'PaimonMenu', null, 120, 1000); await this.sleep(500);
    return { verified: true, completion: 'mainUiAfterWonderlandCycle' };
  }
  async task(operation, payload) {
    if (typeof this.host.task !== 'function') throw new UnsupportedNativeOperation('task.' + operation);
    const result = await this.host.task(operation, payload);
    if (result?.completed !== true) this.fail(operation, 'taskIncomplete', 'Task adapter did not report actual task completion: ' + operation);
    return result;
  }
  async fight(waypoint, partyConfig) {
    const config = structuredClone(partyConfig?.Enabled && partyConfig.AutoFightEnabled ? partyConfig.AutoFightConfig ?? {} : this.options.autoFightConfig ?? {});
    const split = waypoint.enable_monster_loot_split ?? waypoint.EnableMonsterLootSplit;
    const tag = waypoint.monster_tag ?? waypoint.MonsterTag;
    const mode = config.OnlyPickEliteDropsMode;
    let suspendAutoPick = false;
    if (split && !['elite', 'legendary'].includes(tag) && ['AllowAutoPickupForNonElite', 'DisableAutoPickupForNonElite'].includes(mode)) {
      config.KazuhaPickupEnabled = false; config.PickDropsAfterFightEnabled = false;
      suspendAutoPick = mode === 'DisableAutoPickupForNonElite';
    }
    return this.task('autoFight', { config, waypoint, suspendAutoPick, autoPickResumeDelaySeconds: 5 });
  }
}
