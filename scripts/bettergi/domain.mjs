// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoDomainTask at c9db8b8291fe4ac25a600aee1582298005919eb2.
import path from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { ResinTasks, buildResinRecords } from './resin.mjs';
import { loadTeleportCatalog } from './navigation.mjs';
import { createTaskParamTypes } from './task-params.mjs';
import { AutoFightTask } from './fight.mjs';
import { executeCombatCommand } from './native.mjs';
import { ChooseFOptionTask, findPickInteraction } from './f-option.mjs';
import { DEVELOPMENT_GUIDE, selectDevelopmentGuideDestination, selectDevelopmentGuideLevel } from './domain-guide.mjs';

const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const exists = region => region?.width > 0 && region?.height > 0;
const cleanHost = host => Object.create(host, { signal: { value: null } });
const roundEven = value => { const floor = Math.floor(value); return value - floor === .5 ? floor % 2 ? floor + 1 : floor : Math.round(value); };
const done = new Error('Domain stage complete');
const optionsDefaults = { FightEndDelay: 5, ShortMovement: false, WalkToF: true, LeftRightMoveTimes: 3, AutoEat: false, ReviveRetryCount: 3, RewardRecognitionEnabled: false };

export function domainParameters(config = {}, taskConfig = {}, sourceRoot) {
  const { AutoDomainParam } = createTaskParamTypes({ getConfig: () => config, ...(sourceRoot ? { combatRoot: path.resolve(sourceRoot, '../scripts/repo/combat') } : {}) });
  const param = new AutoDomainParam();
  for (const key of Object.keys(param)) param[key] = field(taskConfig, key, param[key]);
  if (param.DomainRoundNum === 0) param.DomainRoundNum = 9999;
  if (!Number.isInteger(param.DomainRoundNum) || param.DomainRoundNum < 1) throw new TypeError('DomainRoundNum must be a nonnegative integer');
  const global = field(config, 'AutoDomainConfig', {});
  const options = Object.fromEntries(Object.entries(optionsDefaults).map(([key, fallback]) => [key, field(global, key, fallback)]));
  for (const key of ['FightEndDelay', 'LeftRightMoveTimes', 'ReviveRetryCount']) if (!Number.isFinite(options[key]) || options[key] < 0) throw new RangeError('Invalid AutoDomainConfig.' + key);
  if (!Number.isInteger(options.ReviveRetryCount) || options.ReviveRetryCount < 1) throw new RangeError('AutoDomainConfig.ReviveRetryCount must be a positive integer');
  return { param, options };
}

