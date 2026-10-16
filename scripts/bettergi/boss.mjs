// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoBossTask, AutoBossData and original Assets/Pathing, c9db8b8.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BossResinTasks } from './boss-resin.mjs';
import { NavigationTasks, loadPathingTask } from './navigation.mjs';
import { PartyTasks, partyConfig } from './party.mjs';
import { AutoFightTask } from './fight.mjs';
import { AutoComboTask } from './combo.mjs';
import { createTaskParamTypes } from './task-params.mjs';

const field = (value, name, fallback) => { const key = Object.keys(value ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : value[key]; };
const exists = region => region?.width > 0 && region?.height > 0;
const check = host => host.signal?.throwIfAborted();
const now = host => host.now?.() ?? performance.now();
const roundEven = value => { const n = Math.floor(value); return value - n === .5 ? n % 2 ? n + 1 : n : Math.round(value); };
const neutralInput = method => /^(?:releaseAll|keyUp|KeyUp|(?:left|right|middle)ButtonUp)$/.test(method);
const cleanHost = host => Object.create(host, { signal: { value: null, writable: true } });
const catalogPromises = new Map();

function scopedBossHost(raw, signal = raw.signal) {
  const clear = cleanHost(raw), view = Object.create(raw, { signal: { value: signal, writable: true } });
  view.capture = async function () {
    check(this);
    const frame = await clear.capture();
    if (this.signal?.aborted) {
      try { await clear.vision('image.dispose', { handle: frame.handle }); } catch (error) { raw.log?.('error', error.message); }
      check(this);
    }
    return frame;
  };
  view.vision = async function (op, args) {
    if (op === 'image.dispose') return clear.vision(op, args);
    check(this);
    const allocation = op === 'image.crop' || op === 'image.mat';
    const result = await raw.vision.call(allocation ? clear : this, op, args);
    if (allocation && result?.handle != null && this.signal?.aborted) {
      try { await clear.vision('image.dispose', { handle: result.handle }); } catch (error) { raw.log?.('error', error.message); }
    }
    check(this); return result;
  };
  view.input = async function (method, args = []) {
    if (neutralInput(method)) return clear.input(method, args);
    check(this); const value = await raw.input.call(this, method, args); check(this); return value;
  };
  view.navigation = async function (op, args) {
    if (op === 'endRoute') return clear.navigation(op, args);
    check(this); const value = await raw.navigation.call(this, op, args); check(this); return value;
  };
  return view;
}

export function bossParameters(config = {}, taskConfig = {}, sourceRoot) {
  const { AutoBossParam } = createTaskParamTypes({ getConfig: () => config,
    ...(sourceRoot ? { combatRoot: path.resolve(sourceRoot, '../scripts/repo/combat') } : {}) });
  const param = new AutoBossParam();
  for (const key of Object.keys(param).filter(key => key !== 'CombatStrategyPath')) param[key] = field(taskConfig, key, param[key]);
  const strategyPath = field(taskConfig, 'CombatStrategyPath');
  if (strategyPath !== undefined && strategyPath?.trim()) param.CombatStrategyPath = strategyPath;
  if (!Number.isInteger(param.ReviveRetryCount) || param.ReviveRetryCount < 0) throw new RangeError('角色死亡后重试次数不能小于 0');
  if (!Number.isInteger(param.RunCount) || param.SpecifyRunCount && param.RunCount < 1) throw new RangeError('指定讨伐次数必须大于 0');
  if (!param.SpecifyRunCount && (param.UseTransientResin || param.UseFragileResin)) throw new Error('只有指定讨伐次数模式才能开启须臾树脂或脆弱树脂补充');
  if (!Number.isFinite(param.Timeout) || param.Timeout < 0) throw new RangeError('Invalid AutoBossConfig.Timeout');
  return param;
}

export async function loadBossCatalog(sourceRoot) {
  if (!catalogPromises.has(sourceRoot)) catalogPromises.set(sourceRoot, (async () => {
    const filename = path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoBoss/AutoBossData.cs');
    const source = await readFile(filename, 'utf8'), countries = {};
    for (const match of source.matchAll(/\["([^"]+)"\]\s*=\s*\[([^\]]*)\]/g)) countries[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map(item => item[1]);
    const list = name => {
      const block = source.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\];'))?.[1];
      if (block === undefined) throw new Error('Missing original AutoBossData.' + name);
      return new Set([...block.matchAll(/"([^"]+)"/g)].map(item => item[1]));
    };
    const bosses = Object.values(countries).flat();
    if (!bosses.length || new Set(bosses).size !== bosses.length) throw new Error('Invalid original AutoBossData country catalog');
    return { countries, bosses, talkToStart: list('TalkToStartBosses'), noPathing: list('NoPathingSupportBosses'),
      rerunRoute: list('RerunRouteBosses'), filename };
  })());
  return catalogPromises.get(sourceRoot);
}
export function requiredBossRouteFiles(name, catalog) {
  if (catalog.noPathing.has(name)) return [name + '强制传送.json', name + '键鼠前往.json'];
  return [name + '前往.json', ...(catalog.talkToStart.has(name) ? [name + '战斗后快速前往.json'] : [])];
}

export class AutoBossTask extends BossResinTasks {
  constructor(rawHost, { config = {}, taskConfig = {}, partyState = {}, combatState = {}, strategies, comboSession } = {}) {
    const param = bossParameters(config, taskConfig, rawHost.sourceRoot);
    super(scopedBossHost(rawHost), param);
    this.config = config; this.partyState = partyState; this.combatState = combatState;
    this.strategies = strategies; this.comboSession = comboSession;
    this.onRewardClaimed = field(taskConfig, 'RewardClaimedCallback');
    this.assetRoot = path.join(rawHost.sourceRoot, 'BetterGenshinImpact/GameTask/AutoBoss/Assets/Pathing');
    this.successfulRewardCount = 0; this.summary = {};
    this.receipt = { boss: param.BossName, rounds: [], retries: [], rewardObservations: [], routes: [], verified: false, inventoryVerified: false };
  }
  async validate() {
    this.catalog = await loadBossCatalog(this.host.sourceRoot);
    if (!this.param.BossName?.trim()) throw new Error('请选择需要讨伐的首领');
    if (!this.catalog.bosses.includes(this.param.BossName)) throw new Error('暂不支持首领：' + this.param.BossName);
    if (this.param.StrategyName !== '自动连招（实验）') {
      const info = await stat(this.param.CombatStrategyPath);
      if (!info.isFile() && !info.isDirectory()) throw new Error('当前选择的自动战斗策略文件不存在');
    } else if (!this.comboSession) throw new Error('尚未构建自动连招行为树');
    for (const filename of requiredBossRouteFiles(this.param.BossName, this.catalog)) {
      if (!(await stat(path.join(this.assetRoot, filename))).isFile()) throw new Error('未找到首领路线文件：' + filename);
    }
    await this.captured(frame => {
      if (frame.width * 9 !== frame.height * 16) throw new Error('游戏窗口分辨率不是 16:9');
      if (frame.width < 1920) this.host.log?.('warn', '游戏窗口小于 1920x1080，原版首领识别可能失败');
    });
  }
  shouldContinue() { return !this.param.SpecifyRunCount || this.successfulRewardCount < this.param.RunCount; }
  async prepare() {
    await this.returnMainUi();
    if (this.param.TeamName?.trim()) {
      if (!await this.party().switchParty(this.param.TeamName)) throw new Error('切换队伍失败：' + this.param.TeamName);
      this.combatState.team = [];
    }
  }
  party() {
    const task = new PartyTasks(this.host, {}, this.partyState);
    task.captured = body => this.captured(body);
    return task;
  }
  async runRoute(task) {
    const navigation = new NavigationTasks(this.host, { partyConfig: partyConfig({ SkipPartySwitch: true, AutoFightEnabled: false }),
      autoFightConfig: field(this.config, 'AutoFightConfig', {}) });
    navigation.captured = body => this.captured(body);
    const result = await navigation.execute(task);
    this.receipt.routes.push({ filename: task.filename ?? null, points: task.positions.length, result });
    return result;
  }
  async runRouteFile(filename) {
    await this.returnMainUi();
    return this.runRoute(await loadPathingTask(path.join(this.assetRoot, filename), { sourceRoot: this.host.sourceRoot }));
  }
  async navigateToBoss() {
    const name = this.param.BossName;
    if (!this.catalog.noPathing.has(name)) return this.runRouteFile(name + '前往.json');
    await this.runRouteFile(name + '强制传送.json'); await this.returnMainUi();
    const source = await readFile(path.join(this.assetRoot, name + '键鼠前往.json'), 'utf8');
    check(this.host);
    const [width, height] = this.metrics;
    const result = await this.runKeyMouse(source, { width, height, dpi: field(field(this.config, 'CommonConfig', {}), 'DpiScale', 1) });
    this.receipt.routes.push({ filename: name + '键鼠前往.json', macro: true, result }); return result;
  }
  async runFight() {
    const taskConfig = { CombatStrategyPath: this.param.CombatStrategyPath, StrategyName: this.param.StrategyName,
      FightFinishDetectEnabled: true, PickDropsAfterFightEnabled: false, KazuhaPickupEnabled: false, QinDoublePickUp: false,
      ExpBasedPickupEnabled: false, KazuhaPartyName: '', BattleThresholdForLoot: -1,
      OnlyPickEliteDropsMode: 'DisableAutoPickupForNonElite', Timeout: this.param.Timeout };
    const options = { config: field(this.config, 'AutoFightConfig', {}), taskConfig, partyState: this.partyState, strategies: this.strategies };
    if (this.param.StrategyName === '自动连招（实验）') {
      const combo = new AutoComboTask(this.host, { ...options, config: { ...options.config, ...taskConfig }, session: this.comboSession }, this.combatState);
      combo.captured = body => this.captured(body);
      let result;
      try { result = await combo.start(); } catch (error) { check(this.host); throw error; }
      check(this.host);
      if (result.paused) throw new Error('自动连招暂停，首领战斗尚未完成');
      return result;
    }
    const fight = new AutoFightTask(this.host, options, this.combatState);
    fight.captured = body => this.captured(body);
    const team = await fight.initializeTeam({ requireObserved: true }), selected = await fight.strategy(team);
    fight.strategies = [selected.strategy];
    if (selected.strategy.kind !== 'json') {
      const command = selected.strategy.commands.find(command => team.some(avatar => avatar.name === command.name));
      if (!command) throw new Error('没有可用战斗脚本');
      await fight.switchAvatar({ name: command.name }); await this.sleep(200);
    }
    try { return await fight.start(); } catch (error) { check(this.host); throw error; }
  }
  async monitorRewardPrompt(worker) {
    let lastInteractAt = -Infinity;
    while (true) {
      check(worker.host);
      const panel = await worker.captured(async frame => (await worker.ocr(frame, worker.scaleRect(frame, [850, 740, 250, 35]))).some(row => row.text.includes('使用原粹树脂') || row.text.includes('补充原粹树脂')));
      if (panel) return { evidence: 'rewardResinPanelObserved' };
      if (await worker.textAt('接触征讨之花', [1210, 300, 200, 400]) && now(worker.host) - lastInteractAt >= 300) {
        await worker.input('keyPress', ['F']); lastInteractAt = now(worker.host);
      }
      await worker.sleep(300);
    }
  }
  async adjustRewardCamera(worker) {
    while (true) {
      check(worker.host);
      const icon = await worker.bossIcon('RewardBox'), [width, height] = worker.metrics;
      if (!exists(icon)) { await worker.input('moveMouseBy', [roundEven(200 * Math.min(width / 1920, height / 1080, 1)), 0]); await worker.sleep(250); continue; }
      if (icon.y > height / 2) {
        await worker.input('moveMouseBy', [0, roundEven(height / 2)]); await worker.sleep(125);
        await worker.input('moveMouseBy', [roundEven(width / 2), 0]); await worker.sleep(125); continue;
      }
      if (icon.x < width * .45 || icon.x > width * .55) await worker.input('moveMouseBy', [roundEven(icon.x - width / 2), 0]);
      await worker.sleep(250);
    }
  }
  async moveToReward(worker) {
    let forward = false, jumps = 0, failure, failed = false;
    try {
      while (true) {
        check(worker.host);
        if (await worker.textAt('Space', [1686, 1030, 60, 23])) {
          if (forward) { await worker.input('keyUp', ['W']); forward = false; }
          await worker.input('keyPress', ['X']); await worker.sleep(1000);
          await worker.input('keyDown', ['A']); await worker.sleep(800); await worker.input('keyUp', ['A']); continue;
        }
        if (!forward) { await worker.input('keyDown', ['W']); forward = true; }
        await worker.sleep(1000);
        if (++jumps % 2 === 0) { await worker.input('keyPress', ['VK_SPACE']); await worker.sleep(100); }
        await worker.input('keyUp', ['W']); forward = false; await worker.sleep(200);
      }
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      const canceled = worker.host.signal?.aborted && (failure === worker.host.signal.reason || failure?.name === 'AbortError');
      await this.releaseInputs(worker.host, [['keyUp', ['W']], ['keyUp', ['A']]], failed && !canceled);
    }
  }
  async releaseInputs(host, commands, hasPrimaryFailure = false) {
    let cleanupFailure;
    for (const [method, args] of commands) {
      try { await cleanHost(host).input(method, args); }
      catch (error) { cleanupFailure ??= error; host.log?.('error', '首领输入释放失败：' + error.message); }
    }
    if (cleanupFailure && !hasPrimaryFailure) throw cleanupFailure;
  }
  async navigateToReward() {
    const controller = new AbortController(), parent = this.host.signal;
    const abort = () => controller.abort(parent.reason);
    parent?.addEventListener('abort', abort, { once: true }); if (parent?.aborted) abort();
    const worker = new BossResinTasks(scopedBossHost(this.host, controller.signal), this.param), started = now(this.host);
    const jobs = { camera: () => this.adjustRewardCamera(worker), movement: () => this.moveToReward(worker), monitor: () => this.monitorRewardPrompt(worker),
      timeout: async () => { while (now(worker.host) - started < 20000) await worker.sleep(Math.min(500, 20000 - (now(worker.host) - started))); throw new Error('超时未找到征讨之花领奖界面'); } };
    const tasks = Object.entries(jobs).map(async ([name, run]) => { try { return { name, value: await run() }; } catch (error) { return { name, error }; } });
    let failed = false;
    try {
      const first = await Promise.race(tasks); check(this.host);
      if (first.error) throw first.error;
      if (first.name !== 'monitor') throw new Error('前往征讨之花任务异常结束');
      return first.value;
    } catch (error) { failed = true; throw error; }
    finally {
      controller.abort(new Error('Boss reward navigation stopped'));
      const results = await Promise.all(tasks); parent?.removeEventListener('abort', abort);
      const other = results.find(result => result.error && result.error !== controller.signal.reason && result.error?.name !== 'AbortError');
      let shutdownFailure;
      try { await this.releaseInputs(this.host, [['keyUp', ['W']], ['keyUp', ['A']], ['keyUp', ['D']]], failed); } catch (error) { shutdownFailure = error; }
      if (!failed && (other?.error || shutdownFailure)) throw other?.error ?? shutdownFailure;
    }
  }
  async useOriginalResinOnRewardPrompt() {
    let clicked = false;
    const disappeared = await this.poll(async () => {
      const button = await this.textAt('使用原粹树脂', [850, 740, 250, 35]);
      if (!button) return clicked;
      await this.click(button); clicked = true; return false;
    }, 3000);
    if (disappeared) { await this.sleep(1000); return true; }
    const supplement = !!await this.poll(() => this.textAt('补充原粹树脂', [850, 740, 250, 35]), 1000);
    this.receipt.rewardObservations.push({ used: false, supplementPromptObserved: supplement }); return false;
  }
  async recognizeReward() {
    if (!this.param.RewardRecognitionEnabled) return;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) { if (await this.textAt('点击空白区域继续', [850, 960, 220, 35])) { ready = true; break; } await this.sleep(300); }
      if (!ready) { this.host.log?.('warn', '未观察到奖励结果页，跳过奖励识别'); return; }
      const { RewardResultRecognizer } = await import('./reward.mjs');
      const result = await new RewardResultRecognizer(this.host, { config: this.config }).recognizeMultiPage(3);
      for (const [name, count] of Object.entries(result.summary)) this.summary[name] = (this.summary[name] ?? 0) + count;
      this.receipt.rewardObservations.push(result);
    } catch (error) { check(this.host); this.host.log?.('warn', '首领奖励识别失败：' + error.message); }
  }
  async closeSupplementPrompt() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const present = await this.captured(async frame => (await this.ocr(frame, this.scaleRect(frame, [850, 730, 250, 60]))).some(row => /补充|原粹|树脂/.test(row.text)));
      if (!present) return;
      await this.input('keyPress', ['VK_ESCAPE']); await this.sleep(300);
    }
    throw new Error('关闭补充原粹树脂提示超时');
  }
  async closeRewardResult() {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await this.isInMainUi()) return;
      const close = await this.textAt('点击空白区域继续', [850, 960, 220, 35]);
      if (close) await this.click(close);
      else if (attempt > 5) {
        const [width, height] = this.metrics ?? await this.captured(frame => [frame.width, frame.height]);
        await this.input('click', [width / 2, height / 2]);
      }
      await this.sleep(300);
    }
    if (!await this.isInMainUi()) throw new Error('领取奖励后未成功回到主界面');
  }
  async takeReward() {
    if (!await this.useOriginalResinOnRewardPrompt()) { await this.closeSupplementPrompt(); await this.returnMainUi(); return false; }
    await this.recognizeReward(); await this.closeRewardResult();
    this.receipt.rewardObservations.push({ evidence: 'resinUseButtonDisappearedAndMainUiObserved', inventoryVerified: false }); return true;
  }
  async repositionAfterFight() {
    const name = this.param.BossName;
    if (this.catalog.talkToStart.has(name)) return this.runRouteFile(name + '战斗后快速前往.json');
    if (this.catalog.noPathing.has(name)) return this.navigateToBoss();
    if (this.catalog.rerunRoute.has(name)) return this.runRouteFile(name + '前往.json');
    const original = await loadPathingTask(path.join(this.assetRoot, name + '前往.json'), { sourceRoot: this.host.sourceRoot });
    const point = original.positions.at(-1); if (!point) throw new Error('路线文件缺少路径点');
    await this.runRoute({ ...original, positions: [point], segments: [[point]] }); await this.sleep(4000);
  }
  async runLoop() {
    await this.prepare(); let navigate = true;
    while (this.shouldContinue()) {
      check(this.host);
      if (!await this.ensureResinBeforeRound()) return 'insufficientResin';
      if (navigate) await this.navigateToBoss();
      const fight = await this.runFight(); check(this.host);
      const rewardNavigation = await this.navigateToReward();
      if (!await this.takeReward()) return 'rewardUnavailable';
      this.successfulRewardCount++;
      this.receipt.rounds.push({ round: this.successfulRewardCount, fight, rewardNavigation, rewardPanelConsumed: true, inventoryVerified: false });
      await this.onRewardClaimed?.(); check(this.host);
      if (!this.shouldContinue()) break;
      if (this.param.ReturnToStatueAfterEachRound) { await this.party().statue({ pauseAfter: false }); await this.sleep(3000); navigate = true; }
      else { await this.repositionAfterFight(); navigate = false; }
    }
    return 'targetRunCountReached';
  }
  async start() {
    this.successfulRewardCount = 0; this.summary = {}; this.resinEvidence.length = 0;
    this.receipt.rounds.length = 0; this.receipt.retries.length = 0; this.receipt.rewardObservations.length = 0; this.receipt.routes.length = 0;
    let failed = false;
    try {
      await this.validate(); let retries = 0, reason;
      while (true) {
        try { reason = await this.runLoop(); break; }
        catch (error) {
          check(this.host);
          if (error.code !== 'PATH_RETRY' || retries >= this.param.ReviveRetryCount) throw error;
          this.receipt.retries.push({ retry: ++retries, reason: error.message, successfulRewardCount: this.successfulRewardCount });
          await this.sleep(2000);
        }
      }
      return { ...this.receipt, completed: !this.param.SpecifyRunCount || this.successfulRewardCount >= this.param.RunCount, reason,
        successfulRewardCount: this.successfulRewardCount, targetRunCount: this.param.SpecifyRunCount ? this.param.RunCount : null,
        rewardSummary: { ...this.summary }, resinEvidence: [...this.resinEvidence] };
    } catch (error) { failed = true; throw error; }
    finally { await this.releaseInputs(this.host, [['releaseAll', []], ['leftButtonUp', []]], failed); }
  }
}

export async function runAutoBoss(rawHost, options = {}) { const result = await new AutoBossTask(rawHost, options).start(); return options.detailed ? result : result.rewardSummary; }
