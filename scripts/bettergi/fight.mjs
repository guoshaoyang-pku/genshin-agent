// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoFightTask, CombatScriptBag, AutoFightSkill and ContinuousTargetingLoopAsync.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { CombatTasks, parseManualSkillCd } from './combat.mjs';
import { FightSeek } from './fight-seek.mjs';
import { AutoFightJsonTask, loadJsonCombatStrategy } from './fight-json.mjs';
import { UnsupportedNativeOperation, executeCombatCommand, loadAvatarCatalog, parseCombatScript } from './native.mjs';
import { PathingActions, loadPathingActionResources } from './actions.mjs';
import { PartyTasks, cleanPartyName } from './party.mjs';

const field = (value, key, fallback) => { const name = Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name === undefined ? fallback : value[name]; };
const now = host => host.now?.() ?? performance.now();
const check = host => host.signal?.throwIfAborted();
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function input(host, method, args = []) { check(host); return host.input(method, args); }
const exists = region => region?.width > 0 && region?.height > 0;
const numeric = text => typeof text === 'number' ? Number.isFinite(text) ? text : null : typeof text === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) ? Number(text) : null;

const finishDefaults = { FastCheckEnabled: false, FastCheckParams: '', CheckAfterSwitchAvatar: false, CheckEndDelay: '0.4;钟离,1.4;', BeforeDetectDelay: '0.4', RotateFindEnemyEnabled: false, SkipFightEndCheckWhenEnemyVisible: false, BlockCheckBeforeBattleSeconds: 0, PaimonEndCheckEnabled: false, PaimonEndCheckDelay: .2, RotaryFactor: 12, IsFirstCheck: false, CheckBeforeBurst: false };
const defaults = { StrategyName: '根据队伍自动选择', FightFinishDetectEnabled: true, PickDropsAfterFightEnabled: true, PickDropsAfterFightSeconds: 15, KazuhaPickupEnabled: true, ActionSchedulerByCd: '', BattleThresholdForLoot: -1, Timeout: 120, KazuhaPartyName: '', OnlyPickEliteDropsMode: 'Closed', GuardianAvatar: '', GuardianCombatSkip: false, GuardianAvatarHold: false, BurstEnabled: false, QinDoublePickUp: false, SwimmingEnabled: true, EnableCombatTargeting: false, TargetingDetectionInterval: 50, DrawRecognitionResults: true, LockLostWaitTime: .5, DamageNumberRecognitionMode: 'Color', ExpBasedPickupEnabled: false };
function mergeFields(base, value) { const merged = { ...base, ...value }; for (const key of Object.keys(base)) merged[key] = field(value, key, base[key]); return merged; }
export function fightConfig(config = {}, taskConfig = {}) {
  const result = mergeFields(mergeFields(defaults, config), taskConfig);
  result.FinishDetectConfig = mergeFields(mergeFields(finishDefaults, field(config, 'FinishDetectConfig', {})), field(taskConfig, 'FinishDetectConfig', {}));
  for (const key of ['RotaryFactor', 'IsFirstCheck', 'CheckBeforeBurst']) result[key] = field(taskConfig, key, result.FinishDetectConfig[key]);
  result.RotaryFactor = Math.max(1, Math.min(13, result.RotaryFactor));
  for (const key of ['Timeout', 'TargetingDetectionInterval', 'PickDropsAfterFightSeconds']) if (!Number.isFinite(result[key]) || result[key] < 0 || key === 'TargetingDetectionInterval' && result[key] === 0) throw new RangeError('Invalid AutoFightConfig.' + key);
  if (result.BattleThresholdForLoot == null) result.BattleThresholdForLoot = -1;
  return result;
}
export function parseFinishDetect(config) {
  let checkTime = 5, delayTime = 1500; const checkNames = new Set(), delayTimes = new Map();
  for (const text of String(field(config, 'FastCheckParams', '')).split(';').filter(Boolean)) { const value = numeric(text); if (value !== null) checkTime = value; else checkNames.add(text.trim()); }
  for (const text of String(field(config, 'CheckEndDelay', '')).split(';').filter(Boolean)) {
    const parts = text.split(','), value = numeric(parts.at(-1));
    if (value !== null && parts.length === 1) delayTime = Math.trunc(value * 1000);
    else if (value !== null && parts.length === 2) delayTimes.set(parts[0].trim(), Math.trunc(value * 1000));
  }
  return { checkTime, checkNames: [...checkNames], delayTime, delayTimes, detectDelayTime: Math.trunc((numeric(field(config, 'BeforeDetectDelay', '')) ?? .45) * 1000) };
}
export function selectCombatStrategy(strategies, team) {
  let best, matchCount = 0;
  for (const strategy of strategies) {
    const count = team.filter(avatar => strategy.avatarNames.includes(typeof avatar === 'string' ? avatar : avatar.name)).length;
    if (count && (!best || count > matchCount || count === matchCount && strategy.avatarNames.length < best.avatarNames.length)) { best = strategy; matchCount = count; }
  }
  if (!best) throw new Error('未匹配到任何战斗脚本');
  return { strategy: best, matchCount };
}
export async function loadCombatStrategies(filename, aliases, log) {
  const info = await stat(filename);
  if (!info.isDirectory()) {
    if (path.extname(filename).toLowerCase() === '.json') return [await loadJsonCombatStrategy(filename)];
    return [{ ...parseCombatScript(await readFile(filename, 'utf8'), { aliases }), filename, name: path.basename(filename, path.extname(filename)) }];
  }
  const scripts = [];
  for (const entry of await readdir(filename, { withFileTypes: true })) {
    const full = path.join(filename, entry.name);
    if (entry.isDirectory()) scripts.push(...await loadCombatStrategies(full, aliases, log));
    else if (entry.isFile() && /\.(txt|json)$/i.test(entry.name)) {
      try { scripts.push(...await loadCombatStrategies(full, aliases, log)); } catch (error) { log?.('warn', '解析战斗脚本失败: ' + full + ': ' + error.message); }
    }
  }
  return scripts;
}

