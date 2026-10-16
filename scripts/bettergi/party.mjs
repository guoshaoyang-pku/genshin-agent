// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI SwitchPartyTask, PathingPartyConfig and PathExecutor party lifecycle.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DailyTasks } from './daily.mjs';
import { UnsupportedNativeOperation } from './native.mjs';
import { loadPathingActionResources } from './actions.mjs';
import { RealtimeDispatcher } from './realtime.mjs';
import { runSwitchCharacter } from './party-character.mjs';

const exists = region => !!region && region.width > 0 && region.height > 0;
const field = (value, key, fallback) => { const name = Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name === undefined ? fallback : value[name]; };
const actionElements = { hydro_collect: 'Hydro', electro_collect: 'Electro', anemo_collect: 'Anemo', pyro_collect: 'Pyro' };
const actionChinese = { nahida_collect: '纳西妲采集', hydro_collect: '水元素采集', electro_collect: '雷元素采集', anemo_collect: '风元素采集', pyro_collect: '火元素采集' };

export class PartySetupFailedError extends Error {
  constructor(message) { super(message); this.name = 'PartySetupFailedError'; this.code = 'PARTY_SETUP_FAILED'; }
}
export class PartyRecoveryRetry extends Error {
  constructor(receipt) { super('回血完成后重试路线'); this.name = 'PartyRecoveryRetry'; this.code = 'PATH_RETRY'; this.receipt = receipt; }
}

export function cleanPartyName(text) { return text.replaceAll('"', '').replaceAll('\r\n', '').replaceAll('\r', '').split('\n', 1)[0].trim(); }

export function defaultConditionConfig() {
  return { MapMatchingMethod: 'TemplateMatch', PartyConditions: [], AvatarConditions: [
    { Subject: '队伍中角色', Object: ['绮良良', '莱依拉', '茜特菈莉', '芭芭拉', '七七'], Result: '循环短E' },
    { Subject: '队伍中角色', Object: ['钟离'], Result: '循环长E' },
    { Subject: '队伍中角色', Object: ['迪希雅'], Result: '作为主要行走角色' },
  ], OnlyInTeleportRecover: false, UseGadgetIntervalMs: 0, AutoEatEnabled: false };
}

export function partyConfig(value = {}, conditions = defaultConditionConfig(), fallback = false) {
  const result = {
    Enabled: !fallback, AutoPickEnabled: true, PartyName: '', SkipPartySwitch: false, IsVisitStatueBeforeSwitchParty: false,
    MainAvatarIndex: '', GuardianAvatarIndex: '', GuardianElementalSkillSecondInterval: '', GuardianElementalSkillLongPress: false,
    OnlyInTeleportRecover: fallback ? field(conditions, 'OnlyInTeleportRecover', false) : false, RecoverTiming: null,
    JsScriptUseEnabled: true, SoloTaskUseFightEnabled: true, SkipDuring: '', UseGadgetIntervalMs: fallback ? field(conditions, 'UseGadgetIntervalMs', 0) : 0,
    AutoSkipEnabled: true, AutoRunEnabled: true, AutoEatEnabled: fallback ? field(conditions, 'AutoEatEnabled', false) : false,
    AutoFightEnabled: !fallback, AutoFightConfig: {}, Distance: 45, ApproachStopDistance: 25, HurryOnAvatar: '', HurryOnFrameInterval: 100,
    TravelMode: '精准靠近', SwitchToWalkEnabled: false, MwkJumpFlyEnabled: true, MwkJumpFlyDistance: 75, MwkJumpFlyIntervalSeconds: 1,
    MwkDisableSprintEnabled: false, MwkJumpFlySprintCount: 0,
  };
  for (const key of Object.keys(result)) result[key] = field(value, key, result[key]);
  for (const [key, item] of Object.entries(value)) if (!Object.keys(result).some(name => name.toLowerCase() === key.toLowerCase())) result[key] = item;
  const timingSource = fallback ? conditions : value;
  let timing = field(value, 'RecoverTiming', field(timingSource, 'RecoverTiming', null));
  if (timing == null) timing = result.OnlyInTeleportRecover ? 1 : 0;
  if (typeof timing === 'string' && ['AnyWaypoint', 'OnlyTeleport', 'Never'].includes(timing)) timing = ['AnyWaypoint', 'OnlyTeleport', 'Never'].indexOf(timing);
  if (![0, 1, 2].includes(timing)) throw new RangeError('Unknown PathingPartyConfig.RecoverTiming');
  result.RecoverTiming = timing;
  result.ApproachStopDistance = Math.min(result.ApproachStopDistance, result.Distance);
  if (result.MwkJumpFlyDistance <= result.Distance) result.MwkJumpFlyDistance = result.Distance + 1;
  return result;
}

