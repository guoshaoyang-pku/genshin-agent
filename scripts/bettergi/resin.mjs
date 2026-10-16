// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoDomain/Model/ResinStatus, ResinUseRecord and AutoDomainTask resin helpers.
import path from 'node:path';
import { DailyTasks, localized } from './daily.mjs';

const exists = region => region?.width > 0 && region?.height > 0;
const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const cleanHost = host => Object.create(host, { signal: { value: null } });
const recordFields = [['浓缩树脂', 'CondensedResinUseCount'], ['原粹树脂40', 'OriginalResin40UseCount'], ['原粹树脂20', 'OriginalResin20UseCount'], ['原粹树脂', 'OriginalResinUseCount'], ['须臾树脂', 'TransientResinUseCount'], ['脆弱树脂', 'FragileResinUseCount']];
const positiveInt = text => { const digits = String(text).replace(/\D/g, ''), value = Number(digits); return digits && Number.isInteger(value) && value <= 2147483647 ? value : 0; };

export function buildResinRecords(param, { stygian = false } = {}) {
  if (!field(param, 'SpecifyResinUse', false)) return [];
  const records = recordFields.filter(([name]) => !stygian || !['原粹树脂20', '原粹树脂40'].includes(name)).flatMap(([Name, key]) => {
    const count = field(param, key, 0);
    if (!Number.isInteger(count)) throw new TypeError(key + ' must be an integer');
    return count > 0 ? [{ Name, RemainCount: count, MaxCount: count }] : [];
  });
  if (!records.length) throw new Error('你选择了指定树脂刷取次数，请至少配置一种树脂的刷取次数！');
  return records;
}

export class ResinTasks extends DailyTasks {
  async captured(body) {
    this.host.signal?.throwIfAborted();
    const cleanup = cleanHost(this.host), frame = await cleanup.capture();
    let failed = false;
    try {
      this.host.signal?.throwIfAborted(); this.metrics = [frame.width, frame.height];
      const result = await body(frame); this.host.signal?.throwIfAborted(); return result;
    }
    catch (error) { failed = true; throw error; }
    finally {
      try { await cleanup.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', String(error)); }
    }
  }
  async patterns(keys) { return localized(this.host, 'AutoDomainTask', keys, 'AutoDomain'); }
  async prompt(frame) { return this.ocr(frame, [frame.width * .25, frame.height * .2, frame.width * .5, frame.height * .6].map(Math.trunc)); }
  async count(frame, rect, threshold = false) {
    const cleanup = cleanHost(this.host), handles = []; let failed = false;
    try {
      this.host.signal?.throwIfAborted();
      let image = await cleanup.vision('image.crop', { handle: frame.handle, ...rect }); handles.push(image.handle);
      this.host.signal?.throwIfAborted();
      if (threshold) {
        const transforms = [['cvtcolor', ['BGR2GRAY']]];
        if (threshold !== 'gray') transforms.push(['threshold', [180, 255, 'Binary']], ['bitwisenot', []]);
        for (const [method, args] of transforms) {
          image = await cleanup.vision('image.mat', { handle: image.handle, method, args }); handles.push(image.handle);
          this.host.signal?.throwIfAborted();
        }
      }
      const result = await this.host.vision('image.ocrWithoutDetector', { handle: image.handle });
      this.host.signal?.throwIfAborted(); return result.text;
    } catch (error) { failed = true; throw error; }
    finally {
      let cleanupFailure, cleanupFailed = false;
      for (const handle of handles.reverse()) try { await cleanup.vision('image.dispose', { handle }); }
      catch (error) { if (!cleanupFailed) { cleanupFailure = error; cleanupFailed = true; } }
      if (cleanupFailed && !failed) throw cleanupFailure;
      if (cleanupFailed) this.host.log?.('error', String(cleanupFailure));
    }
  }
  async status(frame) {
    if (!frame) return this.captured(capture => this.status(capture));
    const s = Math.min(frame.width / 1920, frame.height / 1080, 1), px = value => Math.trunc(value * s);
    const crop = { x: px(1300), y: px(25), width: px(160), height: px(50) };
    const icon = async (name, rect) => this.host.vision('image.find', { handle: frame.handle, recognition: { type: 'TemplateMatch', threshold: .8,
      template_path: path.join(this.host.sourceRoot, 'BetterGenshinImpact/GameTask/AutoFight/Assets/1920x1080', name + '_resin_top_icon.png'), template_scale: s, roi: [rect.x, rect.y, rect.width, rect.height] } });
    const original = await icon('original', crop);
    if (!exists(original)) throw new Error('未找到原粹树脂图标');
    const originalText = await this.count(frame, { x: original.x + original.width + px(25), y: px(37), width: px(110), height: px(24) });
    const match = originalText.match(/(\d+)\s*[/17]\s*(2|20|200)/);
    const condensedCrop = { x: original.x - px(180), y: px(25), width: px(90), height: px(50) };
    const condensed = await icon('condensed', condensedCrop);
    const condensedText = exists(condensed) ? await this.count(frame, { x: condensed.x + condensed.width + px(20), y: condensed.y, width: px(30), height: condensed.height }, true) : '';
    return { OriginalResinCount: match ? positiveInt(match[1]) : 0, CondensedResinCount: positiveInt(condensedText), originalText, condensedText, evidence: 'sourceOcrEstimate' };
  }
  async pressUseResin(regions, name, width = this.metrics?.[0] ?? 1920) {
    if (['原粹树脂20', '原粹树脂40'].includes(name)) name = '原粹树脂';
    if (!['原粹树脂', '浓缩树脂', '脆弱树脂', '须臾树脂'].includes(name)) throw new TypeError('未知的树脂名称');
    const [resinPattern, usePattern] = await this.patterns([name, '使用']);
    const resin = regions.find(region => resinPattern.test(region.text));
    const button = resin && regions.find(region => usePattern.test(region.text) && region.x > width / 2 && region.y <= resin.y + resin.height && region.y + region.height >= resin.y);
    if (!button) return { used: false, num: 0 };
    await this.click(button); await this.host.sleep(60); this.host.signal?.throwIfAborted(); await this.click(button);
    const num = name === '原粹树脂' ? resin.text.includes('20') ? 20 : resin.text.includes('40') ? 40 : 20 : 1;
    return { used: true, name, num, evidence: 'useButtonClicked', inventoryVerified: false };
  }
  async switchOriginalResinType(expectedNum) {
    if (![20, 40].includes(expectedNum)) throw new TypeError('Expected 20 or 40 original resin');
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await this.captured(async frame => {
        if ((await this.prompt(frame)).some(region => region.text.includes(String(expectedNum)))) return true;
        const button = await this.find(frame, 'AutoDomain', 'ResinSwitchBtn');
        if (exists(button)) await this.click(button);
        if (exists(await this.find(frame, 'AutoDomain', 'ResinSwitchBtnNoActive'))) return false;
        return null;
      });
      if (result !== null) return result;
      await this.host.sleep(500); this.host.signal?.throwIfAborted();
    }
    throw Object.assign(new Error('未检测到按钮'), { name: 'RetryException', code: 'RESIN_SWITCH_RETRY' });
  }
}