export class AutoDomainTask extends ResinTasks {
  constructor(host, { config = {}, taskConfig = {}, partyState = {}, combatState = {}, strategies, comboSession } = {}) {
    super(host); this.config = config; Object.assign(this, domainParameters(config, taskConfig, host.sourceRoot));
    this.partyState = partyState; this.combatState = combatState; this.strategies = strategies; this.comboSession = comboSession;
    this.resinRecords = buildResinRecords(this.param); this.summary = {};
    this.receipt = { completion: null, domain: this.param.DomainName, rounds: [], retries: [], resinUses: [], rewardObservations: [], verified: false };
  }
  key(name, fallback) { return field(field(this.config, 'KeyBindingsConfig', {}), name, fallback); }
  async input(method, args = []) { this.host.signal?.throwIfAborted(); return this.host.input(method, args); }
  async sleep(ms) { this.host.signal?.throwIfAborted(); await this.host.sleep(ms); this.host.signal?.throwIfAborted(); }
  async held(key, ms) { await this.input('keyDown', [key]); try { await this.sleep(ms); } finally { await cleanHost(this.host).input('keyUp', [key]); } }
  async textPattern(key) { this.patternCache ??= new Map(); if (!this.patternCache.has(key)) this.patternCache.set(key, (await this.patterns([key]))[0]); return this.patternCache.get(key); }
  async relativeOcr(frame, roi) { return this.ocr(frame, [roi[0] * frame.width, roi[1] * frame.height, roi[2] * frame.width, roi[3] * frame.height].map(Math.trunc)); }
  async text(frame, key, roi) { const pattern = await this.textPattern(key); return (await this.relativeOcr(frame, roi)).find(row => pattern.test(row.text)); }
  async waitFor(observe, attempts, delay) {
    for (let attempt = 0; attempt < attempts; attempt++) { const result = await this.captured(observe); if (result) return result; if (attempt < attempts - 1) await this.sleep(delay); }
    return null;
  }
  async waitMainUi(attempts = 30) { if (!await this.waitFor(frame => this.isInMainUi(frame), attempts, 1000)) throw new Error('秘境结束后未观察到主界面'); }
  pick(frame) { return findPickInteraction(this.host, frame, field(field(this.config, 'AutoPickConfig', {}), 'PickKey', 'VK_F')); }
  async domains() {
    if (!this.domainMap) this.domainMap = new Map((await loadTeleportCatalog(this.host.sourceRoot)).scenes.get('Teyvat').points.filter(point => ['BlessDomain', 'ForgeryDomain', 'MasteryDomain'].includes(point.type)).map(point => [point.name, point]));
    return this.domainMap;
  }
  async teleport() {
    if (this.param.DomainName === DEVELOPMENT_GUIDE) this.guideDomainName = await selectDevelopmentGuideDestination(this);
    const name = this.guideDomainName ?? this.param.DomainName;
    if (!name) return;
    const point = (await this.domains()).get(name);
    if (!point) throw new Error('未找到对应的秘境' + name + '的传送点');
    this.receipt.domain = name;
    this.receipt.teleport = await this.host.genshin('tp', [point.x, point.y]); await this.sleep(1000); await this.waitMainUi();
    let key = name === '芬德尼尔之顶' ? this.key('MoveBackward', 'VK_S') : name === '无妄引咎密宫' ? this.key('MoveLeft', 'VK_A') : name === '太山府' ? null : this.key('MoveForward', 'VK_W');
    if (name === '无妄引咎密宫') await this.held(this.key('MoveForward', 'VK_W'), 500);
    let found;
    try {
      found = await this.waitFor(async frame => { if (exists((await this.pick(frame)).region)) return true; if (key) await this.input('keyDown', [key]); return false; }, 20, 500);
    } finally { if (key) await cleanHost(this.host).input('keyUp', [key]); }
    if (!found) throw new Error('请检查是否在秘境门前');
  }
  async enter() {
    const name = this.guideDomainName ?? this.param.DomainName, point = name && (await this.domains()).get(name);
    let selectedText = false;
    if (point?.country === '至冬') selectedText = await new ChooseFOptionTask(this.host, { config: this.config }).singleSelectText(point.name ?? name);
    const pickGone = await this.waitFor(async frame => { const pick = await this.pick(frame); if (!exists(pick.region)) return true; if (!selectedText) await this.input('keyPress', [pick.key]); return false; }, 20, 500);
    if (!pickGone) this.host.log?.('warn', '交互键未消失，继续检查秘境菜单');
    const menu = await this.waitFor(frame => this.text(frame, '单人挑战', [.5, .5, .5, .5]), 20, 500);
    if (!menu) this.host.log?.('warn', '未观察到单人挑战按钮');
    const limited = await this.captured(async frame => !!(await this.text(frame, '限时全部开放', [0, 0, .5, .5]) || await this.text(frame, '限时开放', [0, 0, .5, .5])));
    if (this.param.DomainName === DEVELOPMENT_GUIDE) this.receipt.guideLevel = await selectDevelopmentGuideLevel(this);
    else {
      const date = new Date((this.host.wallNow?.() ?? Date.now()) + (this.host.serverTimeZoneOffsetHours ?? 8) * 3600000);
      const sunday = date.getUTCDay() === 0 && date.getUTCHours() >= 4 || date.getUTCDay() === 1 && date.getUTCHours() < 4;
      if (sunday || limited) await this.selectSundayLevel();
    }
    const teamView = await this.waitFor(async frame => {
      if (exists(await this.find(frame, 'Common/Element', 'PartyBtnChooseView'))) return true;
      const confirm = await this.find(frame, 'AutoFight', 'Confirm'); if (exists(confirm)) await this.click(confirm);
      if (await this.text(frame, '是否仍要.*挑战.*秘境', [.263, .32, .474, .327])) throw new Error('当前树脂不足，自动秘境停止运行。');
      return false;
    }, 10, 1000);
    const observedTeamView = teamView || await this.waitFor(async frame => exists(await this.find(frame, 'Common/Element', 'PartyBtnChooseView')), 10, 1000);
    this.receipt.teamViewObserved = !!observedTeamView;
    if (observedTeamView && this.param.PartyName) {
      this.receipt.partySwitched = await this.host.combat('switchParty', { name: this.param.PartyName }); await this.sleep(500);
      if (!this.receipt.partySwitched) throw new Error('未能切换到秘境指定队伍：' + this.param.PartyName);
    }
    this.receipt.startButtonDisappeared = !!await this.waitFor(async frame => {
      if (!await this.text(frame, '开始挑战', [.5, .5, .5, .5])) return true;
      const button = await this.find(frame, 'AutoFight', 'Confirm'); if (exists(button)) await this.click(button); return false;
    }, 10, 1000);
    await this.sleep(1000);
  }
  async selectSundayLevel() {
    if (await this.captured(async frame => exists(await this.find(frame, 'AutoFight', 'ArtifactArea')))) return;
    const index = Number(this.param.SundaySelectedValue); if (![1, 2, 3].includes(index)) return;
    await this.captured(frame => this.input('moveMouseTo', [frame.width / 4, frame.height / 2]));
    for (let i = 0; i < 100; i++) { await this.input('verticalScroll', [-1]); await this.sleep(10); }
    await this.sleep(400);
    await this.captured(async frame => {
      const pattern = await this.textPattern('地脉异常'), row = (await this.relativeOcr(frame, [0, 0, .5, 1])).findLast(row => pattern.test(row.text));
      if (row) { await this.sleep(300); await this.input('click', [row.x, row.y - (index === 1 ? frame.height / 5 : index === 2 ? frame.height / 10 : 0)]); }
    });
  }
  async closeTip() {
    const roi = [0, .2, 1, .6];
    const observed = await this.waitFor(async frame => exists(await this.find(frame, 'AutoFight', 'AbnormalIcon')) || !!(await this.text(frame, '地脉异常', roi) || await this.text(frame, '点击任意位置关闭', roi)), 40, 500);
    const closed = await this.waitFor(async frame => {
      const row = await this.text(frame, '地脉异常', roi) || await this.text(frame, '点击任意位置关闭', roi);
      if (row) await this.click(row);
      return this.captured(async next => exists(await this.find(next, 'AutoFight', 'AbnormalIcon')));
    }, 20, 500);
    if (!closed) await this.fixed('click', 1515, 892);
    await this.sleep(500); return { observed: !!observed, abnormalIconObserved: !!closed, fallbackClick: !closed };
  }
  async walkToPressF() {
    const forward = this.key('MoveForward', 'VK_W'), sprint = this.key('SprintKeyboard', 'VK_SHIFT'), started = this.host.now?.() ?? performance.now();
    await this.input('keyDown', [forward]);
    try {
      await this.sleep(30); if (!this.options.WalkToF) await this.input('keyDown', [sprint]);
      while (true) {
        const pick = await this.captured(frame => this.pick(frame));
        if (exists(pick.region)) { await this.input('keyPress', [pick.key]); return { interactionObserved: true }; }
        if ((this.host.now?.() ?? performance.now()) - started > 60000) {
          await this.host.genshin('tpToStatueOfTheSeven', []); throw Object.assign(new Error('前往目标位置处超时，先传送到七天神像，然后重试秘境'), { code: 'PATH_RETRY' });
        }
        await this.sleep(100);
      }
    } finally {
      const clean = cleanHost(this.host); await clean.input('keyUp', [forward]); await clean.sleep(50); if (!this.options.WalkToF) await clean.input('keyUp', [sprint]);
    }
  }
  async domainEnd() {
    return this.captured(async frame => {
      const s = Math.min(frame.width / 1920, frame.height / 1080, 1);
      for (const [key, roi] of [['挑战达成', [frame.width / 2 - 100 * s, 243 * s, 200 * s, 50 * s]], ['自动退出', [frame.width / 2 - 200 * s, frame.height - 160 * s, 400 * s, 80 * s]]]) {
        const pattern = await this.textPattern(key), text = (await this.ocr(frame, roi.map(Math.trunc))).map(row => row.text).join('');
        if (pattern.test(text)) return { key, text, evidence: 'domainEndOcr' };
      }
      return null;
    });
  }
  fightRuntime(host = this.host) {
    const runtime = new AutoFightTask(host, { config: field(this.config, 'AutoFightConfig', {}), taskConfig: { CombatStrategyPath: this.param.CombatStrategyPath, FightFinishDetectEnabled: false, ExpBasedPickupEnabled: false, KazuhaPickupEnabled: false, PickDropsAfterFightEnabled: false, Timeout: 600 }, partyState: this.partyState, strategies: this.strategies }, this.combatState);
    runtime.captured = body => ResinTasks.prototype.captured.call(runtime, body);
    return runtime;
  }
  async prepareFight() {
    if (this.param.CombatStrategyPath === '自动连招（实验）') {
      if (!this.comboSession) this.comboSession = await this.buildCombo();
      return { kind: 'combo' };
    }
    const runtime = this.fightRuntime(), team = await runtime.initializeTeam({ force: true, requireObserved: true }), selected = await runtime.strategy(team);
    if (selected.strategy.kind === 'json') return { kind: 'json', strategy: selected.strategy };
    const names = new Set(team.map(avatar => avatar.name)), commands = selected.strategy.commands.filter(command => names.has(command.name));
    if (!commands.length) throw new Error('没有可用战斗脚本');
    if (!await runtime.switchAvatar({ name: commands[0].name })) throw new Error('秘境首位战斗角色切换失败');
    await this.sleep(200); return { kind: 'txt', team, commands, name: selected.strategy.name };
  }
  async beginComboBuild() {
    if (this.comboBuild || this.comboSession) return;
    const { buildComboSession, observeComboParty } = await import('./combo.mjs');
    const observedTeam = await observeComboParty(this.host, { combat: this.fightRuntime() });
    this.comboBuildController = new AbortController();
    const signal = this.host.signal ? AbortSignal.any([this.host.signal, this.comboBuildController.signal]) : this.comboBuildController.signal;
    const host = Object.create(this.host, { signal: { value: signal } });
    this.comboBuild = buildComboSession(host, field(this.config, 'AutoComboBuildConfig', {}), { observedTeam }).then(session => ({ session }), error => ({ failed: true, error }));
  }
  async buildCombo() {
    await this.beginComboBuild();
    const result = await this.comboBuild;
    if (result.failed) throw result.error;
    this.host.signal?.throwIfAborted(); return result.session;
  }
  async fight(plan) {
    const controller = new AbortController(), signal = this.host.signal ? AbortSignal.any([this.host.signal, controller.signal]) : controller.signal;
    const host = Object.create(this.host, { signal: { value: signal } }), runtime = this.fightRuntime(host), watcher = new AutoDomainTask(host, { config: this.config, taskConfig: this.param });
    let endObservation, primary, failed = false, executed = 0, passes = 0;
    const actions = (async () => {
      if (plan.kind === 'combo') {
        const { AutoComboTask } = await import('./combo.mjs');
        return new AutoComboTask(host, { config: field(this.config, 'AutoFightConfig', {}), taskConfig: { FightFinishDetectEnabled: false }, session: this.comboSession }, this.combatState).start();
      }
      if (plan.kind === 'json') { runtime.strategies = [plan.strategy]; return runtime.start(); }
      this.combatState.fightActive = true;
      const team = plan.team; let previous = plan.commands.at(-1);
      while (true) {
        signal.throwIfAborted(); passes++;
        for (const command of plan.commands) {
          const result = await executeCombatCommand(command, runtime.host, { team, previous, round: passes, checkFight: false }); executed += result.executed; previous = command;
        }
        await yieldToEvents();
      }
    })();
    const detector = (async () => { while (true) { signal.throwIfAborted(); endObservation = await watcher.domainEnd(); if (endObservation) return; await watcher.sleep(1000); } })();
    try {
      await Promise.race([detector, actions.then(() => { if (!endObservation) throw new Error('战斗引擎已停止，但未观察到秘境完成提示'); })]);
    } catch (error) { primary = error; failed = true; }
    finally { controller.abort(done); }
    const results = await Promise.allSettled([actions, detector]);
    this.combatState.fightActive = false;
    let cleanup, cleanupFailed = false;
    try { await cleanHost(this.host).input('releaseAll', []); } catch (error) { cleanup = error; cleanupFailed = true; }
    if (failed) throw primary;
    this.host.signal?.throwIfAborted();
    const lateFailure = results.find(result => result.status === 'rejected' && result.reason !== done && result.reason !== signal.reason);
    if (lateFailure) throw lateFailure.reason;
    if (cleanupFailed) throw cleanup;
    if (!endObservation) throw new Error('没有观察到秘境完成提示');
    return { kind: plan.kind, endObservation, passes, commandsExecuted: executed };
  }
  async alignTree() {
    await this.input('middleButtonClick'); await this.sleep(900);
    const controller = new AbortController(), signal = this.host.signal ? AbortSignal.any([this.host.signal, controller.signal]) : controller.signal;
    const host = Object.create(this.host, { signal: { value: signal } }), task = new AutoDomainTask(host, { config: this.config, taskConfig: this.param });
    let movement, complete = false, primary, failed = false, stable = 0, cameraFrames = 0;
    const camera = (async () => {
      while (true) {
        signal.throwIfAborted();
        const angle = await task.captured(frame => host.vision('map.cameraOrientation', { handle: frame.handle })); cameraFrames++;
        if (angle.valid && Number.isFinite(angle.angle)) {
          const degrees = angle.angle; stable = degrees >= 356 || degrees <= 4 ? stable + 1 : 0;
          if (stable > 5 && !movement) movement = task.moveTree(this.predictor).then(result => { complete = result; controller.abort(done); }).catch(error => { if (!failed) { primary = error; failed = true; } controller.abort(error); });
          let delta = degrees <= 180 ? -roundEven(degrees) : 360 - roundEven(degrees);
          if (Math.abs(delta) > 2) delta *= 2;
          await task.input('moveMouseBy', [delta, 0]);
        } else stable = 0;
        await task.sleep(100);
      }
    })();
    try { await camera; } catch (error) { if (!complete && !failed) { primary = error; failed = true; } }
    finally {
      controller.abort(done); await movement;
      try { await cleanHost(host).input('releaseAll', []); } catch (error) { if (!failed) { primary = error; failed = true; } }
    }
    if (failed) throw primary; this.host.signal?.throwIfAborted();
    return { ...complete, cameraFrames, eastConsecutiveRequired: 6 };
  }
  async moveTree(predictor) {
    const left = this.key('MoveLeft', 'VK_A'), right = this.key('MoveRight', 'VK_D'), forward = this.key('MoveForward', 'VK_W');
    let heldKey, previous = left, reversals = 0, missing = 0, detections = 0;
    const hold = async key => { if (heldKey && heldKey !== key) await cleanHost(this.host).input('keyUp', [heldKey]); if (heldKey !== key) await this.input('keyDown', [key]); heldKey = key; };
    const release = async () => { if (heldKey) { previous = heldKey; await cleanHost(this.host).input('keyUp', [heldKey]); heldKey = null; } };
    try {
      while (true) {
        const observation = await this.captured(async frame => ({ middle: frame.width / 2, tree: (await this.host.vision('yolo.predict', { predictor, handle: frame.handle }))[0]?.bounds }));
        const { tree, middle } = observation;
        let centered = false;
        if (tree) {
          detections++; const center = tree.x + Math.trunc(tree.width / 2);
          if (!this.options.ShortMovement && tree.x + tree.width < middle) { reversals = 0; await hold(left); }
          else if (!this.options.ShortMovement && tree.x > middle) { reversals = 0; await hold(right); }
          else {
            await release();
            if (center === middle) centered = true;
            else { const key = center < middle ? left : right; if (key !== previous) reversals++; await this.held(key, 60); previous = key; }
          }
        } else { reversals = 0; missing++; await hold(missing > 40 ? right : left); }
        if (centered || reversals >= this.options.LeftRightMoveTimes) { await release(); await this.held(forward, 60); await this.sleep(500); return { completion: centered ? 'centeredTree' : 'reversalLimit', detections, noDetectCount: missing, reversals }; }
        await this.sleep(60);
      }
    } finally { await release(); }
  }
  async exitDomain() {
    await this.input('keyPress', ['VK_ESCAPE']); await this.sleep(500); await this.input('keyPress', ['VK_ESCAPE']); await this.sleep(800);
    await this.captured(async frame => { const button = await this.find(frame, 'Common/Element', 'BtnBlackConfirm'); if (exists(button)) await this.click(button); });
  }
  async recognizeRewards() {
    if (!this.param.RewardRecognitionEnabled) return;
    try {
      if (!await this.waitFor(async frame => exists(await this.find(frame, 'AutoFight', 'Exit')), 20, 300)) { this.receipt.rewardObservations.push({ skipped: 'rewardExitNotObserved' }); return; }
      const { RewardResultRecognizer } = await import('./reward.mjs');
      const result = await new RewardResultRecognizer(this.host, { config: this.config }).recognizeMultiPage(3);
      this.receipt.rewardObservations.push(result);
      for (const [name, count] of Object.entries(result.summary ?? {})) this.summary[name] = (this.summary[name] ?? 0) + count;
    } catch (error) {
      this.host.signal?.throwIfAborted();
      if (['AbortError', 'NormalEndException'].includes(error?.name)) throw error;
      this.receipt.rewardObservations.push({ skipped: 'recognitionFailed', error: String(error?.message ?? error) });
      this.host.log?.('warn', '秘境奖励识别失败：' + String(error));
    }
  }
  async treasure({ finalRound = false } = {}) {
    await this.sleep(300);
    const choose = await this.waitFor(async frame => { const row = await this.text(frame, '石化古树', [.25, .2, .5, .6]); if (!row) return false; await this.click(row); return true; }, 10, 500);
    await this.sleep(800);
    const insufficient = await this.captured(async frame => !!(await this.text(frame, '数量不足', [.25, .2, .5, .6]) || await this.text(frame, '补充原粹树脂', [.25, .2, .5, .6])));
    if (insufficient) { await this.exitDomain(); return { repeat: false, completion: 'insufficientResinObserved' }; }
    let last = finalRound;
    if (choose) {
      const use = await this.captured(async frame => {
        const rows = await this.prompt(frame);
        if (!this.param.SpecifyResinUse) {
          const status = await this.status(frame);
          if (status.CondensedResinCount <= 0 && status.OriginalResinCount < 20) return null;
          const result = await this.pressUseResin(rows, status.CondensedResinCount > 0 ? '浓缩树脂' : '原粹树脂', frame.width);
          if (!result.used) return null;
          if (result.name === '浓缩树脂') status.CondensedResinCount--; else status.OriginalResinCount -= result.num;
          last ||= status.CondensedResinCount <= 0 && status.OriginalResinCount < 20; return { ...result, remainingEstimate: status };
        }
        for (const record of this.resinRecords) {
          if (record.RemainCount <= 0) continue;
          if (['原粹树脂20', '原粹树脂40'].includes(record.Name) && !await this.switchOriginalResinType(record.Name.endsWith('20') ? 20 : 40)) continue;
          const result = await this.pressUseResin(rows, record.Name, frame.width);
          if (result.used) { record.RemainCount--; last ||= this.resinRecords.every(record => record.RemainCount <= 0); return { ...result, configuredName: record.Name }; }
        }
        return null;
      });
      if (!use) { await this.exitDomain(); return { repeat: false, completion: 'resinOptionUnavailable' }; }
      this.receipt.resinUses.push(use);
    }
    await this.sleep(1000); await this.recognizeRewards();
    const result = await this.waitFor(async frame => {
      const confirm = await this.find(frame, 'AutoFight', 'Confirm'); if (!exists(confirm)) return null;
      if (last) { const exit = await this.find(frame, 'AutoFight', 'Exit'); if (!exists(exit)) return null; await this.click(exit); return { repeat: false, completion: finalRound ? 'roundLimit' : 'resinLimit' }; }
      await this.click(confirm); await this.sleep(60); await this.click(confirm);
      if (!choose) {
        await this.sleep(900);
        const cancelled = await this.captured(async prompt => {
          if (!await this.text(prompt, '是否仍要.*挑战.*秘境', [.25, .2, .5, .6])) return false;
          const cancel = await this.text(prompt, '取消', [.25, .2, .5, .6]); if (!cancel) return false; await this.click(cancel); return true;
        });
        if (cancelled) return { repeat: false, completion: 'repeatInsufficientResinObserved' };
      }
      return { repeat: true, completion: 'continueButtonClicked' };
    }, 30, 300);
    if (!result) throw new Error('未检测到秘境结束，可能是背包物品已满。');
    return result;
  }
  async doDomain() {
    await this.teleport(); await this.enter();
    for (let round = 0; round < this.param.DomainRoundNum; round++) {
      const receipt = { round: round + 1 }; this.receipt.rounds.push(receipt); receipt.tip = await this.closeTip();
      const plan = await this.prepareFight();
      if (plan.kind !== 'txt') {
        this.combatState.skillTracker?.clear?.();
        for (const avatar of this.combatState.team ?? []) { avatar.lastSkillAt = -Infinity; avatar.manualSkillCd = -1; }
      }
      receipt.challengeInteraction = await this.walkToPressF(); receipt.fight = await this.fight(plan);
      if (this.options.FightEndDelay > 0) await this.sleep(this.options.FightEndDelay * 1000);
      receipt.tree = await this.alignTree(); receipt.treeInteraction = await this.walkToPressF(); receipt.treasure = await this.treasure({ finalRound: round + 1 === this.param.DomainRoundNum });
      if (!receipt.treasure.repeat) { this.receipt.completion = receipt.treasure.completion; return; }
    }
    this.receipt.completion = 'roundLimit';
  }
  async start() {
    let lease, failed = false;
    try {
      this.host.signal?.throwIfAborted();
      await this.captured(frame => { if (frame.width * 9 !== frame.height * 16) throw new Error('AutoDomain requires a 16:9 game viewport'); });
      const modelPath = path.resolve(this.host.sourceRoot, '../assets/bettergi.assets.model/Assets/Model/Domain/bgi_tree.onnx');
      this.predictor = (await cleanHost(this.host).vision('yolo.create', { path: modelPath, requireDetection: true })).predictor;
      this.host.signal?.throwIfAborted();
      if (this.options.AutoEat) lease = this.host.addTaskTrigger({ name: 'AutoEat' });
      if (this.param.CombatStrategyPath === '自动连招（实验）' && !this.param.PartyName && !this.comboSession) await this.beginComboBuild();
      for (let attempt = 0; attempt < this.options.ReviveRetryCount; attempt++) {
        try { await this.doDomain(); break; }
        catch (error) {
          if (error?.code !== 'PATH_RETRY' || !this.param.DomainName) throw error;
          this.receipt.retries.push({ attempt: attempt + 1, reason: error.message });
          if (attempt + 1 >= this.options.ReviveRetryCount) throw error;
          await this.sleep(2000);
        }
      }
      await this.sleep(2000); await this.waitMainUi(30); await this.sleep(2000);
      if (this.param.AutoArtifactSalvage) this.receipt.salvage = await this.host.task('autoArtifactSalvage', { config: { Star: Number.parseInt(this.param.MaxArtifactStar) || 4, JavaScript: null, ArtifactSetFilter: null, MaxNumToCheck: null, RecognitionFailurePolicy: null } });
      return { ...this.receipt, rewardSummary: { ...this.summary }, mainUiVerified: true, resinRecords: this.resinRecords };
    } catch (error) { failed = true; if (error && typeof error === 'object') error.domainEvidence = this.receipt; throw error; }
    finally {
      lease?.dispose(); const clean = cleanHost(this.host);
      this.comboBuildController?.abort(done);
      const build = await this.comboBuild;
      const results = await Promise.allSettled([clean.input('releaseAll', []), this.predictor ? clean.vision('yolo.dispose', { predictor: this.predictor }) : Promise.resolve()]);
      if (!failed && build?.failed && build.error !== done && build.error !== this.host.signal?.reason) throw build.error;
      const cleanup = results.find(result => result.status === 'rejected'); if (cleanup && !failed) throw cleanup.reason;
    }
  }
}

export async function runAutoDomain(host, options = {}) { const result = await new AutoDomainTask(host, options).start(); return options.detailed ? result : result.rewardSummary; }
