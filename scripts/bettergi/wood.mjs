// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoWoodTask / WoodTaskParam / AutoWoodConfig at c9db8b8291fe4ac25a600aee1582298005919eb2.
import { PathingActions } from './actions.mjs';
import { BETTERGI_SOURCE_COMMIT, UnsupportedNativeOperation } from './native.mjs';
import { webKeyCode } from './cloud.mjs';

const woods = new Set([
  '悬铃木', '白梣木', '炬木', '椴木', '香柏木', '刺葵木', '柽木', '辉木', '业果木',
  '证悟木', '枫木', '垂香木', '杉木', '竹节', '却砂木', '松木', '萃华木', '桦木',
  '孔雀木', '梦见木', '御伽木', '燃爆木', '桃椰子木', '灰灰楼林木', '白栗栎木',
]);
const field = (obj, key, fallback) => { const name = Object.keys(obj ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : obj[name]; };
const matches = text => [...text.matchAll(/([^\p{Nd}\n]+)[×x](\p{Nd}+)/gu)];
const exists = region => !!region && region.width > 0 && region.height > 0;

function int32(value, name) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim()))) throw new TypeError(name + ' must be an Int32');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) throw new RangeError(name + ' must be an Int32');
  return parsed;
}
function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(name + ' must be boolean');
  return value;
}

export class WoodTaskParam {
  constructor(woodRoundNum = 0, woodDailyMaxCount = 2000) {
    const round = int32(woodRoundNum, 'WoodRoundNum'), maximum = int32(woodDailyMaxCount, 'WoodDailyMaxCount');
    this.WoodRoundNum = round === 0 ? 9999 : round;
    this.WoodDailyMaxCount = maximum === 0 || maximum >= 9999 ? 9999 : maximum;
  }
}

export function woodParameters(taskConfig = {}) {
  if (!taskConfig || typeof taskConfig !== 'object' || Array.isArray(taskConfig)) throw new TypeError('WoodTaskParam must be an object');
  return new WoodTaskParam(field(taskConfig, 'WoodRoundNum', 0), field(taskConfig, 'WoodDailyMaxCount', 2000));
}

export class AutoWoodConfig {
  constructor(config = {}) {
    this.AfterZSleepDelay = int32(field(config, 'AfterZSleepDelay', 0), 'AfterZSleepDelay');
    this.WoodCountOcrEnabled = boolean(field(config, 'WoodCountOcrEnabled', false), 'WoodCountOcrEnabled');
    this.UseWonderlandRefresh = boolean(field(config, 'UseWonderlandRefresh', true), 'UseWonderlandRefresh');
  }
}

export class WoodTaskError extends Error {
  constructor(code, message) { super(message); this.name = 'WoodTaskError'; this.code = code; }
}

