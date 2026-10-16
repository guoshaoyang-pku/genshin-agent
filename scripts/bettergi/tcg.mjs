// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoGeniusInvokation at c9db8b8291fe4ac25a600aee1582298005919eb2.
import { loadAvatarCatalog, loadTcgCatalog, parseTcgScript } from './native.mjs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const ELEMENTS = ['anemo', 'electro', 'dendro', 'hydro', 'pyro', 'cryo', 'geo', 'omni'];
const DEFAULT_RECTS = [[667, 632, 165, 282], [877, 632, 165, 282], [1088, 632, 165, 282]];
const TUNING = { 10: [570, 120], 9: [570, 130], 8: [600, 145], 7: [630, 160], 6: [620, 200],
  5: [720, 200], 4: [820, 200], 3: [920, 200], 2: [1020, 200], 1: [1120, 200] };
const field = (obj, key, fallback) => { const name = Object.keys(obj ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : obj[name]; };
const check = host => host.signal?.throwIfAborted();
const exists = region => !!region && region.width > 0 && region.height > 0;
const cleanupHost = host => Object.create(host, { signal: { value: null, writable: true } });
async function input(host, method, args = []) { check(host); const value = await host.input(method, args); check(host); return value; }
async function rawSleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function vision(host, op, args) { check(host); const value = await host.vision(op, args); check(host); return value; }

function rectangle(value) {
  const values = Array.isArray(value) ? value : ['X', 'Y', 'Width', 'Height'].map(key => field(value, key));
  if (values.length !== 4 || values.some(value => !Number.isInteger(value)) || values[2] <= 0 || values[3] <= 0) throw new TypeError('TCG card rectangles require integer X/Y and positive Width/Height');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key, i) => [key, values[i]]));
}

function settings(options) {
  const global = field(options, 'config', options);
  const config = field(global, 'AutoGeniusInvokationConfig', field(global, 'AutoGeniusInvokation', global));
  const sleepDelay = field(config, 'SleepDelay', 0), activeCharacterCardSpace = field(config, 'ActiveCharacterCardSpace', 41);
  const values = field(config, 'DefaultCharacterCardRects', DEFAULT_RECTS);
  if (!Number.isInteger(sleepDelay) || !Number.isInteger(activeCharacterCardSpace)) throw new TypeError('TCG SleepDelay and ActiveCharacterCardSpace must be integers');
  if (!Array.isArray(values) || values.length !== 3) throw new TypeError('TCG DefaultCharacterCardRects requires three rectangles');
  return { sleepDelay, activeCharacterCardSpace, defaultCharacterCardRects: values.map(rectangle) };
}

class TcgEnd extends Error {
  constructor(completion, observation) { super(completion); this.completion = completion; this.observation = observation; }
}

