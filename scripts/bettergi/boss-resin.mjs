// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoBossTask original-resin recovery and supplemental-resin workflow.
import { ResinTasks } from './resin.mjs';
import { NavigationTasks } from './navigation.mjs';

const exists = region => region?.width > 0 && region?.height > 0;
const check = host => host.signal?.throwIfAborted();
const cleanHost = host => Object.create(host, { signal: { value: null, writable: true } });
const now = host => host.now?.() ?? performance.now();
const fullWidth = text => String(text ?? '').replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
export const normalizeBossResinText = text => fullWidth(text).replace(/[：﹕]/g, ':').replace(/\s+/g, '');
const sortedText = rows => [...rows].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x + a.width / 2 - b.x - b.width / 2).map(row => row.text).join('');
const roundEven = value => { const n = Math.floor(value); return value - n === .5 ? n % 2 ? n + 1 : n : Math.round(value); };

export function parseBossResinRecovery(limitText, detailText) {
  const digits = fullWidth(limitText).replace(/\D/g, ''), limit = Number(digits.slice(-3));
  if (digits.length < 3 || limit <= 0) throw new Error('原粹树脂上限解析失败：' + limitText);
  const text = normalizeBossResinText(detailText);
  let recoverySeconds = 0;
  if (!text.includes('原粹树脂已完全恢复')) {
    const time = text.match(/全部恢复(\d{1,3}:\d{2}:\d{2})/)?.[1] ?? [...text.matchAll(/\d{1,3}:\d{2}:\d{2}/g)].at(-1)?.[0];
    if (!time) throw new Error('未识别到全部恢复时间：' + text);
    const [hours, minutes, seconds] = time.split(':').map(Number);
    if (minutes > 59 || seconds > 59) throw new Error('树脂恢复时间格式无效：' + time);
    recoverySeconds = hours * 3600 + minutes * 60 + seconds;
  }
  const missing = Math.ceil(recoverySeconds / 480);
  if (missing > limit) throw new Error('计算缺失树脂超过树脂上限');
  return { Count: limit - missing, Limit: limit, recoverySeconds, limitText, detailText, evidence: 'sourceRecoveryTimeOcrEstimate' };
}
export const supplementalTargetQuantity = resin => Math.max(0, Math.trunc((resin.Limit - resin.Count) / 60));
export function parseBossQuickUseAvailable(text) {
  const values = [...normalizeBossResinText(text).matchAll(/\d+/g)].map(match => Number(match[0])).filter(value => value <= 2147483647);
  return Math.min(20, Math.max(0, ...values));
}
export function parseBossQuickUseQuantity(text) {
  text = normalizeBossResinText(text);
  if (!text.includes('使用数量')) return null;
  const match = text.match(/使用数量\D*(\d+)/) ?? text.match(/\d+/), value = Number(match?.[1] ?? match?.[0]);
  return match && value <= 2147483647 ? value : null;
}