export class WoodStatisticsPrinter {
  constructor(task) {
    this.task = task; this.ReachedWoodMaxCount = false; this.NothingCount = 0;
    this.WoodTotalDict = new Map(); this.firstWoodOcr = true; this.firstWoodOcrText = '';
    this.woodMetrics = new Map(); this.woodNotPrint = new Set();
  }
  woodStatisticsAlwaysEmpty() { return this.NothingCount >= 3; }
  hasDetectedWoodText(text) {
    return !!text && text.includes('获得') && (!this.firstWoodOcr || text.includes('×') || text.includes('x'));
  }
  static findBestOcrResult(candidates) {
    const ordered = [...candidates].sort((a, b) => b.length - a.length), maximumLength = ordered[0]?.length;
    for (const text of ordered) {
      if (text.length !== maximumLength) continue;
      if (matches(text).every(match => woods.has(match[1].trim()))) return text;
    }
    return '';
  }
  async woodTextAreaOcr() {
    return this.task.captured(async frame => {
      const scale = Math.min(frame.width / 1920, 1), x = Math.trunc(100 * scale), y = Math.trunc(450 * scale);
      const width = Math.min(Math.trunc(300 * scale), frame.width - x), height = Math.min(Math.trunc(250 * scale), frame.height - y);
      if (Math.min(width, height) <= 0) throw new WoodTaskError('emptyOcrRegion', '木材统计区域与截图没有交集');
      const regions = await this.task.vision('image.ocr', { handle: frame.handle, recognition: { roi: [x, y, width, height] } });
      this.task.ocrFrames++;
      return [...regions].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x + a.width / 2 - b.x - b.width / 2).map(region => region.text).join('\n');
    });
  }
  async getWoodStatisticsText() {
    const candidates = [], started = this.task.now();
    while (this.task.now() - started < 3500) {
      const text = await this.woodTextAreaOcr(), detected = this.hasDetectedWoodText(text);
      if (this.firstWoodOcr) {
        if (detected) candidates.push(text);
        if (candidates.length && !detected) break;
      } else if (detected) {
        this.NothingCount = 0;
        return this.firstWoodOcrText;
      }
      await this.task.sleep(this.firstWoodOcr ? 300 : 100);
    }
    this.firstWoodOcrText = WoodStatisticsPrinter.findBestOcrResult(candidates);
    return this.firstWoodOcrText;
  }
  async printWoodStatistics(taskParam = this.task.taskParam) {
    const text = await this.getWoodStatisticsText();
    if (!text) {
      this.NothingCount++; this.task.host.log?.('warn', '未能识别到伐木的统计数据');
      if (!this.woodMetrics.size) {
        this.task.disableWoodCountOcr();
        throw new WoodTaskError('firstOcrEmpty', '首次伐木就未识别到木材数据，已经自动关闭【OCR识别并累计木材数】的功能，请重新启动【自动伐木】功能！');
      }
      return;
    }
    this.parseWoodStatisticsText(taskParam, text);
    this.checkAndPrintWoodQuantities(taskParam);
  }
  parseWoodStatisticsText(taskParam, text) {
    // The original guard accepts uppercase X, while its regex and first detection accept lowercase x.
    if (!text.includes('×') && !text.includes('X')) { this.task.host.log?.('warn', '未能正确解析木材信息格式：' + text); return; }
    const found = matches(text);
    if (!this.firstWoodOcr && found.length >= 1 && found.length <= this.woodMetrics.size) {
      for (const [name, quantity] of this.woodMetrics) if (quantity <= taskParam.WoodDailyMaxCount) this.updateWoodCount(name, quantity);
    } else {
      for (const match of found) this.updateWoodCount(match[1].trim(), int32(match[2], 'wood quantity'));
      this.firstWoodOcr = false;
    }
  }
  updateWoodCount(name, quantity) {
    if (!woods.has(name)) { this.task.host.log?.('warn', '未知的木材名：' + name + '，数量' + quantity); return; }
    this.WoodTotalDict.set(name, ((this.WoodTotalDict.get(name) ?? 0) + quantity) | 0);
    if (this.firstWoodOcr && !this.woodMetrics.has(name)) this.woodMetrics.set(name, quantity);
  }
  checkAndPrintWoodQuantities(taskParam) {
    if (!this.WoodTotalDict.size) { this.ReachedWoodMaxCount = false; this.NothingCount++; return; }
    for (const [name, quantity] of this.WoodTotalDict) {
      if (this.woodNotPrint.has(name)) continue;
      this.task.host.log?.('info', '木材' + name + '累积数量估算：' + quantity);
      if (quantity >= taskParam.WoodDailyMaxCount) {
        this.task.host.log?.('info', '木材' + name + '估算数量已达到设置上限：' + taskParam.WoodDailyMaxCount);
        this.woodNotPrint.add(name);
      }
    }
    this.ReachedWoodMaxCount = Math.min(...this.WoodTotalDict.values()) >= taskParam.WoodDailyMaxCount;
  }
}