export class TcgControl {
  constructor(host, config) { this.host = host; this.config = config; this.diceOrder = [...ELEMENTS]; }
  async captured(body) {
    const host = this.host; check(host);
    const cleanup = cleanupHost(host), frame = await cleanup.capture();
    let failed;
    try {
      check(host);
      if (frame?.width !== 1920 || frame?.height !== 1080) throw new Error('自动七圣召唤要求游戏画面分辨率为1920x1080');
      return await body(frame);
    } catch (error) { failed = error; throw error; }
    finally {
      try { if (frame?.handle) await cleanup.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failed) throw error; host.log?.('error', 'TCG screenshot disposal failed: ' + error.message); }
    }
  }
  async observe(operation, args = {}) { return this.captured(frame => vision(this.host, 'tcg.' + operation, { ...args, handle: frame.handle })); }
  async ui(name) { return (await this.observe('ui', { names: [name] }))[name]; }
  async sleep(ms) {
    if (this.host.isGameActive) {
      let active = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        check(this.host); active = await this.host.isGameActive(); check(this.host);
        if (active) break;
        if (attempt < 99) await rawSleep(this.host, 1000);
      }
      if (!active) throw new Error('云游戏未处于可操作状态，七圣召唤暂停超时');
    }
    await rawSleep(this.host, ms);
    if (this.config.sleepDelay > 0) await rawSleep(this.host, this.config.sleepDelay);
  }
  async click(x, y) { await input(this.host, 'click', [x, y]); }
  async center() { await this.click(960, 540); }
  async clickRegion(region) {
    if (!exists(region)) throw new Error('Cannot click an empty TCG region');
    await this.click((region.globalX ?? region.x) + Math.trunc(region.width / 2), (region.globalY ?? region.y) + Math.trunc(region.height / 2));
  }
  async clickCard(character) { await this.clickRegion(character.area); }
  async clickConfirm() { const found = await this.ui('ConfirmButton'); if (!exists(found)) return false; await this.clickRegion(found); return true; }
  async throwIfEnd() { const found = await this.ui('ExitDuelButton'); if (exists(found)) throw new TcgEnd('exitDuelButtonObserved', found); }
  async prepare() {
    await this.sleep(1000);
    while (!await this.clickConfirm()) await this.sleep(1000);
    await this.sleep(3000);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt) await rawSleep(this.host, 800);
      if (exists(await this.ui('InCharacterPick'))) { await this.sleep(1500); return; }
    }
    throw new Error('等待出战角色选择界面超时');
  }
  async characterRects() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await rawSleep(this.host, 1500);
      const observation = await this.observe('characterRects');
      if (observation.rects?.length === 3) return { rects: observation.rects.map(rectangle), method: observation.method };
    }
    return { rects: this.config.defaultCharacterCardRects.map(rectangle), method: 'configuredFallback' };
  }
  sortDice(elements) {
    const desired = elements.map(element => element.toLowerCase());
    this.diceOrder.sort((a, b) => desired.indexOf(b) - desired.indexOf(a));
  }
  async reroll(elements) {
    const hold = new Set(elements.map(element => element.toLowerCase()));
    await this.sleep(5000);
    let failures = 0;
    while (true) {
      const observed = await this.observe('rollDice');
      if (observed.total === 8 && observed.upper === 4 && observed.lower === 4) {
        for (const element of ELEMENTS) {
          if (hold.has(element)) continue;
          for (const match of observed.matches.filter(match => match.element === element)) {
            await this.clickRegion(match); await this.sleep(100);
          }
        }
        break;
      }
      failures++; await this.throwIfEnd(); await this.sleep(500);
      if (failures > 35) throw new Error('识别投骰子数量或位置不正确，重试超时');
    }
    await this.clickConfirm(); await this.sleep(1000); await this.center(); await this.sleep(5000);
  }
  async chooseFirst(character) { await this.clickCard(character); await rawSleep(this.host, 200); await this.clickCard(character); }
  async switchLater(character) {
    await this.center(); await this.sleep(800); await this.clickCard(character);
    await this.click(1820, 960); await this.sleep(800); await this.click(1820, 960);
  }
  async tuningAlternatives(cardCount) {
    const coordinates = TUNING[cardCount];
    if (!coordinates) return false;
    const [startX, spacing] = coordinates;
    await this.click(960, 1030); await this.sleep(1500);
    for (let index = 0; index < cardCount; index++) {
      await this.click(startX + index * spacing, 1030); await this.sleep(500);
      let holding = true, failed;
      try {
        await input(this.host, 'leftButtonDown'); await this.sleep(100);
        await input(this.host, 'moveMouseTo', [1870, 540]); await this.sleep(100);
        await input(this.host, 'leftButtonUp'); holding = false;
      } catch (error) { failed = error; throw error; }
      finally {
        if (holding) {
          try { await cleanupHost(this.host).input('leftButtonUp', []); }
          catch (error) { if (!failed) throw error; this.host.log?.('error', 'TCG tuning release failed: ' + error.message); }
        }
      }
      await this.sleep(1200);
      const confirm = await this.ui('ElementalTuningConfirmButton');
      if (exists(confirm)) { await this.clickRegion(confirm); return true; }
      await this.center(); await this.sleep(1000);
    }
    return false;
  }
  async useSkill(index) {
    await this.center(); await this.sleep(500);
    await this.click(1920 - 100 * index, 960); await this.sleep(1200);
    if (exists(await this.ui('ElementalDiceLackWarning'))) return false;
    await this.click(1920 - 100 * index, 960); await this.sleep(500); await this.center();
    return true;
  }
  async autoUseSkill(index, specificCost, element, duel) {
    let dice9Count = 0, retries = 0, observed = await this.observe('actionDice', { order: this.diceOrder });
    while (observed.total !== duel.diceCount) {
      if (retries > 20) throw new Error('骰子数量与预期不符，重试次数过多');
      if (observed.total === 9 && duel.diceCount === 8 && observed.counts.omni > 0 && ++dice9Count > 5) {
        duel.evidence.diceCorrections.push({ method: 'sourceNineDiceHeuristic', from: 8, to: 9, observations: dice9Count });
        duel.diceCount = 9; break;
      }
      observed = await this.observe('actionDice', { order: this.diceOrder }); retries++; await this.sleep(1000);
    }
    const needed = specificCost - observed.counts.omni - observed.counts[element.toLowerCase()];
    if (needed > duel.cardCount) return false;
    for (let index = 0; index < needed; index++) {
      if (!await this.tuningAlternatives(duel.cardCount)) return false;
      await this.sleep(1000); await this.center(); await this.sleep(500); duel.cardCount--;
      if (duel.cardCount <= 1) { await this.center(); await this.sleep(500); }
    }
    return this.useSkill(index);
  }
  async updateDefeated(duel) {
    const observed = await this.observe('defeated', { rects: duel.rects });
    if (!Array.isArray(observed.defeated) || observed.defeated.length !== 3 || observed.defeated.some(value => typeof value !== 'boolean')) throw new Error('Invalid TCG defeated observation');
    observed.defeated.forEach((value, index) => { duel.characters[index + 1].isDefeated = value; });
  }
  async activeCharacter(duel) {
    await this.updateDefeated(duel);
    let observed = await this.observe('activeHp', { rects: duel.rects, defeated: duel.characters.slice(1).map(character => character.isDefeated), activeCharacterCardSpace: this.config.activeCharacterCardSpace });
    if (!observed.index) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await rawSleep(this.host, 300);
        observed = await this.observe('activeWord', { rects: duel.rects });
        if (observed.index) break;
      }
    }
    if (![1, 2, 3].includes(observed.index)) throw new Error('未识别到出战角色');
    const character = duel.characters[observed.index];
    character.hp = observed.hp; character.energyByRecognition = observed.energy;
    character.statusList.push(...observed.statuses);
    duel.evidence.activeCharacter = observed;
    return character;
  }
  async whenDefeated(duel) {
    await this.updateDefeated(duel);
    const order = [...new Set(duel.queue.map(command => command.character.index))];
    if (!order.length) throw new TcgEnd('noFutureStrategyCharacter', { order });
    for (const index of order) {
      const character = duel.characters[index];
      if (character.isDefeated) continue;
      await this.clickCard(character); await this.sleep(500); await this.clickCard(character); await this.sleep(300);
      duel.evidence.actions.push({ action: 'SwitchWhenTakenOut', character: index, evidence: 'inputIssued' });
      break;
    }
    await this.center(); await this.sleep(2000);
  }
  async waitForMyTurn(duel, initialWait = 0) {
    if (initialWait > 0) await this.sleep(initialWait);
    let myTurnObservations = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (exists(await this.ui('RoundEndButton'))) {
        if (exists(await this.ui('CharacterTakenOut'))) await this.whenDefeated(duel);
        else if (++myTurnObservations === 3) return;
      } else await this.throwIfEnd();
      if (attempt === 59) throw new Error('等待对方行动超时');
      await this.sleep(1000);
    }
  }
  randomInt(maximum) {
    const value = (this.host.random ?? Math.random)();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('TCG random must return a value in [0,1)');
    return 1 + Math.floor(value * (maximum - 1));
  }
  async waitOpponentAction(duel) {
    await this.sleep(3000 + this.randomInt(1000));
    for (let attempt = 0; attempt < 60; attempt++) {
      if (exists(await this.ui('InOpponentAction'))) { /* keep waiting */ }
      else if (exists(await this.ui('EndPhase'))) { /* keep waiting */ }
      else if (exists(await this.ui('RoundEndButton'))) {
        if (exists(await this.ui('CharacterTakenOut'))) await this.whenDefeated(duel);
      } else {
        await this.throwIfEnd();
        if (attempt > 2) return;
      }
      if (attempt === 59) throw new Error('等待对方回合结束超时');
      await this.sleep(1000 + this.randomInt(500));
    }
  }
  async roundEnd() {
    const found = await this.ui('RoundEndButton');
    if (exists(found)) { await this.clickRegion(found); await this.sleep(1000); await this.clickRegion(found); await this.sleep(300); }
    await this.center();
  }
}

