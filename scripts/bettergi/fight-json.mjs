// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoFightJsonTask and Script/JsonCombatStrategy{,Parser} at c9db8b8.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { executeCombatCommand, parseCombatLineCommands, parseCombatLinePart } from './native.mjs';
import { ConditionEvaluator, isValidActionName } from './fight-condition.mjs';

const now = runtime => runtime.host.now?.() ?? performance.now();
const check = runtime => runtime.host.signal?.throwIfAborted();
async function sleep(runtime, ms) { check(runtime); await runtime.host.sleep(ms); check(runtime); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (value, key, fallback) => {
  const entry = Object.entries(value ?? {}).findLast(([name]) => name.toLowerCase() === key.toLowerCase());
  return entry ? entry[1] : fallback;
};
function text(value, fallback = '') {
  if (value === undefined) return fallback;
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  throw new TypeError('JSON 战斗策略文本字段类型错误');
}
function integer(value = 0) {
  const result = typeof value === 'string' && /^[+-]?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(result) || result < -2147483648 || result > 2147483647) throw new TypeError('JSON 战斗策略优先级必须为 Int32');
  return result;
}
function boolean(value = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  throw new TypeError('JSON 战斗策略 EnsureCast 必须为布尔值');
}

// Newtonsoft permits comments, trailing commas, single quotes and unquoted keys.
// Normalize those tokens only; quoted text, including URLs and escaped quotes, survives.
function json(source) {
  let clean = '';
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1];
    if (c === '"' || c === "'") {
      const quote = c; let value = '"'; i++;
      let closed = false;
      while (i < source.length) {
        const char = source[i++];
        if (char === quote) { closed = true; break; }
        if (char === '\\') {
          if (i >= source.length) throw new SyntaxError('不完整的字符串转义');
          const escaped = source[i++];
          value += escaped === "'" ? "'" : '\\' + escaped;
        } else value += char === '"' ? '\\"' : char;
      }
      if (!closed) throw new SyntaxError('缺少字符串结束引号');
      clean += value + '"'; continue;
    }
    if (c === '/' && next === '/') { i += 2; while (i < source.length && source[i] !== '\n') i++; clean += ' '; continue; }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('缺少注释结束符');
      i = end + 2; clean += ' '; continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      const start = i++;
      while (i < source.length && /[\p{L}\p{Nd}_$]/u.test(source[i])) i++;
      const word = source.slice(start, i);
      clean += /^\s*:/.test(source.slice(i)) ? JSON.stringify(word) : word; continue;
    }
    clean += c; i++;
  }
  let result = '';
  for (let i = 0, quoted = false, escaped = false; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) { result += c; if (!escaped && c === '"') quoted = false; escaped = !escaped && c === '\\'; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
    result += c;
  }
  return JSON.parse(result.replace(/^\uFEFF/, ''));
}

