// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI RewardResultRecognizer / RewardItem, c9db8b8291fe4ac25a600aee1582298005919eb2.
import path from 'node:path';

const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const check = host => host.signal?.throwIfAborted();
const set = (object, name, value) => Object.defineProperty(object, name, { value, writable: true, configurable: true, enumerable: true });

function int32(value, name) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError(name + ' must be an Int32');
  return value;
}
function modeName(value) {
  if (value === 0 || typeof value === 'string' && value.toLowerCase() === 'gridicon') return 'GridIcon';
  if (value === 1 || typeof value === 'string' && value.toLowerCase() === 'item') return 'Item';
  throw new RangeError('Unsupported ItemIconRecognitionMode: ' + value);
}

export class RewardItem {
  constructor(name, qualityLevel, quantity, positionIndex = -1) {
    this.Name = arguments.length ? name : '';
    this.QualityLevel = arguments.length ? int32(qualityLevel, 'QualityLevel') : -1;
    this.Quantity = arguments.length ? int32(quantity, 'Quantity') : 0;
    this.PositionIndex = arguments.length ? int32(positionIndex, 'PositionIndex') : 0;
  }
  toString() { return `${this.Name ?? ''} x${this.Quantity}`; }
  ToString() { return this.toString(); }
}

export function toRewardItems(rewards) {
  return rewards.filter(reward => reward.name !== null && reward.name !== undefined && reward.name !== '')
    .map((reward, index) => new RewardItem(reward.name, reward.qualityLevel ?? -1, reward.count >= 0 ? reward.count : 1, index));
}
export function detectRewardDuplicates(current, previous) {
  let duplicates = 0;
  const tail = previous.slice(Math.max(0, previous.length - 10));
  for (let i = 0; i < current.length && i < previous.length; i++) {
    const item = current[i];
    if (!tail.some(prior => prior.Name === item.Name && prior.QualityLevel === item.QualityLevel && prior.Quantity === item.Quantity)) break;
    duplicates++;
  }
  return duplicates;
}
export function createRewardSummary(items) {
  const summary = {};
  for (const item of items) {
    if (typeof item.Name !== 'string') throw new TypeError('Reward name must be a string');
    const quantity = (Object.hasOwn(summary, item.Name) ? summary[item.Name] : 0) + int32(item.Quantity, 'Quantity');
    set(summary, item.Name, int32(quantity, 'Reward quantity sum'));
  }
  return summary;
}
export function mergeRewardSummary(summary, recognizedSummary) {
  for (const [name, value] of Object.entries(recognizedSummary)) {
    const quantity = int32(value, 'recognized quantity'), exists = Object.hasOwn(summary, name);
    if (quantity >= 0) set(summary, name, exists && summary[name] >= 0 ? (int32(summary[name], 'summary quantity') + quantity) | 0 : quantity);
    else if (!exists) set(summary, name, -1);
  }
  return summary;
}