export class TcgDuel {
  constructor(strategy, control) {
    this.characters = strategy.characters; this.queue = strategy.actionCommandQueue; this.roundNum = strategy.roundNum;
    this.control = control; this.cardCount = 0; this.diceCount = 0; this.keqingECount = 0;
    for (const character of this.characters.slice(1)) { character.isDefeated = false; character.statusList = []; character.energyByRecognition = 0; }
    this.evidence = { completed: false, completion: null, verified: false, winnerVerified: false, rewardsVerified: false,
      roundsStarted: 0, actions: [], diceCorrections: [], strategyCommands: this.queue.length };
  }
  predictDice() {
    let sum = 0; const desired = new Set(['Omni']);
    for (let index = 0; index < this.queue.length; index++) {
      const command = this.queue[index];
      if (command.character.isDefeated) continue;
      if (index > 0 && command.character.index !== this.queue[index - 1].character.index && ++sum > this.diceCount) break;
      sum += Math.max(command.character.skills[command.targetIndex].allCost + command.diceDelta, 0);
      if (sum > this.diceCount) break;
      desired.add(command.character.element);
    }
    const elements = [...desired]; this.control.sortDice(elements); return elements;
  }
  waitTime(command) {
    if (command.action === 'UseSkill' && command.targetIndex === 1) return 15000;
    if (command.action === 'SwitchLater' && command.character.name === '莫娜') return 3000;
    return 10000;
  }
  async action() {
    const control = this.control;
    this.current = await control.activeCharacter(this);
    const observation = await control.observe('diceCount');
    if (observation.count !== -10) {
      const difference = Math.abs(this.diceCount - observation.count);
      if (difference > 0 && difference <= 4) {
        this.evidence.diceCorrections.push({ method: 'diceCountOcr', from: this.diceCount, to: observation.count, observation });
        this.diceCount = observation.count;
      }
    }
    for (let index = 0; index < this.queue.length; index++) {
      const command = this.queue[index], character = command.character;
      if (character.isDefeated || character.statusList.length) continue;
      if (this.current.index !== character.index) {
        if (this.diceCount < 1) return null;
        await control.switchLater(character); this.diceCount--;
        return { action: 'SwitchLater', character: this.current, targetIndex: character.index };
      }
      const skill = character.skills[command.targetIndex];
      if (skill.allCost + command.diceDelta > this.diceCount) return null;
      if (await control.autoUseSkill(command.targetIndex, skill.specificElementCost, skill.type, this)) {
        this.diceCount -= Math.max(skill.allCost + command.diceDelta, 0); this.queue.splice(index, 1);
        if (character.name === '刻晴' && command.targetIndex === 2) this.cardCount += ++this.keqingECount % 2 ? 1 : -1;
        return command;
      }
      await control.sleep(1000); await control.center(); return null;
    }
    return null;
  }
  async run() {
    const control = this.control;
    await control.captured(() => null);
    await control.prepare();
    const rectangles = await control.characterRects();
    this.rects = rectangles.rects; this.evidence.characterRects = rectangles;
    this.characters.slice(1).forEach((character, index) => { character.area = this.rects[index]; });
    this.current = this.queue[0].character; await control.chooseFirst(this.current);
    while (true) {
      check(control.host); this.evidence.roundsStarted++;
      control.host.log?.('info', '七圣召唤第' + this.roundNum + '回合');
      for (const character of this.characters.slice(1)) character.statusList.length = 0;
      this.cardCount = this.roundNum === 1 ? 5 : this.cardCount + 2; this.diceCount = 8;
      await control.reroll(this.predictDice()); await control.waitForMyTurn(this, 1000);
      while (true) {
        if (this.diceCount <= 0) { await control.sleep(2000); break; }
        const command = await this.action();
        if (!command) { await control.sleep(2000); break; }
        this.evidence.actions.push({ round: this.roundNum, action: command.action, character: command.character.index,
          targetIndex: command.targetIndex, diceDelta: command.diceDelta ?? 0, diceCount: this.diceCount, cardCount: this.cardCount,
          evidence: command.action === 'UseSkill' ? 'diceLackWarningAbsent' : 'inputIssued' });
        await control.waitForMyTurn(this, this.waitTime(command));
        if (!this.queue.length) throw new TcgEnd('strategyExhausted', { remainingCommands: 0 });
      }
      await control.sleep(1000); await control.roundEnd(); await control.waitOpponentAction(this); this.roundNum++;
    }
  }
}