export function parseJsonCombatStrategy(source, { filename } = {}) {
  let value;
  try { value = typeof source === 'string' ? json(source) : structuredClone(source); }
  catch (error) { throw new SyntaxError('JSON 战斗策略格式错误：' + error.message, { cause: error }); }
  if (!object(value)) throw new TypeError('JSON 战斗策略反序列化失败');
  const rawInfo = field(value, 'Info', {}), rawActions = field(value, 'Actions', []);
  if (!object(rawInfo)) throw new TypeError('JSON 战斗策略缺少 Info 节点');
  if (!Array.isArray(rawActions) || !rawActions.length) throw new TypeError('JSON 战斗策略中未定义任何动作');
  const preActions = field(rawInfo, 'PreActions', []), config = field(rawInfo, 'Config', null);
  if (preActions !== null && !Array.isArray(preActions)) throw new TypeError('JSON 战斗策略 PreActions 必须为数组');
  if (config !== null && !object(config)) throw new TypeError('JSON 战斗策略 Config 必须为对象');
  const info = { name: text(field(rawInfo, 'Name')), author: text(field(rawInfo, 'Author')), config, preActions: preActions?.map(value => text(value)) ?? [] };
  const actions = rawActions.map(raw => {
    if (!object(raw)) throw new TypeError('JSON 战斗策略动作必须为对象');
    const condition = field(raw, 'Condition', {}), priorities = field(raw, 'MorePriorities', []);
    if (!object(condition)) throw new TypeError('JSON 战斗策略 Condition 必须为对象');
    if (!Array.isArray(priorities)) throw new TypeError('JSON 战斗策略 MorePriorities 必须为数组');
    return { name: text(field(raw, 'Name')), character: text(field(raw, 'Character')), action: text(field(raw, 'Action')),
      condition: { expression: text(field(condition, 'Expression')) }, index: integer(field(raw, 'Index', 0)), ensureCast: boolean(field(raw, 'EnsureCast', false)),
      morePriorities: priorities.map(priority => {
        if (!object(priority)) throw new TypeError('JSON 战斗策略额外优先级必须为对象');
        return { expression: text(field(priority, 'Expression')), priority: integer(field(priority, 'Priority', 0)) };
      }) };
  });
  const actionNames = actions.map(action => action.name).filter(Boolean);
  for (const name of actionNames) if (!isValidActionName(name, actionNames)) throw new TypeError('JSON 战斗策略中动作名称无法作为条件标识符解析：' + name);
  return { kind: 'json', info, actions, avatarNames: [...new Set(actions.map(action => action.character).filter(Boolean))],
    name: info.name || (filename ? path.basename(filename, path.extname(filename)) : ''), ...(filename ? { filename } : {}) };
}

export async function loadJsonCombatStrategy(filename) { return parseJsonCombatStrategy(await readFile(filename, 'utf8'), { filename }); }

async function cleanup(runtime, steps, primary) {
  let failure;
  for (const step of steps) {
    try { await step(); }
    catch (error) {
      if (!primary && !failure) failure = error;
      else runtime.host.log?.('warn', 'JSON 战斗清理失败：' + error.message);
    }
  }
  if (failure) throw failure;
}

async function released(runtime, body) {
  let failure;
  try { return await body(); }
  catch (error) { failure = error; throw error; }
  finally { await cleanup(runtime, [() => runtime.host.input('releaseAll', [])], failure); }
}