export class BossResinTasks extends ResinTasks {
  constructor(host, param = {}) { super(host); this.param = param; this.resinEvidence = []; }
  async captured(body) {
    check(this.host);
    const cleanup = cleanHost(this.host), frame = await cleanup.capture();
    let failed = false;
    try { check(this.host); this.metrics = [frame.width, frame.height]; return await body(frame); }
    catch (error) { failed = true; throw error; }
    finally {
      try { await cleanup.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', String(error?.message ?? error)); }
    }
  }
  async count(frame, rect, threshold = false) {
    try { return await super.count(frame, rect, threshold); }
    catch (error) { check(this.host); throw error; }
  }
  async sleep(ms) { check(this.host); await this.host.sleep(ms); check(this.host); }
  async input(method, args = []) { check(this.host); await this.host.input(method, args); check(this.host); }
  scaleRect(frame, rect) { const scale = Math.min(frame.width / 1920, frame.height / 1080, 1); return rect.map(value => roundEven(value * scale)); }
  async textAt(text, rect) {
    return this.captured(async frame => (await this.ocr(frame, this.scaleRect(frame, rect))).find(row => row.text.includes(text)) ?? null);
  }
  async bossIcon(name, rect) {
    return this.captured(async frame => {
      const recognition = await this.recognition('AutoBoss', name, frame);
      if (rect) recognition.roi = this.scaleRect(frame, rect);
      const region = await this.host.vision('image.find', { handle: frame.handle, recognition });
      return exists(region) ? region : null;
    });
  }
  async poll(observe, timeout, interval = 300, retry) {
    const deadline = now(this.host) + timeout;
    while (true) {
      check(this.host);
      const value = await observe(); check(this.host);
      if (value) return value;
      if (now(this.host) >= deadline) return null;
      await retry?.();
      await this.sleep(Math.min(interval, Math.max(0, deadline - now(this.host))));
    }
  }
  async clickText(text, rect, timeout) {
    const region = await this.poll(() => this.textAt(text, rect), timeout);
    if (!region) return false;
    await this.click(region); return true;
  }
  async sortedOcr(rect) { return this.captured(async frame => sortedText(await this.ocr(frame, this.scaleRect(frame, rect)))); }
  async countAt(rect) {
    return this.captured(frame => { const [x, y, width, height] = this.scaleRect(frame, rect); return this.count(frame, { x, y, width, height }); });
  }
  async originalResinInfo() {
    const navigation = new NavigationTasks(this.host);
    navigation.captured = body => this.captured(body);
    await navigation.openMap();
    const roi = [1200, 25, 580, 50];
    const icon = await this.poll(() => this.bossIcon('OriginalResinTopIcon', roi), 5000);
    if (!exists(icon)) throw new Error('未找到原粹树脂图标');
    await this.click(icon);
    if (!await this.poll(() => this.captured(async frame => (await this.ocr(frame, this.scaleRect(frame, [1180, 75, 620, 200]))).some(row => row.text.includes('全部恢复') || row.text.includes('原粹树脂已完全恢复'))), 5000, 300,
      async () => { const current = await this.bossIcon('OriginalResinTopIcon', roi); if (exists(current)) await this.click(current); })) throw new Error('未观察到原粹树脂恢复详情');
    const current = await this.bossIcon('OriginalResinTopIcon', roi);
    if (!exists(current)) throw new Error('树脂详情打开后未找到原粹树脂图标');
    const result = await this.captured(async frame => {
      const s = value => this.scaleRect(frame, [value])[0];
      const limitText = await this.count(frame, { x: current.x + current.width + s(25), y: s(37), width: s(120), height: s(24) });
      const detailText = sortedText(await this.ocr(frame, [current.x - 13, current.y + current.height + 29, 220, 150]));
      return parseBossResinRecovery(limitText, detailText);
    });
    this.resinEvidence.push(result); return result;
  }
  async ensureResinBeforeRound() {
    let failed = false;
    try {
      await this.returnMainUi();
      let resin;
      try { resin = await this.originalResinInfo(); }
      catch (error) {
        check(this.host); this.host.log?.('warn', '战前树脂预检失败，继续通过领奖界面确认：' + error.message);
        this.resinEvidence.push({ evidence: 'precheckFailed', error: error.message }); return true;
      }
      if (resin.Count >= 40) return true;
      if (!this.param.SpecifyRunCount || !this.param.UseTransientResin && !this.param.UseFragileResin) return false;
      return await this.supplementResin(resin);
    } catch (error) { failed = true; throw error; }
    finally {
      if (!this.host.signal?.aborted) {
        try { await this.returnMainUi(); } catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); }
      }
    }
  }
  supplementalOptions() {
    return [this.param.UseTransientResin && { name: '须臾树脂', icon: 'TransientResinInSupplementPane' },
      this.param.UseFragileResin && { name: '脆弱树脂', icon: 'FragileResinInSupplementPane' }].filter(Boolean);
  }
  async supplementResin(resin) {
    const unavailable = new Set();
    while (resin.Count < 40) {
      const target = supplementalTargetQuantity(resin);
      if (!target || !await this.openSupplementPane()) return false;
      let used = false;
      for (const option of this.supplementalOptions()) {
        if (unavailable.has(option.name)) continue;
        if (!await this.selectSupplement(option)) { unavailable.add(option.name); continue; }
        const quantity = await this.useSelectedSupplement(target);
        if (quantity <= 0) return false;
        this.resinEvidence.push({ name: option.name, quantity, evidence: 'supplementObtainDialogObserved', inventoryVerified: false });
        used = true; await this.sleep(800);
        try { resin = await this.originalResinInfo(); }
        catch (error) { check(this.host); this.host.log?.('warn', '补充后树脂识别失败：' + error.message); return false; }
        if (resin.Count >= 40) return true;
        break;
      }
      if (!used) return false;
    }
    return true;
  }
  async openSupplementPane() {
    const title = () => this.textAt('补充原粹树脂', [834, 247, 256, 60]);
    if (await this.poll(title, 500)) return true;
    return !!await this.poll(title, 5000, 300, async () => {
      const button = await this.bossIcon('OpenResinSupplementPaneButton', [1200, 25, 580, 50]);
      if (exists(button)) await this.click(button);
    });
  }
  async selectSupplement(option) {
    const icon = () => this.bossIcon(option.icon, [644, 378, 620, 192]);
    const found = await this.poll(icon, 1500);
    if (!exists(found)) return false;
    await this.click(found);
    return !!await this.poll(() => this.textAt(option.name, [906, 587, 110, 31]), 3000, 300, async () => {
      const current = await icon(); if (exists(current)) await this.click(current);
    });
  }
  async useSelectedSupplement(target) {
    if (target <= 0 || !await this.clickText('使用', [1163, 761, 61, 38], 3000)) return 0;
    await this.sleep(500);
    if (!await this.poll(() => this.textAt('快捷使用', [875, 269, 184, 63]), 1500)) return await this.closeObtainDialog() ? 1 : 0;
    const available = parseBossQuickUseAvailable(await this.countAt([1191, 633, 72, 29])), quickTarget = Math.min(target, available, 20);
    if (quickTarget <= 0) return 0;
    const actual = await this.adjustQuickQuantity(quickTarget);
    if (actual <= 0 || actual > quickTarget || !await this.clickText('使用', [1152, 740, 64, 35], 3000)) return 0;
    return await this.closeObtainDialog() ? actual : 0;
  }
  async adjustQuickQuantity(target) {
    let actual = 0, last = -1, unchanged = 0;
    for (let attempt = 0; attempt < Math.max(6, target * 3); attempt++) {
      const quantity = parseBossQuickUseQuantity(await this.sortedOcr([915, 540, 93, 81]));
      if (quantity !== null) {
        actual = quantity;
        if (actual >= target) return actual;
        unchanged = actual === last ? unchanged + 1 : 0; last = actual;
        if (unchanged >= 3) return actual;
        const increase = await this.bossIcon('IncreaseResinUsageQuantityButton', [1265, 620, 59, 55]);
        if (!exists(increase)) return actual;
        await this.click(increase);
      }
      await this.sleep(500);
    }
    return actual;
  }
  async closeObtainDialog() {
    if (!await this.clickText('获得', [924, 279, 74, 38], 5000)) return false;
    await this.sleep(800); return true;
  }
}