export async function runAutoGeniusInvokation(rawHost, options = {}) {
  let failed, duel;
  try {
    check(rawHost); const config = settings(options);
    const content = await resolveTcgStrategy(rawHost, options);
    if (typeof content !== 'string' || !content.trim()) throw new TypeError('七圣召唤需要非空 StrategyContent');
    const [cards, { aliases }] = await Promise.all([loadTcgCatalog(rawHost.sourceRoot), loadAvatarCatalog(rawHost.sourceRoot)]);
    check(rawHost); const strategy = parseTcgScript(content, { cards, aliases });
    if (strategy.characters.slice(1).length !== 3 || strategy.characters.slice(1).some(character => !character)) throw new Error('七圣召唤策略必须定义三个角色');
    if (!strategy.actionCommandQueue.length) throw new Error('七圣召唤策略没有行动指令');
    for (const command of strategy.actionCommandQueue) if (!command.character.skills[command.targetIndex]) throw new Error('七圣召唤策略引用未定义技能：' + command.targetIndex);
    duel = new TcgDuel(strategy, new TcgControl(rawHost, config));
    try { await duel.run(); }
    catch (error) {
      if (!(error instanceof TcgEnd)) throw error;
      return { ...duel.evidence, completed: true, completion: error.completion, terminalObservation: error.observation,
        remainingCommands: duel.queue.length, roundNum: duel.roundNum, diceCount: duel.diceCount, cardCount: duel.cardCount };
    }
  } catch (error) {
    failed = error; if (duel && error && typeof error === 'object' && !rawHost.signal?.aborted) error.evidence = duel.evidence; throw error;
  } finally {
    try { await cleanupHost(rawHost).input('releaseAll', []); }
    catch (error) { if (!failed) throw error; rawHost.log?.('error', 'TCG input release failed: ' + error.message); }
  }
}

export async function resolveTcgStrategy(host, options = {}) {
  const task = field(options, 'taskConfig', {});
  const content = field(task, 'StrategyContent', field(task, 'strategy', field(options, 'strategyContent')));
  if (typeof content === 'string' && content.trim()) return content;
  if (content != null && typeof content !== 'string') throw new TypeError('TCG strategy must be a string');
  const config = field(field(options, 'config', {}), 'AutoGeniusInvokationConfig', {});
  const name = field(task, 'StrategyName', field(config, 'StrategyName'));
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('七圣召唤需要非空 StrategyContent 或配置 StrategyName');
  const root = await realpath(options.strategyRoot ?? path.resolve(host.sourceRoot, '../scripts/repo/tcg'));
  const filename = await realpath(path.resolve(root, name.endsWith('.txt') ? name : name + '.txt'));
  if (!filename.startsWith(root + path.sep)) throw new Error('TCG strategy path escapes the configured strategy directory');
  check(host); const source = await readFile(filename, 'utf8'); check(host); return source;
}

export const runAutoTcg = runAutoGeniusInvokation;