export class AutoWoodTask extends PathingActions {
  constructor(host, { config = {}, taskConfig = {}, login3rdParty = 'None', ...options } = {}) {
    super(host, { ...options, login3rdParty });
    this.woodConfig = field(config, 'AutoWoodConfig', field(config, 'AutoWood', config));
    if (!this.woodConfig || typeof this.woodConfig !== 'object' || Array.isArray(this.woodConfig)) throw new TypeError('AutoWoodConfig must be an object');
    new AutoWoodConfig(this.woodConfig);
    this.taskParam = woodParameters(taskConfig);
    this.gadgetKey = field(field(config, 'KeyBindingsConfig', {}), 'QuickUseGadget', 'VK_Z');
    webKeyCode(this.gadgetKey);
    if (!['None', 'Bilibili'].includes(login3rdParty)) throw new RangeError('login3rdParty must be None or Bilibili');
    this.cleanupHost = Object.create(host, { signal: { value: null, writable: true } });
    this.first = true; this.ocrFrames = 0; this.gadgetPresses = 0; this.printer = new WoodStatisticsPrinter(this);
  }
  get ocrEnabled() { return boolean(field(this.woodConfig, 'WoodCountOcrEnabled', false), 'WoodCountOcrEnabled'); }
  disableWoodCountOcr() {
    const key = Object.keys(this.woodConfig).find(key => key.toLowerCase() === 'woodcountocrenabled') ?? 'WoodCountOcrEnabled';
    this.woodConfig[key] = false;
    this.receipt?.configChanges.push({ field: 'AutoWoodConfig.WoodCountOcrEnabled', value: false, reason: 'firstOcrEmpty' });
  }
  async input(method, args = []) {
    this.checkAbort(); const result = await this.host.input(method, args); this.checkAbort(); return result;
  }
  async vision(op, args) {
    this.checkAbort(); const result = await this.host.vision(op, args); this.checkAbort(); return result;
  }
  async click(region) {
    if (!exists(region)) throw new WoodTaskError('emptyClick', 'Cannot click an empty BetterGI Region');
    return this.input('click', [(region.globalX ?? region.x) + region.width / 2, (region.globalY ?? region.y) + region.height / 2]);
  }
  async captured(body) {
    this.checkAbort();
    const frame = await this.cleanupHost.capture();
    let failure;
    try {
      this.checkAbort(); this.metrics = [frame.width, frame.height];
      const result = await body(frame); this.checkAbort(); return result;
    } catch (error) { failure = error; throw error; }
    finally {
      try { await this.cleanupHost.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failure) throw error; this.host.log?.('error', 'Wood capture disposal failed: ' + error.message); }
    }
  }
  async pressZ(round) {
    let attempts = 0, found = false;
    const limit = this.first ? 1 : 120;
    while (attempts < limit) {
      if (!this.first) { if (attempts) await this.sleep(1000); await this.sleep(1); }
      attempts++; if (round) round.gadgetAttempts = attempts;
      found = await this.captured(async frame => exists(await this.find(frame, 'AutoWood', 'TheBoonOfTheElderTree')));
      if (found) break;
    }
    if (!found) throw new WoodTaskError(this.first ? 'missingGadget' : 'gadgetRetryExhausted', this.first
      ? '请先装备小道具「王树瑞佑」！如果已经装备仍旧出现此提示，请重新仔细阅读文档中的《快速上手》！'
      : '未找到「王树瑞佑」：已用尽原版120次重试');
    this.checkAbort();
    await this.host.input('keyPress', [this.gadgetKey]); this.gadgetPresses++;
    if (round) round.gadgetPressed = true;
    this.checkAbort();
    if (!this.first) await this.sleep(500);
    this.first = false;
    await this.sleep(300);
    const delay = int32(field(this.woodConfig, 'AfterZSleepDelay', 0), 'AfterZSleepDelay');
    if (delay > 0) await this.sleep(delay);
    return attempts;
  }
  async felling(round, isLast) {
    await this.pressZ(round);
    if (isLast) { round.lastRoundSkippedOcrAndRefresh = true; return; }
    if (this.ocrEnabled) {
      await this.printer.printWoodStatistics(); round.ocrSampled = true;
      if (this.printer.woodStatisticsAlwaysEmpty() || this.printer.ReachedWoodMaxCount) return;
    }
    const wonderland = boolean(field(this.woodConfig, 'UseWonderlandRefresh', true), 'UseWonderlandRefresh');
    round.refresh = wonderland ? 'wonderland' : 'exitAndRelogin';
    const result = await (wonderland ? this.wonderland() : this.exitAndRelogin());
    if (result?.verified !== true) throw new WoodTaskError('refreshUnverified', '刷新流程没有确认返回游戏主界面');
    this.receipt.refreshes.push({ round: round.number, method: round.refresh, ...result });
    round.refreshVerified = true;
  }
  evidence() {
    return { ...this.receipt, woodCountEstimates: Object.fromEntries(this.printer.WoodTotalDict),
      gadgetPresses: this.gadgetPresses, ocrEnabled: this.ocrEnabled, ocrFrames: this.ocrFrames,
      emptyObservations: this.printer.NothingCount, elapsedMs: Math.max(0, this.now() - this.startedAt) };
  }
  async start() {
    this.printer = new WoodStatisticsPrinter(this); this.ocrFrames = 0; this.gadgetPresses = 0; this.startedAt = this.now();
    this.receipt = { completed: false, completion: null, verified: false, sourceCommit: BETTERGI_SOURCE_COMMIT,
      roundsRequested: this.taskParam.WoodRoundNum, roundsAttempted: 0, rounds: [], refreshes: [],
      countEvidence: 'sourceOcrEstimate', inventoryVerified: false, configChanges: [] };
    let failure;
    try {
      this.checkAbort();
      if (this.options.login3rdParty === 'Bilibili') throw new UnsupportedNativeOperation('login3rdParty.Bilibili');
      this.host.log?.('info', '自动伐木：' + this.taskParam.WoodRoundNum + '轮，木材估算数量上限' + this.taskParam.WoodDailyMaxCount);
      for (let index = 0; index < this.taskParam.WoodRoundNum; index++) {
        if (this.ocrEnabled) {
          if (this.printer.woodStatisticsAlwaysEmpty()) { this.receipt.completion = 'emptyWoodLimit'; break; }
          if (this.printer.ReachedWoodMaxCount) { this.receipt.completion = 'woodLimit'; break; }
        }
        this.checkAbort();
        const round = { number: index + 1, gadgetPressed: false, ocrSampled: false, refreshVerified: false, completed: false };
        this.receipt.rounds.push(round); this.receipt.roundsAttempted++;
        await this.felling(round, index + 1 === this.taskParam.WoodRoundNum);
        await this.sleep(500); round.completed = true;
      }
      this.checkAbort(); this.receipt.completed = true; this.receipt.completion ??= 'roundLimit';
      return this.evidence();
    } catch (error) {
      failure = error;
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = this.evidence();
      throw error;
    } finally {
      try { await this.cleanupHost.input('releaseAll', []); }
      catch (error) {
        if (!failure) {
          if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = { ...this.evidence(), completed: false, completion: null, cleanupFailed: true };
          throw error;
        }
        this.host.log?.('error', 'Wood input release failed: ' + error.message);
      }
    }
  }
}

export async function runAutoWood(host, options = {}) { return new AutoWoodTask(host, options).start(); }