export class AutoFightTask extends CombatTasks {
  constructor(host, { config = {}, taskConfig = {}, strategies, strategyRoot, partyState = {}, resources } = {}, state = {}) {
    super(Object.create(host), fightConfig(config, taskConfig), state);
    this.host.combat = (operation, args) => this.call(operation, args);
    this.strategies = strategies; this.strategyRoot = strategyRoot; this.partyState = partyState; this.resources = resources;
    this.seeker = new FightSeek(this.host, state); this.finish = parseFinishDetect(this.options.FinishDetectConfig);
  }
  async strategy(team) {
    let strategies = this.strategies;
    if (!strategies) {
      const aliases = (await loadAvatarCatalog(this.host.sourceRoot)).aliases;
      const configured = field(this.options, 'CombatStrategyPath');
      const root = this.strategyRoot ?? path.resolve(this.host.sourceRoot, '../scripts/repo/combat');
      const name = this.options.StrategyName;
      if (name === '自动连招（实验）') throw new UnsupportedNativeOperation('AutoFight combo strategy');
      let filename = configured || (name === '根据队伍自动选择' ? root : path.join(root, name + '.txt'));
      if (!configured && name !== '根据队伍自动选择') {
        const jsonPath = path.join(root, name + '.json');
        try { if ((await stat(jsonPath)).isFile()) filename = jsonPath; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      strategies = await loadCombatStrategies(filename, aliases, this.host.log);
    }
    if (strategies.length === 1 && strategies[0].kind === 'json') return { strategy: strategies[0], matchCount: team.filter(avatar => strategies[0].avatarNames.includes(avatar.name)).length };
    return selectCombatStrategy(strategies, team);
  }
  async guardianCooldown(avatar, skill = 'E', frame) {
    if (!await this.switchAvatar({ name: avatar.name }, true)) return false;
    const read = capture => this.host.vision('fight.guardianCooldown', { handle: capture.handle, skill });
    return (await (frame ? read(frame) : this.captured(read))).cooldown;
  }
  async ensureGuardian(avatar) {
    return this.exclusive(async () => {
      if (this.remaining(avatar) <= 0) {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (!await this.switchAvatar({ name: avatar.name, tryTimes: 10 }, true)) continue;
          avatar.manualSkillCd = -1;
          if (await this.guardianCooldown(avatar) && await this.afterUseSkill({ name: avatar.name }) > 0) return;
          await this.useSkill({ name: avatar.name, hold: this.options.GuardianAvatarHold });
          let frame = await this.host.capture(), retry = 50;
          try {
            while (!await this.guardianCooldown(avatar, 'E', frame) && retry > 0) {
              await input(this.host, 'keyPress', ['E']); await this.host.input('releaseAll', []);
              if (retry % 3 === 0) { await input(this.host, 'leftButtonClick'); await input(this.host, 'keyPress', ['X']); }
              await this.host.vision('image.dispose', { handle: frame.handle }); frame = null; frame = await this.host.capture();
              await sleep(this.host, 30); retry--;
            }
          } finally { if (frame) await this.host.vision('image.dispose', { handle: frame.handle }); }
          if (retry > 0) { avatar.lastSkillAt = now(this.host); avatar.manualSkillCd = -1; return; }
          avatar.manualSkillCd = 0; await this.useSkill({ name: avatar.name, hold: this.options.GuardianAvatarHold });
          await input(this.host, 'leftButtonClick'); await input(this.host, 'keyPress', ['X']);
        }
      } else if (this.options.BurstEnabled) {
        const ready = await this.captured(async frame => (await this.active(frame, {})) !== avatar.index && (await this.host.vision('fight.guardianBurst', { handle: frame.handle, index: avatar.index })).ready);
        if (!ready || !await this.switchAvatar({ name: avatar.name, tryTimes: 8 }, true)) return;
        await input(this.host, 'keyPress', ['Q']); await sleep(this.host, 500); await this.host.input('releaseAll', []);
        await input(this.host, 'leftButtonClick');
        const observed = await this.captured(async frame => await this.guardianCooldown(avatar, 'Q') || !await this.isInMainUi(frame));
        avatar.isBurstReady = !observed;
        if (!observed) { await sleep(this.host, 500); await input(this.host, 'leftButtonClick'); await input(this.host, 'keyPress', ['Q']); }
      }
    });
  }
  async targetTick() {
    if (this.state.exclusiveCount > 0) return;
    await this.captured(async frame => {
      if (!await this.isInMainUi(frame) && !exists(await this.find(frame, 'Common/Element', 'InDomain'))) return;
      const aim = { x: Math.trunc(frame.width * .5), y: Math.trunc(frame.height * 480 / 1080) };
      const bars = (await this.host.vision('party.bloodBars', { handle: frame.handle })).filter(bar => bar.x > Math.trunc(200 * Math.min(frame.width / 1920, frame.height / 1080, 1)));
      let target;
      if (bars.length && !bars.some(bar => bar.legendary)) {
        target = bars.map(bar => ({ x: bar.x + Math.trunc(bar.width / 2), y: bar.y + Math.trunc(bar.height / 2) })).sort((a, b) => Math.abs(a.x - aim.x) + Math.abs(a.y - aim.y) - Math.abs(b.x - aim.x) - Math.abs(b.y - aim.y))[0];
      } else { const damage = await this.host.vision('party.damageNumber', { handle: frame.handle, mode: this.options.DamageNumberRecognitionMode }); if (damage) target = { x: damage.centerX, y: damage.centerY }; }
      const dpi = field(this.options, 'dpi', 1);
      let move;
      if (target) { this.lastSeen = now(this.host); move = [Math.trunc((target.x - aim.x) * .35 * dpi), Math.trunc((target.y - aim.y) * .25 * dpi)]; }
      else if (this.lastSeen == null || now(this.host) - this.lastSeen >= this.options.LockLostWaitTime * 1000) move = [Math.trunc(250 * dpi), 0];
      if (move && this.state.exclusiveCount === 0) await input(this.host, 'moveMouseBy', move);
    });
  }
  background(body, interval, { cleanup = false } = {}) {
    const controller = new AbortController(), signal = this.host.signal ? AbortSignal.any([this.host.signal, controller.signal]) : controller.signal;
    const host = Object.assign(Object.create(this.host), { signal });
    const worker = new AutoFightTask(host, { config: this.options, strategies: [] }, this.state);
    let stopped = false;
    const promise = (async () => {
      try { while (!signal.aborted) { await body(worker); await sleep(host, interval); } }
      catch (error) { if (!signal.aborted) { this.backgroundFailure = error; this.host.log?.('error', error.message); } }
      finally {
        if (cleanup) {
          const clearHost = Object.assign(Object.create(this.host), { signal: null });
          await clearHost.input('releaseAll', []); await clearHost.sleep(50); await clearHost.input('middleButtonClick', []);
          await clearHost.clearTargetOverlay?.();
        }
      }
    })();
    return { async stop() { if (!stopped) { stopped = true; controller.abort(); } await promise; } };
  }
  async pickup({ timedOut, lastFightName }) {
    const o = this.options, receipt = { skillPickup: null, scan: null };
    if (o.KazuhaPickupEnabled) {
      let team = await this.initializeTeam(), picker = team.find(avatar => avatar.name === '枫原万叶') ?? team.find(avatar => avatar.name === '琴');
      const party = new PartyTasks(this.host, {}, this.partyState);
      let oldPartyName = this.partyState.partyName, switched = false;
      try {
        if (!picker && !timedOut && o.KazuhaPartyName) {
          if (!oldPartyName) {
            await this.returnMainUi(); await input(this.host, 'keyPress', ['L']);
            for (let attempt = 0; attempt < 15; attempt++) {
              await sleep(this.host, 500);
              oldPartyName = await this.captured(async frame => { const button = await this.find(frame, 'Common/Element', 'PartyBtnChooseView'); if (!exists(button)) return null; return cleanPartyName((await party.ocr(frame, [button.x + button.width, button.y, Math.trunc(350 * party.scale(frame)), button.height])).map(region => region.text).join('\n')); });
              if (oldPartyName) break;
            }
            await this.returnMainUi();
          }
          if (oldPartyName && oldPartyName !== o.KazuhaPartyName) {
            switched = await party.switchParty(o.KazuhaPartyName);
            if (switched) { this.clearTeam(); team = await this.initializeTeam({ force: true, requireObserved: true }); picker = team.find(avatar => avatar.name === '枫原万叶') ?? team.find(avatar => avatar.name === '琴'); }
          }
        }
        const skipKazuha = picker?.name === '枫原万叶' && lastFightName === picker.name && this.remaining(picker) > 3 && !o.QinDoublePickUp;
        if (picker && !skipKazuha && await this.switchAvatar({ name: picker.name, tryTimes: 10 }, true)) {
          if (picker.name === '枫原万叶' && (lastFightName !== picker.name || this.remaining(picker) <= 3 || o.QinDoublePickUp)) {
            await sleep(this.host, 100); await this.call('waitSkillCd', { name: picker.name });
            await this.host.input('leftButtonUp', []); await sleep(this.host, 10);
            try { await input(this.host, 'keyDown', ['E']); await sleep(this.host, 800); } finally { await this.host.input('keyUp', ['E']); }
            await sleep(this.host, 50);
            try { for (let i = 0; i < 6; i++) { await this.host.input('leftButtonUp', []); await sleep(this.host, 10); await input(this.host, 'leftButtonDown'); await sleep(this.host, 35); await this.host.input('leftButtonUp', []); await sleep(this.host, 50); } }
            finally { await this.host.input('leftButtonUp', []); }
            await sleep(this.host, 1500); await this.afterUseSkill({ name: picker.name }); receipt.skillPickup = { avatar: picker.name, issued: true, inventoryVerified: false };
          } else if (picker.name === '琴') {
            const resources = this.resources ?? await loadPathingActionResources(this.host.sourceRoot), aliases = (await this.catalog()).aliases;
            let find = o.QinDoublePickUp;
            for (const action of resources.pickup.filter(action => action.startsWith('琴-长E '))) {
              const script = parseCombatScript(action.replaceAll('琴-长E', '琴'), { aliases });
              for (let pass = 0; pass < 2; pass++) {
                await this.call('waitSkillCd', { name: picker.name });
                for (const command of script.commands) {
                  await executeCombatCommand(command, this.host, { team, checkFight: false });
                  if (find && await this.captured(frame => this.find(frame, 'AutoPick', 'F')).then(exists)) find = false;
                }
                if (!find) break;
                if (pass === 0) await this.afterUseSkill({ name: picker.name });
              }
              await this.host.input('releaseAll', []);
            }
            receipt.skillPickup = { avatar: picker.name, issued: true, promptObserved: !find && o.QinDoublePickUp, inventoryVerified: false };
          }
        }
      } finally {
        if (switched && oldPartyName) {
          try { receipt.partyRestored = await party.switchParty(oldPartyName); }
          catch (error) { check(this.host); receipt.partyRestored = false; this.host.log?.('warn', '恢复拾取前队伍失败: ' + error.message); }
          finally { this.clearTeam(); }
        }
      }
    }
    if (o.PickDropsAfterFightEnabled) receipt.scan = await new PathingActions(this.host).scanPick(o.PickDropsAfterFightSeconds);
    return receipt;
  }
  async start() {
    const o = this.options, state = this.state, team = await this.initializeTeam();
    const selected = await this.strategy(team);
    if (selected.strategy.kind === 'json') return new AutoFightJsonTask(this, { strategy: selected.strategy }).start();
    const names = selected.strategy.avatarNames.filter(name => team.some(avatar => avatar.name === name));
    const commands = selected.strategy.commands.filter(command => names.includes(command.name));
    if (!commands.length) throw new Error('没有可用战斗脚本');
    for (const avatar of team) avatar.manualSkillCd = parseManualSkillCd(avatar.name, o.ActionSchedulerByCd) ?? -1;
    const canSkip = names.filter(name => parseManualSkillCd(name, o.ActionSchedulerByCd) !== null), allSkip = names.every(name => canSkip.includes(name));
    const guardian = String(o.GuardianAvatar).trim() ? team.find(avatar => avatar.index === Number(o.GuardianAvatar)) : null;
    if (String(o.GuardianAvatar).trim() && !guardian) throw new Error('盾奶位不在当前队伍');
    state.rotationCount = 0; state.skipCheckCounter = 0; state.fightStartAt = state.lastFightCheckAt = now(this.host); state.fightActive = true;
    let targeting, experience, expDetected = false, ended = false, timedOut = false, lastFightName = '', countFight = 0, executed = 0, passes = 0, delayTime = this.finish.delayTime, lastCheck = now(this.host);
    const timeout = () => { if (now(this.host) - state.fightStartAt > o.Timeout * 1000 || state.rotationCount >= 6) { timedOut = true; ended = true; } return timedOut; };
    try {
      await this.host.vision('party.resetTargetTracker', {});
      if (o.EnableCombatTargeting) targeting = this.background(worker => worker.targetTick(), o.TargetingDetectionInterval, { cleanup: true });
      if (o.KazuhaPickupEnabled && o.ExpBasedPickupEnabled) experience = this.background(async worker => { if (!expDetected) expDetected = await worker.captured(async frame => (await worker.host.vision('fight.experience', { handle: frame.handle })).detected); }, 100);
      try {
        while (!ended) {
          check(this.host); if (this.backgroundFailure) throw this.backgroundFailure; if (timeout()) break;
          passes++;
          if (allSkip) { const cd = Math.min(...names.map(name => this.remaining(team.find(avatar => avatar.name === name)))); if (cd > 0) await sleep(this.host, Math.ceil(cd * 1000)); }
          let skipFightName = '', passExecuted = 0;
          for (let i = 0; i < commands.length; i++) {
            check(this.host); if (timeout()) break;
            const command = commands[i], previous = commands[Math.max(0, i - 1)], avatar = team.find(avatar => avatar.name === command.name);
            if (guardian && lastFightName !== command.name) await this.ensureGuardian(guardian);
            if (o.FinishDetectConfig.RotateFindEnemyEnabled && i === 0 && o.IsFirstCheck) await this.exclusive(() => this.seeker.seek({ delayTime, detectDelayTime: this.finish.detectDelayTime, isEndCheck: true, rotaryFactor: o.RotaryFactor }));
            if (avatar === guardian && (o.GuardianCombatSkip || o.BurstEnabled)) continue;
            if (!(lastFightName === command.name && skipFightName === '') && (allSkip || canSkip.includes(command.name))) {
              if (this.remaining(avatar) > 0) { skipFightName = command.name; continue; }
              skipFightName = '';
            }
            if (timeout()) break;
            if (o.FinishDetectConfig.RotateFindEnemyEnabled && o.CheckBeforeBurst && (command.method === 'burst' || command.args.some(arg => ['q', 'Q'].includes(arg)))) ended = await this.checkFight({ delayTime, detectDelayTime: this.finish.detectDelayTime });
            const result = await executeCombatCommand({ ...command, activatingRound: null }, this.host, { team, previous, checkFight: false, dpi: field(o, 'dpi', 1) });
            executed += result.executed; passExecuted += result.executed;
            const boundary = i === commands.length - 1 || command.name !== commands[i + 1].name;
            if (boundary) countFight++;
            if (command.method === 'check' && o.FightFinishDetectEnabled) ended = await this.checkFight({ delayTime, detectDelayTime: this.finish.detectDelayTime });
            lastFightName = command.name;
            if (!ended && o.FightFinishDetectEnabled && (i === commands.length - 1 || boundary && o.FinishDetectConfig.FastCheckEnabled && (this.finish.checkTime > 0 && now(this.host) - lastCheck > this.finish.checkTime * 1000 || this.finish.checkNames.includes(command.name)))) {
              lastCheck = now(this.host); delayTime = this.finish.delayTimes.get(command.name) ?? delayTime;
              ended = await this.checkFight({ delayTime, detectDelayTime: this.finish.detectDelayTime });
            }
            if (ended) break;
          }
          if (!ended && passExecuted === 0) await sleep(this.host, 50);
          else if (!ended) await yieldToEvents();
        }
      } finally { state.fightActive = false; await this.seeker.stopMovements(); await this.host.input('releaseAll', []); await targeting?.stop(); }
      if (experience && !expDetected) for (let wait = 1100; !expDetected && wait > 0; wait -= 100) await sleep(this.host, 100);
      await experience?.stop();
      const base = { completed: true, ended: ended && !timedOut, timedOut, completion: timedOut ? state.rotationCount >= 6 ? 'rotationLimit' : 'timeout' : 'partyLoadingObserved', strategy: selected.strategy.name, matchCount: selected.matchCount, passes, executed, countFight, experienceObserved: experience ? expDetected : null };
      if (experience && !expDetected) return { ...base, pickup: { skipped: 'experienceNotObserved', scan: o.PickDropsAfterFightEnabled ? await new PathingActions(this.host).scanPick(o.PickDropsAfterFightSeconds) : null } };
      if (o.BattleThresholdForLoot >= 2 && countFight < o.BattleThresholdForLoot) return { ...base, pickup: { skipped: 'belowBattleThreshold' } };
      return { ...base, pickup: await this.pickup({ timedOut, lastFightName }) };
    } finally {
      state.fightActive = false;
      await experience?.stop(); await targeting?.stop(); await this.seeker.stopMovements(); await this.host.input('releaseAll', []);
    }
  }
}

export async function runAutoFight(host, options = {}, state) {
  const strategy = field(options.taskConfig, 'CombatStrategyPath', field(options.taskConfig, 'StrategyName', field(options.config, 'StrategyName')));
  if (strategy === '自动连招（实验）') {
    const { buildComboSession, AutoComboTask } = await import('./combo.mjs');
    const session = options.comboSession ?? await buildComboSession(host, options.comboBuildConfig ?? {});
    return new AutoComboTask(host, { ...options, session }, state).start();
  }
  return new AutoFightTask(host, options, state).start();
}