export class RewardResultRecognizer {
  constructor(host, { config = {} } = {}) {
    this.host = host; this.config = config;
    this.cleanupHost = Object.create(host, { signal: { value: null, writable: true } });
  }
  static mergeIntoSummary(summary, recognizedSummary) { return mergeRewardSummary(summary, recognizedSummary); }
  static MergeIntoSummary(summary, recognizedSummary) { return mergeRewardSummary(summary, recognizedSummary); }
  async input(method, args = []) { check(this.host); const result = await this.host.input(method, args); check(this.host); return result; }
  async sleep(ms) { check(this.host); await this.host.sleep(ms); check(this.host); }
  async captured(body) {
    await this.input('moveMouseTo', [960, 720]);
    await this.sleep(100); check(this.host);
    const frame = await this.cleanupHost.capture();
    let failed = false;
    try { check(this.host); const result = await body(frame); check(this.host); return result; }
    catch (error) { failed = true; throw error; }
    finally {
      try { await this.cleanupHost.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', 'Reward screenshot disposal failed: ' + error?.message); }
    }
  }
  async dragToNextPage() {
    await this.input('moveMouseTo', [1650, 540]); await this.sleep(100);
    let failed = false;
    try {
      await this.input('leftButtonDown', []); await this.sleep(100);
      for (let step = 0; step <= 20; step++) {
        await this.input('moveMouseTo', [1650 + (250 - 1650) * step / 20, 540]); await this.sleep(30);
      }
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.cleanupHost.input('leftButtonUp', []); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', 'Reward drag release failed: ' + error?.message); }
    }
    check(this.host); await this.sleep(1200);
  }
  RecognizeMultiPage(maxPages = 3) { return this.recognizeMultiPage(maxPages); }
  async recognizeMultiPage(maxPages = 3) {
    int32(maxPages, 'maxPages');
    const receipt = { summary: {}, items: [], pages: [], supportedResolution: false, stopReason: null, model: null,
      evidence: { kind: 'model-and-ocr-estimate', verifiedRewards: false, sourceCommit: 'c9db8b8291fe4ac25a600aee1582298005919eb2', completed: false } };
    let session, failed = false;
    try {
      receipt.resolution = await this.captured(frame => ({ width: frame.width, height: frame.height }));
      receipt.supportedResolution = receipt.resolution.width === 1920 && receipt.resolution.height === 1080;
      if (!receipt.supportedResolution) {
        receipt.stopReason = 'unsupportedResolution';
        this.host.log?.('warn', `奖励识别：当前分辨率 ${receipt.resolution.width}x${receipt.resolution.height} 暂不支持。`);
        receipt.evidence.completed = true; return receipt;
      }
      const mode = modeName(field(field(this.config, 'OtherConfig', {}), 'ItemIconRecognitionMode', 1));
      check(this.host);
      const created = await this.cleanupHost.vision('reward.create', { mode });
      session = created.session; receipt.model = created.model; check(this.host);
      let previous = [];
      const common = field(this.config, 'CommonConfig', {});
      const debugEnabled = field(common, 'ScreenshotEnabled', false) && field(common, 'RewardRecognitionScreenshotEnabled', false);
      receipt.stopReason = 'maxPages';
      for (let page = 1; page <= maxPages; page++) {
        if (page > 1) await this.dragToNextPage();
        const observed = await this.captured(async frame => {
          const args = { handle: frame.handle, session };
          if (debugEnabled) args.debugPath = path.join(this.host.runDir ?? path.resolve('data/bettergi'), 'RewardRecognition', `rewardRecDebug${page}.png`);
          check(this.host); const result = await this.host.vision('reward.page', args); check(this.host); return result;
        });
        const current = toRewardItems(observed.rewards), duplicateCount = previous.length ? detectRewardDuplicates(current, previous) : 0;
        const newItems = duplicateCount ? current.slice(duplicateCount) : current;
        receipt.pages.push({ page, ...observed, items: current, duplicateCount, newItems });
        for (const warning of observed.warnings ?? []) this.host.log?.('warn', warning.message);
        if (!observed.rewards.length) {
          receipt.stopReason = 'noRecognizedRewards';
          this.host.log?.('warn', '奖励识别：没有识别到奖励，已结束本次识别。'); break;
        }
        receipt.items.push(...newItems);
        if (duplicateCount) { receipt.stopReason = 'duplicatePrefix'; break; }
        previous = current;
      }
      receipt.summary = createRewardSummary(receipt.items);
      receipt.evidence.completed = true;
      this.host.log?.('info', `奖励识别：本次共识别到 ${receipt.items.length} 个奖励。`);
      return receipt;
    } catch (error) {
      failed = true; receipt.evidence.completed = false;
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = receipt;
      throw error;
    } finally {
      const failures = [];
      if (session !== undefined) {
        try { await this.cleanupHost.vision('reward.release', { session }); } catch (error) { failures.push(error); }
      }
      try { await this.cleanupHost.input('releaseAll', []); } catch (error) { failures.push(error); }
      if (failures.length) {
        receipt.evidence.completed = false; receipt.evidence.cleanupFailed = true;
        for (const error of failures) this.host.log?.('error', 'Reward cleanup failed: ' + error?.message);
        if (!failed) { const error = failures[0]; if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = receipt; throw error; }
      }
    }
  }
}