export function filterPartyName(task, conditions, materialName) {
  const positions = field(task, 'Positions', []), rules = field(conditions, 'PartyConditions', []);
  for (const action of new Set(positions.map(position => field(position, 'Action', '')).filter(Boolean))) {
    if (!actionChinese[action]) continue;
    const rule = rules.find(rule => field(rule, 'Subject') === '动作' && field(rule, 'Object', []).includes(actionChinese[action]));
    if (rule && field(rule, 'Result') != null) return field(rule, 'Result');
  }
  const matching = materialName ? rules.find(rule => field(rule, 'Subject') === '采集物' && field(rule, 'Object', []).includes(materialName)) : null;
  if (matching && field(matching, 'Result') != null) return field(matching, 'Result');
  return field(rules.find(rule => field(rule, 'Subject') === '采集物' && field(rule, 'Object', []).includes('全部')), 'Result', null);
}

export function buildConditionalPartyConfig(team, conditions = defaultConditionConfig()) {
  const config = partyConfig({}, conditions, true), rules = field(conditions, 'AvatarConditions', []);
  for (const rule of rules) {
    const result = field(rule, 'Result');
    if (!['循环短E', '循环长E'].includes(result)) continue;
    const avatar = team.find(avatar => field(rule, 'Object', []).includes(avatar.name));
    if (!avatar) continue;
    config.GuardianAvatarIndex = String(avatar.index); config.GuardianElementalSkillLongPress = result === '循环长E';
    config.GuardianElementalSkillSecondInterval = String(result === '循环长E' ? avatar.skillHoldCD ?? avatar.skillHoldCd ?? 0 : avatar.skillCD ?? avatar.skillCd ?? 0);
    break;
  }
  for (const rule of rules) {
    if (field(rule, 'Result') !== '作为主要行走角色') continue;
    const avatar = team.find(avatar => field(rule, 'Object', []).includes(avatar.name));
    if (avatar) { config.MainAvatarIndex = String(avatar.index); break; }
  }
  return config;
}

