// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI CombatScenes, Avatar, AvatarSpecialActions and ESkillCdTracker.
import { NativeTasks, UnsupportedNativeOperation, loadAvatarCatalog } from './native.mjs';
import { FightSeek } from './fight-seek.mjs';

const exists = region => !!region && region.width > 0 && region.height > 0;
const field = (value, key, fallback) => { const name = Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name === undefined ? fallback : value[name]; };
const now = host => host.now?.() ?? performance.now();
const check = host => host.signal?.throwIfAborted();
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function input(host, method, args = []) { check(host); return host.input(method, args); }

export function parseManualSkillCd(name, text = '') {
  for (const entry of text.split(';').reverse()) {
    if (entry !== name && !entry.startsWith(name + ',')) continue;
    const value = entry.slice(name.length + 1).trim();
    return value && /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value.replaceAll(',', ''))) ? Number(value.replaceAll(',', '')) : -1;
  }
  return null;
}

export class CombatTasks extends NativeTasks {
  constructor(host, options = {}, state = {}) {
    super(host); this.options = options; this.state = state;
    state.team ??= []; state.skillTracker ??= new Map(); state.skipCheckCounter ??= 0;
    state.exclusiveCount ??= 0;
  }
  async exclusive(body) {
    this.state.exclusiveCount++;
    try { return await body(); } finally { this.state.exclusiveCount--; }
  }
  async catalog() { return this.state.catalog ??= await loadAvatarCatalog(this.host.sourceRoot); }
  async buildTeam(observed) {
    const catalog = await this.catalog();
    return observed.map(avatar => {
      const original = catalog.avatars.find(item => item.name === avatar.name);
      if (!original || !Number.isInteger(avatar.index) || avatar.index < 1 || avatar.index > 4) throw new Error('队伍识别返回未知角色配置或编号');
      return { ...original, ...avatar, skillCD: original.skillCD ?? 0, skillHoldCD: original.skillHoldCD ?? 0,
        manualSkillCd: parseManualSkillCd(avatar.name, field(this.options, 'ActionSchedulerByCd', '')) ?? -1, lastSkillAt: -Infinity, ocrReadyAt: -Infinity };
    });
  }
  async initializeTeam({ force = false, requireObserved = false } = {}) {
    if (!force && !requireObserved && this.state.team.length) return this.state.team;
    const catalog = await this.catalog();
    const forced = field(this.options, 'TeamNames', '');
    if (forced && !requireObserved) {
      const names = forced.split(/[,，]/).map(name => name.trim());
      if (names.length !== 4) throw new Error('强制指定队伍角色数量不正确，必须是4个，当前' + names.length);
      const canonical = names.map(name => {
        const resolved = catalog.aliases.get(name);
        if (!resolved) throw new Error('角色名称校验失败：' + name);
        return resolved;
      });
      const assets = await this.captured(frame => this.host.vision('party.assets', { handle: frame.handle }));
      if (assets.avatarIndexRects?.length !== 4) throw new Error('强制队伍缺少原始角色编号区域');
      this.state.team = await this.buildTeam(canonical.map((name, i) => ({ name, index: i + 1, indexRect: assets.avatarIndexRects[i] })));
      return this.state.team;
    }
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      check(this.host);
      if (attempt) await sleep(this.host, 1000);
      let result;
      try { result = await this.captured(frame => this.host.vision('party.recognize', { handle: frame.handle })); }
      catch (error) { check(this.host); lastError = error; continue; }
      const team = result.avatars, count = result.indexRects?.length;
      if (!Array.isArray(team) || !count || team.length !== count) { lastError = new Error('角色识别数量不匹配'); continue; }
      this.state.team = await this.buildTeam(team);
      this.state.multiGameStatus = result.multiGameStatus;
      return this.state.team;
    }
    throw new Error('识别队伍角色失败：原版五次重试已耗尽', { cause: lastError });
  }
  clearTeam() { this.state.team = []; this.state.lastSwitchTarget = null; }
  async avatar({ name, index } = {}) {
    const team = await this.initializeTeam(), catalog = await this.catalog();
    const canonical = catalog.aliases.get(name) ?? name;
    const avatar = name ? team.find(avatar => avatar.name === canonical) : team.find(avatar => avatar.index === index);
    if (!avatar) throw new Error('队伍中不存在请求的角色: ' + (name ?? index));
    return avatar;
  }
  async active(frame, context = {}) {
    const team = await this.initializeTeam();
    const result = await this.host.vision('party.active', { handle: frame.handle, indexRects: team.map(avatar => avatar.indexRect), context });
    Object.assign(context, result.context);
    if (result.index > 0) { this.state.lastActiveIndex = result.index; return result.index; }
    const failures = context.totalCheckFailedCount;
    if (failures > 0 && failures < 10 && failures % 3 === 0) {
      const layout = await this.host.vision('party.layout', { handle: frame.handle });
      if (layout.recognizedIndexCount === team.length && layout.indexRects.length === team.length) {
        for (let i = 0; i < team.length; i++) team[i].indexRect = layout.indexRects[i];
        context.totalCheckFailedCount = 0;
      }
    }
    return result.index;
  }
  async currentAvatar() {
    const context = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(this.host, 50);
      const index = await this.captured(frame => this.active(frame, context));
      const avatar = this.state.team.find(avatar => avatar.index === index);
      if (avatar) return avatar.name;
    }
    throw new Error('无法确认当前出战角色');
  }
  async throwWhenDefeated(frame) {
    if (!exists(await this.find(frame, 'AutoFight', 'Confirm'))) return;
    const regions = await this.host.vision('image.ocr', { handle: frame.handle, recognition: { roi: [0, 0, frame.width, Math.trunc(frame.height / 2)] } });
    if (!regions.some(region => region.text.includes(this.host.revivalText ?? '复苏'))) return;
    await input(this.host, 'keyPress', ['VK_ESCAPE']); await sleep(this.host, 600);
    if (typeof this.host.genshin !== 'function') throw new UnsupportedNativeOperation('genshin.tpToStatueOfTheSeven');
    try { await this.host.genshin('tpToStatueOfTheSeven', []); }
    catch (error) { check(this.host); this.host.log?.('error', '复苏传送失败: ' + error.message); }
    throw Object.assign(new Error('角色被击败，七天神像恢复后重试当前任务'), { code: 'PATH_RETRY' });
  }
  async simulateSwitch(index) { await input(this.host, 'keyPress', ['X']); await input(this.host, 'keyPress', [String(index)]); }
  async unstuck(index) {
    await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, 200);
    const direction = ['W', 'S', 'A', 'D'][Math.floor((this.host.random?.() ?? Math.random()) * 4)];
    try { await input(this.host, 'keyDown', [direction]); await this.simulateSwitch(index); await sleep(this.host, 1000); await input(this.host, 'leftButtonClick'); }
    finally { await this.host.input('releaseAll', []); }
  }
  async switchAvatar(args = {}, tryMode = false) {
    return this.exclusive(() => this.switchAvatarCore(args, tryMode));
  }
  async switchAvatarCore(args = {}, tryMode = false) {
    const avatar = await this.avatar(args), context = {};
    const attempts = tryMode ? args.tryTimes ?? 4 : 30;
    if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('Switch attempts must be positive');
    let resend = tryMode && this.state.lastSwitchTarget !== avatar.index;
    if (tryMode) this.state.lastSwitchTarget = avatar.index;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const active = await this.captured(async frame => { await this.throwWhenDefeated(frame); return this.active(frame, context); });
      if (active === avatar.index) { if (resend) await this.simulateSwitch(avatar.index); return true; }
      await this.simulateSwitch(avatar.index); resend = false;
      if (this.state.fightActive && attempt === (tryMode ? 9 : 10)) await this.unstuck(avatar.index);
      await sleep(this.host, 250);
    }
    if (tryMode) return false;
    throw new Error('切换角色未得到画面确认: ' + avatar.name);
  }
  remaining(avatar) {
    const time = now(this.host);
    if (avatar.manualSkillCd > 0) return Math.max(0, (avatar.lastSkillAt + avatar.manualSkillCd * 1000 - time) / 1000);
    if (avatar.manualSkillCd === 0) return 0;
    const max = Math.max(avatar.skillCD, avatar.skillHoldCD);
    const readyAt = avatar.lastSkillAt >= avatar.ocrReadyAt ? avatar.lastSkillAt + max * 1000 : avatar.ocrReadyAt;
    return Math.min(max, Math.max(0, (readyAt - time) / 1000));
  }
  record(name, cd) { if (cd > 0) this.state.skillTracker.set(name, now(this.host) + cd * 1000); return cd > 0 ? cd : 0; }
  fallback(avatar) {
    if (!['莉奈娅', '玛薇卡', '法尔伽'].includes(avatar.name)) return 0;
    const full = avatar.skillCD > 0 ? avatar.skillCD : avatar.skillHoldCD;
    if (!(full > 0)) return 0;
    const remaining = Math.max(0, ((this.state.skillTracker.get(avatar.name) ?? -Infinity) - now(this.host)) / 1000);
    return this.record(avatar.name, avatar.name !== '莉奈娅' && remaining > 0 ? Math.min(full, remaining) : full);
  }
  async afterUseSkill(args, frame) {
    const avatar = await this.avatar(args); avatar.lastSkillAt = now(this.host);
    if (avatar.manualSkillCd > 0) return this.remaining(avatar);
    const read = async capture => {
      const result = await this.host.vision('party.skill', { handle: capture.handle, nameEn: avatar.nameEn, maxSkillCd: avatar.skillCD,
        enableClassifier: field(this.options, 'EnableESkillClassify', false), onlyCode01Ready: args.onlyCode01Ready ?? true });
      if (result.state === 'Ready' && String(result.code).toLowerCase() === '01') avatar.ocrReadyAt = now(this.host);
      if (result.cd > 0) { avatar.ocrReadyAt = now(this.host) + result.cd * 1000; this.record(avatar.name, result.cd); }
      return result.cd ?? 0;
    };
    return frame ? read(frame) : this.captured(read);
  }
  async useSkill(args) {
    const avatar = await this.avatar(args);
    if (args.hold && ['纳西妲', '坎蒂丝'].includes(avatar.name)) {
      await input(this.host, 'keyDown', ['E']);
      try {
        if (avatar.name === '坎蒂丝') await sleep(this.host, 3000);
        else { await sleep(this.host, 300); for (let i = 0; i < 10; i++) { await input(this.host, 'moveMouseBy', [1000, 0]); await sleep(this.host, 50); } await sleep(this.host, 300); }
      } finally { await this.host.input('keyUp', ['E']); }
      return { issued: true, specialized: true, cooldownObserved: false };
    }
    if (args.hold) { await input(this.host, 'keyDown', ['E']); try { await sleep(this.host, 1000); } finally { await this.host.input('keyUp', ['E']); } }
    else await input(this.host, 'keyPress', ['E']);
    const deadline = now(this.host) + 200; let cd = 0;
    while (cd <= 0 && now(this.host) < deadline) { await sleep(this.host, 35); cd = this.record(avatar.name, await this.afterUseSkill(args)); }
    if (cd <= 0) cd = this.record(avatar.name, await this.afterUseSkill(args));
    const observed = cd > 0;
    if (cd <= 0) cd = this.fallback(avatar);
    return { issued: true, cooldownObserved: observed, cd, fallbackApplied: !observed && cd > 0 };
  }
  async ready() {
    await sleep(this.host, 10);
    for (let i = 0; i < 20; i++) {
      if (await this.captured(async frame => (await this.host.vision('party.layout', { handle: frame.handle })).recognizedIndexCount > 0)) return { ready: true };
      await sleep(this.host, 150);
    }
    throw new Error('技能动画结束后未观察到角色编号');
  }
  async useBurst(args) {
    await this.avatar(args);
    const initial = await this.captured(frame => this.host.vision('party.burst', { handle: frame.handle }));
    if (initial.state !== 'Ready') return { issued: false, state: initial.state, castObserved: false };
    for (let attempt = 1; attempt <= 10; attempt++) {
      await input(this.host, 'keyPress', ['Q']); await sleep(this.host, 200);
      const completion = await this.captured(async frame => {
        await this.throwWhenDefeated(frame);
        if ((await this.host.vision('party.layout', { handle: frame.handle })).recognizedIndexCount === 0) return 'avatarIndexesDisappeared';
        if ((await this.host.vision('party.burst', { handle: frame.handle })).state !== 'Ready') return 'burstStateChanged';
        return null;
      });
      if (completion) { await sleep(this.host, 1500); return { issued: true, castObserved: true, completion, attempts: attempt }; }
    }
    throw new Error('元素爆发按键已发送十次，但未观察到施放');
  }
  async checkFight(args = {}) {
    if (!field(this.options, 'FightFinishDetectEnabled', false)) return false;
    return this.exclusive(() => this.checkFightCore(args));
  }
  async checkFightCore(args = {}) {
    const config = field(this.options, 'FinishDetectConfig', {}), time = now(this.host);
    this.state.lastFightCheckAt = time;
    if (time - (this.state.fightStartAt ?? -Infinity) < Math.min(10, Math.max(0, field(config, 'BlockCheckBeforeBattleSeconds', 0))) * 1000) return false;
    if (field(config, 'SkipFightEndCheckWhenEnemyVisible', false) && this.state.skipCheckCounter < 5) {
      const visible = await this.captured(async frame => (await this.host.vision('party.bloodBars', { handle: frame.handle })).some(bar => bar.x > Math.trunc(200 * Math.min(frame.width / 1920, frame.height / 1080, 1))));
      if (visible) { this.state.skipCheckCounter++; return false; }
    }
    this.state.skipCheckCounter = 0;
    const delay = args.delayTime ?? 1500, detectDelay = args.detectDelayTime ?? Math.trunc((String(field(config, 'BeforeDetectDelay', '')).trim() !== '' && Number.isFinite(Number(field(config, 'BeforeDetectDelay', ''))) ? Number(field(config, 'BeforeDetectDelay', '')) : .45) * 1000);
    const rotate = field(config, 'RotateFindEnemyEnabled', false), seeker = rotate ? new FightSeek(this.host, this.state) : null;
    if (rotate) {
      let result;
      try { result = await seeker.seek({ delayTime: delay, detectDelayTime: detectDelay, rotaryFactor: field(this.options, 'RotaryFactor', field(config, 'RotaryFactor', 6)) }); }
      catch (error) { check(this.host); this.host.log?.('error', '旋转寻敌失败: ' + error.message); result = false; }
      this.state.rotationCount = result === null ? (this.state.rotationCount ?? 0) + 1 : 0;
      if (result !== null) return result;
    } else await sleep(this.host, delay);
    await input(this.host, 'keyPress', ['L']);
    if (field(config, 'PaimonEndCheckEnabled', true)) {
      const paimonDelay = Math.trunc(Math.min(.4, Math.max(.05, field(config, 'PaimonEndCheckDelay', .075))) * 1000);
      await sleep(this.host, paimonDelay);
      if (await this.isInMainUi()) { await input(this.host, 'keyPress', ['X']); return false; }
      await sleep(this.host, Math.max(0, detectDelay - paimonDelay));
    } else await sleep(this.host, detectDelay);
    const finished = await this.captured(async frame => {
      const yellow = await this.host.vision('image.mat', { handle: frame.handle, method: 'At', args: [50, 790] });
      const white = await this.host.vision('image.mat', { handle: frame.handle, method: 'At', args: [50, 768] });
      return yellow[2] >= 200 && yellow[1] >= 200 && yellow[0] <= 100 && white.every(channel => channel >= 240);
    });
    await input(this.host, 'keyPress', ['X']);
    if (finished) await input(this.host, 'keyPress', ['L']);
    else seeker?.moveForward();
    return finished;
  }
  async charge({ name, ms = 1000 }) {
    return this.exclusive(() => this.chargeCore({ name, ms }));
  }
  async chargeCore({ name, ms = 1000 }) {
    if ((await this.avatar({ name })).name !== '桑多涅') throw new UnsupportedNativeOperation('combat.charge.' + name);
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('Charge duration must be positive');
    const interval = field(this.options, 'TargetingDetectionInterval', 50);
    if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('Targeting detection interval must be positive');
    const start = now(this.host), dpi = field(this.options, 'dpi', 1);
    let lastSeen = null, overheats = 0, completion = 'duration';
    await input(this.host, 'leftButtonDown');
    try {
      while (now(this.host) - start < ms) {
        const stop = await this.captured(async frame => {
          if (now(this.host) - start >= 3000) {
            const heat = await this.host.vision('party.overheat', { handle: frame.handle });
            overheats = heat.overheated ? overheats + 1 : 0;
            if (overheats >= 3) { completion = 'overheat'; return true; }
          }
          const aim = { x: Math.trunc(frame.width * .5), y: Math.trunc(frame.height * 480 / 1080) };
          const bars = (await this.host.vision('party.bloodBars', { handle: frame.handle })).filter(bar => bar.x > Math.trunc(200 * Math.min(frame.width / 1920, frame.height / 1080, 1)));
          const legendary = bars.some(bar => bar.legendary);
          let target;
          if (bars.length && !legendary) {
            target = bars.map(bar => ({ x: bar.x + Math.trunc(bar.width / 2), y: bar.y + Math.trunc(bar.height / 2) })).sort((a, b) => Math.abs(a.x - aim.x) + Math.abs(a.y - aim.y) - Math.abs(b.x - aim.x) - Math.abs(b.y - aim.y))[0];
          } else { const damage = await this.host.vision('party.damageNumber', { handle: frame.handle, mode: field(this.options, 'DamageNumberRecognitionMode', 'Color') }); if (damage) target = { x: damage.centerX, y: damage.centerY }; }
          if (target) { lastSeen = now(this.host); await input(this.host, 'moveMouseBy', [Math.trunc((target.x - aim.x) * .35 * dpi), Math.trunc((target.y - aim.y) * .25 * dpi)]); }
          else {
            if (!legendary && now(this.host) - (lastSeen ?? start) >= 1500) { completion = 'targetLost'; return true; }
            if (lastSeen === null || now(this.host) - lastSeen >= field(this.options, 'LockLostWaitTime', .5) * 1000) await input(this.host, 'moveMouseBy', [Math.trunc(1000 * dpi), 0]);
          }
          return false;
        });
        if (stop) break;
        await sleep(this.host, interval);
      }
      return { issued: true, completion, elapsedMs: now(this.host) - start, outcomeVerified: false };
    } finally { await this.host.input('leftButtonUp', []); }
  }
  async call(operation, args = {}) {
    check(this.host);
    if (operation === 'clearTeam') return this.clearTeam();
    if (operation === 'initializeTeam') return this.initializeTeam(args);
    if (operation === 'currentAvatar') return this.currentAvatar();
    if (operation === 'switchAvatar') return this.switchAvatar(args);
    if (operation === 'trySwitchAvatar') return this.switchAvatar(args, true);
    if (operation === 'isSkillReady') return this.remaining(await this.avatar(args)) <= 0;
    if (operation === 'getSkillCdSeconds') return this.remaining(await this.avatar(args));
    if (operation === 'waitSkillCd') { const cd = this.remaining(await this.avatar(args)); if (cd > 0) await sleep(this.host, Math.ceil((cd + .2) * 1000)); return; }
    if (operation === 'afterUseSkill') return this.afterUseSkill(args);
    if (operation === 'useSkill') return this.useSkill(args);
    if (operation === 'useBurst') return this.useBurst(args);
    if (operation === 'ready') return this.ready();
    if (operation === 'check') return this.checkFight(args);
    if (operation === 'charge') return this.charge(args);
    throw new UnsupportedNativeOperation('combat.' + operation);
  }
}