export class AutoFightJsonTask {
  constructor(runtime, { strategy, filename } = {}) { this.runtime = runtime; this.strategy = strategy; this.filename = filename; }
  async executeCommands(commands, team, { detectEnd = false } = {}) {
    const runtime = this.runtime; let executed = 0, skipped = 0;
    for (let i = 0; i < commands.length; i++) {
      check(runtime);
      const command = { ...commands[i], activatingRound: null };
      const result = await executeCombatCommand(command, runtime.host, { team, previous: commands[Math.max(0, i - 1)], checkFight: false, dpi: runtime.options.dpi ?? 1 });
      executed += result.executed; skipped += result.skipped;
      if (detectEnd && command.method === 'check' && runtime.options.FightFinishDetectEnabled && await runtime.checkFight({ delayTime: runtime.finish.delayTime, detectDelayTime: runtime.finish.detectDelayTime }) === true) return { executed, skipped, ended: true };
    }
    return { executed, skipped, ended: false };
  }
  async preActions(team, evaluator) {
    const preActions = this.strategy.info.preActions;
    if (!preActions.length) return 0;
    return this.runtime.captured(async frame => {
      evaluator.setCachedCapture(frame); let executed = 0;
      try {
        for (const action of preActions) {
          check(this.runtime);
          const space = action.indexOf(' '), character = space > 0 ? action.slice(0, space) : this.currentAvatarName;
          const commands = parseCombatLineCommands(space > 0 ? action.slice(space + 1) : action, character);
          executed += (await this.executeCommands(commands, team)).executed;
          await sleep(this.runtime, 300);
        }
        return executed;
      } finally { evaluator.setCachedCapture(null); }
    });
  }
  async executeAction(action, team) {
    return released(this.runtime, async () => {
      const character = action.character || this.currentAvatarName;
      if (action.name !== this.lastLoggedAction || this.lastLogAt == null || now(this.runtime) - this.lastLogAt >= 1000) {
        this.lastLoggedAction = action.name; this.lastLogAt = now(this.runtime);
        this.runtime.host.log?.('info', '自动战斗：' + action.name);
      }
      const result = await this.executeCommands(parseCombatLinePart(action.action, character), team, { detectEnd: true });
      this.currentAvatarName = character;
      return result;
    });
  }
  async ensureCast(action, team) {
    const runtime = this.runtime, name = action.character || this.currentAvatarName;
    const avatar = team.find(avatar => avatar.name === name);
    if (!avatar) throw new Error('确保技能释放时角色不在队伍：' + name);
    let executed = 0, skipped = 0;
    for (let retries = 0; retries <= 5; retries++) {
      check(runtime);
      if (await runtime.captured(async frame => {
        if (retries > 0) await sleep(runtime, 30);
        return runtime.guardianCooldown(avatar, 'E', frame);
      }) === true) return { observed: true, retries, executed, skipped, ended: false };
      if (retries === 5) break;
      await runtime.host.input('releaseAll', []); check(runtime);
      await runtime.host.input('leftButtonClick', []); check(runtime);
      await runtime.host.input('keyPress', ['X']); await sleep(runtime, 200);
      const result = await this.executeAction(action, team); executed += result.executed; skipped += result.skipped;
      if (result.ended) return { observed: false, retries: retries + 1, executed, skipped, ended: true, reason: 'fightEndObserved' };
    }
    throw Object.assign(new Error('动作重试五次后仍未观察到 E 技能冷却：' + action.name), { code: 'ENSURE_CAST_UNOBSERVED', action: action.name, retries: 5 });
  }
  async fastCheck(previousName, action, afterSwitch) {
    const runtime = this.runtime, finish = runtime.finish, config = runtime.options.FinishDetectConfig;
    if (!runtime.options.FightFinishDetectEnabled || !config.FastCheckEnabled) return false;
    if (!(finish.checkTime > 0 && now(runtime) - runtime.state.lastFightCheckAt > finish.checkTime * 1000) && !finish.checkNames.includes(previousName)) return false;
    const targetName = action.character || this.currentAvatarName;
    const delayTime = afterSwitch && targetName !== previousName ? 50 : finish.delayTimes.get(previousName) ?? finish.delayTime;
    return await runtime.checkFight({ delayTime, detectDelayTime: finish.detectDelayTime }) === true;
  }
  async start() {
    const runtime = this.runtime, state = runtime.state, options = runtime.options;
    check(runtime);
    this.strategy ??= await loadJsonCombatStrategy(this.filename);
    const team = await runtime.initializeTeam();
    if (!team.length) throw new Error('JSON 战斗策略队伍识别未初始化成功');
    const teamNames = new Set(team.map(avatar => avatar.name.toLowerCase()));
    const actions = this.strategy.actions.filter(action => !action.character || teamNames.has(action.character.toLowerCase()));
    const priorities = actions.flatMap(action => [{ action, expression: action.condition.expression, priority: action.index }, ...action.morePriorities.map(priority => ({ action, ...priority }))]).sort((a, b) => a.priority - b.priority);
    const base = { strategy: this.strategy.name, kind: 'json', availableActions: actions.length, priorityEntries: priorities.length };
    if (!priorities.length) {
      state.fightActive = false;
      return { ...base, completed: false, ended: false, timedOut: false, completion: 'noAvailableActions', passes: 0, nodesExecuted: 0, commandsExecuted: 0, commandsSkipped: 0 };
    }
    const startAt = now(runtime);
    this.currentAvatarName = team[0].name;
    this.evaluator = new ConditionEvaluator(runtime, { actionNames: this.strategy.actions.map(action => action.name).filter(Boolean), battleStartAt: startAt });
    state.rotationCount = 0; state.fightActive = true;
    let targeting, experience, expDetected = false, ended = false, timedOut = false, lastFightName = '';
    let passes = 0, nodesExecuted = 0, commandsExecuted = 0, commandsSkipped = 0, preActionsExecuted = 0;
    const castObservations = []; let failure, fightCleaned = false;
    const stopTargeting = async () => { const worker = targeting; targeting = null; await worker?.stop(); };
    const stopExperience = async () => { const worker = experience; experience = null; await worker?.stop(); };
    const cleanFight = async primary => {
      if (fightCleaned) return;
      fightCleaned = true; state.fightActive = false;
      await cleanup(runtime, [() => runtime.seeker.stopMovements(), () => runtime.host.input('releaseAll', []), stopTargeting], primary);
    };
    try {
      await runtime.host.vision('party.resetTargetTracker', {});
      if (options.KazuhaPickupEnabled && options.ExpBasedPickupEnabled) experience = runtime.background(async worker => {
        if (!expDetected) expDetected = (await worker.captured(frame => worker.host.vision('fight.experience', { handle: frame.handle }))).detected;
      }, 100);
      preActionsExecuted = await this.preActions(team, this.evaluator);
      state.fightStartAt = state.lastFightCheckAt = now(runtime); state.skipCheckCounter = 0;
      if (options.EnableCombatTargeting) targeting = runtime.background(worker => worker.targetTick(), options.TargetingDetectionInterval, { cleanup: true });
      while (!ended) {
        check(runtime); if (runtime.backgroundFailure) throw runtime.backgroundFailure;
        if (now(runtime) - startAt > options.Timeout * 1000) { timedOut = true; break; }
        passes++; let anyExecuted = false;
        const previousName = this.currentAvatarName;
        await runtime.captured(async frame => {
          this.evaluator.setCachedCapture(frame);
          try {
            for (const entry of priorities) {
              check(runtime); const action = entry.action;
              if (!await this.evaluator.evaluate(entry.expression, action.index, action.character, action.name)) continue;
              if (!options.FinishDetectConfig.CheckAfterSwitchAvatar && await this.fastCheck(previousName, action, false)) { ended = true; break; }
              if (action.character) {
                if (!team.some(avatar => avatar.name === action.character) || await runtime.switchAvatar({ name: action.character }) !== true) continue;
                this.currentAvatarName = action.character;
              }
              if (options.FinishDetectConfig.CheckAfterSwitchAvatar && await this.fastCheck(previousName, action, true)) { ended = true; break; }
              const result = await this.executeAction(action, team);
              commandsExecuted += result.executed; commandsSkipped += result.skipped; ended = result.ended;
              if (action.ensureCast && !ended) {
                const cast = await this.ensureCast(action, team);
                commandsExecuted += cast.executed; commandsSkipped += cast.skipped; ended = cast.ended;
                castObservations.push({ action: action.name, ...cast });
              }
              this.evaluator.updateLastExecTime(action.index, action.name);
              nodesExecuted++; anyExecuted = true; lastFightName = action.character ?? '';
              break;
            }
          } finally { this.evaluator.setCachedCapture(null); }
        });
        if (!ended && !anyExecuted) await sleep(runtime, 200);
        else if (!ended) await yieldToEvents();
      }
      await cleanFight();
      const experienceEnabled = Boolean(experience);
      if (experience && !expDetected) for (let remaining = 1100; remaining > 0 && !expDetected; remaining -= 100) await sleep(runtime, 100);
      await stopExperience(); check(runtime);
      if (runtime.backgroundFailure) throw runtime.backgroundFailure;
      const receipt = { ...base, completed: true, ended, timedOut, completion: ended ? 'fightEndObserved' : 'timeout', passes, nodesExecuted, commandsExecuted, commandsSkipped, preActionsExecuted,
        castObservations, experienceObserved: experienceEnabled ? expDetected : null };
      if (experienceEnabled && !expDetected) {
        const pickupRuntime = Object.assign(Object.create(runtime), { options: { ...options, KazuhaPickupEnabled: false } });
        receipt.pickup = { ...await runtime.pickup.call(pickupRuntime, { timedOut, lastFightName }), skipped: 'experienceNotObserved' };
      } else receipt.pickup = await runtime.pickup({ timedOut, lastFightName });
      return receipt;
    } catch (error) { failure = error; throw error; }
    finally {
      state.fightActive = false; this.evaluator.setCachedCapture(null);
      await cleanup(runtime, [() => cleanFight(failure), stopExperience, stopTargeting], failure);
    }
  }
}

export const runAutoFightJson = (runtime, options) => new AutoFightJsonTask(runtime, options).start();