export class PartyTasks extends DailyTasks {
  constructor(host, options = {}, state = {}) { super(host); this.options = options; this.state = state; }
  check() { this.host.signal?.throwIfAborted(); }
  setupFail(message) { throw new PartySetupFailedError(message); }
  async sleep(ms) { this.check(); await this.host.sleep(ms); this.check(); }
  async input(method, args = []) { this.check(); return this.host.input(method, args); }
  async released(body) {
    let failure;
    try { this.check(); const result = await body(); this.check(); return result; }
    catch (error) { failure = error; throw error; }
    finally {
      try { await this.host.input('releaseAll', []); }
      catch (error) { if (!failure) throw error; this.host.log?.('error', 'Party input release failed: ' + error.message); }
    }
  }
  async combat(operation, args = {}) {
    this.check();
    if (typeof this.host.combat !== 'function') throw new UnsupportedNativeOperation('combat.' + operation);
    return this.host.combat(operation, args);
  }
  async clearCache() {
    this.state.partyName = null; this.state.team = null;
    if (typeof this.host.clearTeamCache === 'function') return this.host.clearTeamCache();
    if (typeof this.host.combat !== 'function') throw new UnsupportedNativeOperation('combat.clearTeam');
    return this.host.combat('clearTeam', {});
  }
  async waitFor(test, attempts, interval) {
    for (let i = 0; i < attempts; i++) { await this.sleep(interval); if (await this.captured(test)) return true; }
    return false;
  }
  scale(frame) { return Math.min(frame.width / 1920, frame.height / 1080, 1); }
  async partyNameIn(frame, button) {
    if (!exists(button)) return null;
    const regions = await this.ocr(frame, [button.x + button.width, button.y, Math.trunc(350 * this.scale(frame)), button.height]);
    return cleanPartyName(regions.map(region => region.text).join('\n'));
  }
  async whiteConfirm(frame, roi) {
    const recognition = { ...await this.recognition('Common/Element', 'BtnWhiteConfirm', frame), roi };
    const button = await this.host.vision('image.find', { handle: frame.handle, recognition });
    if (exists(button)) { await this.click(button); return true; }
    return false;
  }
  async confirmParty(pattern, returnAfter) {
    await this.captured(frame => this.whiteConfirm(frame, [0, Math.trunc(frame.height / 4), Math.trunc(frame.width / 4), frame.height - Math.trunc(frame.height / 4)]));
    if (!await this.waitFor(async frame => !exists(await this.find(frame, 'Common/Element', 'PartyBtnDelete')), 10, 1000)) throw new PartySetupFailedError('选择队伍失败，等待队伍切换超时');
    await this.sleep(200);
    await this.captured(frame => this.whiteConfirm(frame, [frame.width - Math.trunc(frame.width / 4), Math.trunc(frame.height / 4), Math.trunc(frame.width / 4), frame.height - Math.trunc(frame.height / 4)]));
    await this.sleep(500);
    const observed = await this.captured(async frame => this.partyNameIn(frame, await this.find(frame, 'Common/Element', 'PartyBtnChooseView')));
    if (observed == null || !pattern.test(observed)) throw new PartySetupFailedError('队伍切换提交后未观察到匹配的当前队伍名称');
    if (returnAfter) await this.returnMainUi();
    return observed;
  }
  async switchParty(name) { return this.released(() => this.switchPartyTask(name)); }
  async switchPartyTask(name) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Party name must be a nonempty regular expression');
    const pattern = new RegExp(name);
    const initial = await this.captured(async frame => ({ party: exists(await this.find(frame, 'Common/Element', 'PartyBtnChooseView')), main: await this.isInMainUi(frame) }));
    const returnAfter = !initial.party;
    if (!initial.party) {
      if (!initial.main) { await this.returnMainUi(); await this.sleep(200); if (!await this.isInMainUi()) throw new Error('未能返回主界面'); }
      let opened = false;
      for (let attempt = 0; attempt < 2 && !opened; attempt++) {
        await this.input('keyPress', ['L']);
        opened = await this.waitFor(async frame => exists(await this.find(frame, 'Common/Element', 'PartyBtnChooseView')), 7, 600);
      }
      if (!opened) throw new PartySetupFailedError('未能打开队伍配置界面');
    }
    await this.sleep(500);
    const current = await this.captured(async frame => {
      const button = await this.find(frame, 'Common/Element', 'PartyBtnChooseView');
      return { button, name: await this.partyNameIn(frame, button), scale: this.scale(frame) };
    });
    if (!exists(current.button)) throw new PartySetupFailedError('队伍配置按钮在打开后消失');
    if (current.name != null && pattern.test(current.name)) {
      if (returnAfter) { await this.input('keyPress', ['VK_ESCAPE']); await this.sleep(500); await this.returnMainUi(); }
      this.state.partyName = name; this.state.lastSwitch = { changed: false, verified: true, observedName: current.name };
      return true;
    }
    let menu = false;
    for (let attempt = 0; attempt < 4 && !menu; attempt++) {
      await this.click(current.button); await this.sleep(500);
      menu = await this.captured(async frame => exists(await this.find(frame, 'Common/Element', 'PartyBtnDelete')));
    }
    if (!menu) throw new PartySetupFailedError('未能打开队伍选择页面');
    let deleteButton;
    // Fresh frames replace the original repeated test of one disposed menu capture.
    if (!await this.waitFor(async frame => exists(deleteButton = await this.find(frame, 'Common/Element', 'PartyBtnDelete')), 5, 1000)) throw new PartySetupFailedError('未能打开队伍选择页面');
    await this.sleep(50); await this.fixed('click', 700, 125); await this.sleep(50);
    await this.leftHeld(() => this.sleep(450)); await this.sleep(100);
    const s = current.scale, roi = [0, Math.trunc(80 * s), deleteButton.x + deleteButton.width, deleteButton.y - Math.trunc(80 * s)];
    if (roi[3] <= 0) throw new PartySetupFailedError('队伍列表识别区域无效');
    for (let page = 0; page < 16; page++) {
      const regions = await this.captured(frame => this.ocr(frame, roi));
      if (!regions.length) break;
      const target = regions.find(region => pattern.test(region.text));
      if (target) {
        await this.clearCache();
        await this.input('click', [target.x + target.width + 100 * s, target.y + target.height]); await this.sleep(200);
        const observedName = await this.confirmParty(pattern, returnAfter);
        this.state.partyName = name;
        this.state.lastSwitch = { changed: true, verified: true, observedName, page: page + 1 };
        return true;
      }
      const lowest = regions.filter(region => region.x > 35 * s && region.x < 100 * s).sort((a, b) => b.y - a.y)[0];
      if (!lowest || lowest.y < 777 * s) break;
      if (page === 0) { await this.fixed('click', 600, 200); await this.sleep(300); }
      await this.input('click', [roi[0] + roi[2] / 2, lowest.y + lowest.height]); await this.sleep(400);
    }
    await this.returnMainUi(); this.state.lastSwitch = { changed: false, verified: false, reason: 'partyNotFound' };
    return false;
  }
  async switchCharacter(slots, usePhysicalSlots = true) { return this.released(() => runSwitchCharacter(this, slots, usePhysicalSlots)); }
  conditions(options = {}) { return field(options, 'PathingConditionConfig', field(options, 'conditionConfig', field(this.options, 'conditionConfig', defaultConditionConfig()))); }
  config(options = {}) {
    const value = field(options, 'partyConfig', this.state.partyConfig ?? this.options.partyConfig);
    return partyConfig(value ?? {}, this.conditions(options), value == null);
  }
  async materialName(task, options) {
    const explicit = field(options, 'materialName', field(task, 'materialName', null));
    if (explicit != null) return explicit;
    const fullPath = field(task, 'FullPath', null), basePath = field(options, 'pathJsonRoot', this.options.pathJsonRoot);
    if (!fullPath || !basePath) return null;
    const source = await readFile(path.join(this.host.sourceRoot, 'BetterGenshinImpact/Model/ConditionDefinition.cs'), 'utf8');
    const list = source.match(/ObjectOptions\s*=\s*new List<string>\s*\{([\s\S]*?)\}/)?.[1];
    if (!list) throw new Error('Original material condition list is missing');
    const names = new Set([...list.matchAll(/"([^"]+)"/g)].map(match => match[1]));
    return path.relative(basePath, fullPath).split(path.sep).slice(1, -1).find(name => names.has(name)) ?? null;
  }
  async reviveModal(frame) {
    const regions = await this.ocr(frame, [0, Math.trunc(frame.height / 4) * 3, frame.width, Math.trunc(frame.height / 4)]);
    const button = regions.find(region => region.text.includes('复苏'));
    if (!button) return false;
    await this.click(button); return true;
  }
  async waitMainUi() {
    if (!await this.waitFor(frame => this.isInMainUi(frame), 10, 1000)) throw new PartySetupFailedError('复苏后未观察到主界面');
  }
  async statue({ verifyHp = false, pauseAfter = true } = {}) {
    if (typeof this.host.genshin !== 'function') throw new UnsupportedNativeOperation('genshin.tpToStatueOfTheSeven');
    await this.host.genshin('tpToStatueOfTheSeven', []);
    if (pauseAfter) await this.sleep(5000);
    if (!await this.isInMainUi()) throw new PartySetupFailedError('七天神像传送未观察到主界面');
    if (verifyHp && await this.captured(frame => this.host.vision('party.lowHp', { handle: frame.handle }))) throw new PartySetupFailedError('七天神像传送后仍观察到低血量');
    return { teleported: true, mainUiVerified: true, lowHpCleared: verifyHp };
  }
  async observedTeam() {
    const team = await this.combat('initializeTeam', { force: true, requireObserved: true });
    if (!Array.isArray(team) || !team.length) throw new PartySetupFailedError('无法识别队伍角色');
    const observation = await this.captured(frame => this.host.vision('party.recognize', { handle: frame.handle }));
    if (!Array.isArray(observation.avatars) || observation.avatars.length !== team.length || team.some(avatar => !observation.avatars.some(item => item.name === avatar.name && item.index === avatar.index))) throw new PartySetupFailedError('队伍缓存与当前画面识别不一致');
    this.state.team = team; return team;
  }
  async prepareRoute({ task, options = {} } = {}) {
    return this.released(async () => {
      if (!task || !Array.isArray(field(task, 'Positions'))) throw new TypeError('Party route preparation requires route Positions');
      const conditions = this.conditions(options); let config = this.config(options), switched = false, multiplayer = false;
      await this.captured(async frame => {
        if (await this.reviveModal(frame)) { await this.waitMainUi(); await this.sleep(4000); await this.statue({ verifyHp: true }); }
      });
      if (!config.SkipPartySwitch) {
        multiplayer = await this.captured(async frame => (await this.find(frame, 'AutoFight', 'P', true)).length > 0);
        const name = multiplayer ? null : config.Enabled ? config.PartyName : filterPartyName(task, conditions, await this.materialName(task, options));
        if (name) {
          if (config.Enabled && config.IsVisitStatueBeforeSwitchParty) await this.statue({ pauseAfter: false });
          try { switched = await this.switchPartyTask(name); }
          catch (error) {
            this.check();
            if (!(error instanceof PartySetupFailedError) || config.Enabled && config.IsVisitStatueBeforeSwitchParty) throw error;
            await this.statue({ pauseAfter: false }); switched = await this.switchPartyTask(name);
          }
          if (!switched) throw new PartySetupFailedError('切换队伍失败，无法执行此路径');
          await this.combat('clearTeam');
        }
      }
      const team = await this.observedTeam();
      if (!config.Enabled) { const skip = config.SkipPartySwitch; config = buildConditionalPartyConfig(team, conditions); config.SkipPartySwitch = skip; }
      const actions = new Set(field(task, 'Positions').map(position => field(position, 'Action', '')).filter(Boolean));
      if (actions.has('nahida_collect') && !team.some(avatar => avatar.name === '纳西妲')) throw new PartySetupFailedError('路径需要纳西妲采集，当前队伍中没有纳西妲');
      if (Object.keys(actionElements).some(action => actions.has(action))) {
        const resources = await loadPathingActionResources(this.host.sourceRoot);
        for (const [action, element] of Object.entries(actionElements)) if (actions.has(action) && !team.some(avatar => resources.elemental.some(item => item.name === avatar.name && item.element === element))) throw new PartySetupFailedError('路径元素采集动作缺少原版配置支持的角色: ' + action);
      }
      if (!await this.isInMainUi()) throw new PartySetupFailedError('路径开始前未观察到主界面');
      this.state.partyConfig = config;
      return { ready: true, verified: true, partyConfig: config, team, switched, multiplayer, mainUiVerified: true };
    });
  }
  async tryHealing(config) {
    const team = this.state.team ?? await this.observedTeam();
    const switchMain = async () => {
      if (!config.MainAvatarIndex) return;
      if (!await this.combat('trySwitchAvatar', { index: Number(config.MainAvatarIndex), tryTimes: 5 })) return;
      await this.sleep(100);
    };
    for (const avatar of team) {
      if (!['白术', '希格雯', '珊瑚宫心海'].includes(avatar.name)) continue;
      if (!await this.combat('trySwitchAvatar', { index: avatar.index })) { if (avatar.name !== '珊瑚宫心海') break; continue; }
      await this.input('keyPress', ['E']);
      if (avatar.name === '白术') { await this.sleep(800); await this.input('keyPress', ['E']); await this.sleep(800); await switchMain(); await this.sleep(4000); }
      else if (avatar.name === '希格雯') { await this.sleep(11000); await switchMain(); }
      else { await this.sleep(500); await this.input('keyPress', ['Q']); await switchMain(); await this.sleep(5000); }
      return { performed: true, healer: avatar.name };
    }
    return { performed: false };
  }
  async recoverWhenLowHp({ waypoint, options = {} } = {}) {
    return this.released(async () => {
      const config = this.config(options);
      if (config.RecoverTiming === 2 || config.RecoverTiming === 1 && field(waypoint, 'Type') !== 'teleport') return { acted: false, reason: 'recoverTiming' };
      const initial = await this.captured(async frame => {
        const lowHp = await this.host.vision('party.lowHp', { handle: frame.handle });
        return { lowHp, revived: !lowHp && await this.reviveModal(frame) };
      });
      if (initial.lowHp) {
        const healing = await this.tryHealing(config);
        // The original reuses the pre-heal frame and inverts this condition.
        const stillLow = await this.captured(frame => this.host.vision('party.lowHp', { handle: frame.handle }));
        if (healing.performed && !stillLow) return { acted: true, verified: true, lowHpCleared: true, ...healing };
        const receipt = await this.statue({ verifyHp: true });
        throw new PartyRecoveryRetry({ ...receipt, healing });
      }
      if (initial.revived) { await this.waitMainUi(); await this.sleep(4000); throw new PartyRecoveryRetry({ ...await this.statue({ verifyHp: true }), revived: true }); }
      return { acted: false, verified: true, lowHp: false };
    });
  }
  async resolveAnomalies({ frame, options = {} } = {}) {
    return this.released(async () => {
      const examine = async capture => {
        let other = false;
        for (const [group, name] of [['AutoSkip', 'Cook'], ['AutoSkip', 'PageCloseMain'], ['Common/Element', 'PageCloseWhite'], ['AutoSkip', 'PageClose']]) if (exists(await this.find(capture, group, name))) other = true;
        if (!other) return { closedPage: false };
        if (exists(await this.find(capture, 'QuickTeleport', 'MapScaleButton')) || exists(await this.find(capture, 'QuickTeleport', 'MapSettingsButton'))) return { bigMap: true, closedPage: false };
        await this.input('keyPress', ['VK_ESCAPE']); await this.sleep(1000); return { closedPage: true };
      };
      const result = frame ? await examine(frame) : await this.captured(examine);
      if (result.bigMap) return { ...result, acted: false };
      result.welkin = await this.blessingOfTheWelkinMoon();
      if (!this.config(options).AutoSkipEnabled || !await this.captured(async capture => exists(await this.find(capture, 'AutoSkip', 'DisabledUiButton')))) return result;
      const dispatcher = new RealtimeDispatcher(this.host);
      const lease = dispatcher.addTrigger({ name: 'AutoSkip', config: { Enabled: true, QuicklySkipConversationsEnabled: true, ClosePopupPagedEnabled: true, ClickChatOption: '优先选择最后一个选项' } });
      let missing = 0, iterations = 0, failure;
      try {
        while (true) {
          this.check(); iterations++;
          await this.captured(async capture => {
            if (exists(await this.find(capture, 'AutoSkip', 'DisabledUiButton'))) { await dispatcher.tick(capture, this.host.signal); missing = 0; }
            else missing++;
          });
          if (missing > 10) break;
          await this.sleep(210);
        }
        return { ...result, autoSkip: { verified: true, completion: 'elevenConsecutiveAbsentFrames', iterations } };
      } catch (error) { failure = error; throw error; }
      finally {
        lease.dispose();
        try { await dispatcher.close(); }
        catch (error) { if (!failure) throw error; this.host.log?.('error', 'Party AutoSkip cleanup failed: ' + error.message); }
      }
    });
  }
}
