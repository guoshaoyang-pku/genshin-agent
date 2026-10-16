// SPDX-License-Identifier: GPL-3.0-only
// BetterGI Common/Job/ChooseFOptionTask at c9db8b8291fe4ac25a600aee1582298005919eb2.
import { pickKeyRecognition } from './realtime.mjs';

const field = (value, name, fallback) => { const key = Object.keys(value ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : value[key]; };
const exists = region => region?.width > 0 && region?.height > 0;
const cleanHost = host => Object.create(host, { signal: { value: null } });
const clamp = (value, max) => Math.max(0, Math.min(value, max));
let selectionTail = Promise.resolve();

async function acquireSelection(signal) {
  const previous = selectionTail;
  let release, onAbort;
  const turn = new Promise(resolve => { release = resolve; });
  selectionTail = previous.then(() => turn);
  try {
    signal?.throwIfAborted();
    if (signal) await Promise.race([previous, new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); })]);
    else await previous;
    signal?.throwIfAborted();
    return release;
  } catch (error) { release(); throw error; }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

export const normalizeFOptionText = text => String(text ?? '').replace(/\s/gu, '').replace(/[【\[]/g, '「').replace(/[】\]]/g, '」');

export function fOptionCandidateRect(frame, pick, leftOffset = 115, rightOffset = 400) {
  const scale = Math.min(frame.width / 1920, 1), textLeft = pick.x + Math.trunc(leftOffset * scale);
  const left = clamp(textLeft, frame.width), right = clamp(textLeft + Math.trunc((rightOffset - leftOffset) * scale), frame.width);
  const top = clamp(pick.y - Math.trunc(500 * scale), frame.height), bottom = clamp(frame.height - Math.trunc(220 * scale), frame.height);
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

export function mergeFOptionRows(regions) {
  const rows = [];
  for (const item of regions.filter(region => exists(region) && normalizeFOptionText(region.text)).toSorted((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(group => group.some(other => Math.min(other.y + other.height, item.y + item.height) - Math.max(other.y, item.y) > Math.min(other.height, item.height) / 2));
    if (row) row.push(item); else rows.push([item]);
  }
  return rows.map(row => {
    const x = Math.min(...row.map(region => region.x)), y = Math.min(...row.map(region => region.y));
    return { x, y, width: Math.max(...row.map(region => region.x + region.width)) - x, height: Math.max(...row.map(region => region.y + region.height)) - y, text: normalizeFOptionText(row.toSorted((a, b) => a.x - b.x).map(region => region.text).join('')) };
  }).sort((a, b) => a.y - b.y);
}

export function fOptionScrollClicks(candidates, pick, expected) {
  const target = candidates.flatMap((row, i) => normalizeFOptionText(row.text) === normalizeFOptionText(expected) ? [i] : []);
  const current = candidates.flatMap((row, i) => row.y < pick.y + pick.height && row.y + row.height > pick.y ? [i] : []);
  return target.length === 1 && current.length === 1 ? current[0] - target[0] : null;
}

export async function findPickInteraction(host, frame, key = 'F') {
  const assets = await pickKeyRecognition(host, frame, key);
  return { region: await host.vision('image.find', { handle: frame.handle, recognition: assets.recognition }), key: assets.key };
}

export class ChooseFOptionTask {
  constructor(host, { config = host.config ?? {}, dpi = host.dpi ?? 1 } = {}) {
    this.host = host; this.config = field(config, 'AutoPickConfig', config); this.dpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 1;
  }
  async sleep(ms) { this.host.signal?.throwIfAborted(); await this.host.sleep(ms); this.host.signal?.throwIfAborted(); }
  async input(method, args) { this.host.signal?.throwIfAborted(); return this.host.input(method, args); }
  async captured(body) {
    this.host.signal?.throwIfAborted(); const clean = cleanHost(this.host), frame = await clean.capture(); let failed = false;
    try { this.host.signal?.throwIfAborted(); const result = await body(frame); this.host.signal?.throwIfAborted(); return result; }
    catch (error) { failed = true; throw error; }
    finally { try { await clean.vision('image.dispose', { handle: frame.handle }); } catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); } }
  }
  async current(frame, pick) {
    const scale = Math.min(frame.width / 1920, 1), left = field(this.config, 'ItemTextLeftOffset', 115), right = field(this.config, 'ItemTextRightOffset', 400);
    const roi = { x: pick.x + Math.trunc(left * scale), y: pick.y, width: Math.trunc((right - left) * scale), height: pick.height };
    if (roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || roi.x + roi.width > frame.width || roi.y + roi.height > frame.height) return '';
    const result = await this.host.vision('realtime.pickText', { handle: frame.handle, roi, ocrEngine: 'Paddle' });
    return result.alreadyPicking ? '' : normalizeFOptionText(result.text);
  }
  async press(key) {
    await this.sleep(60); let failed = false;
    try { await this.input('keyDown', [key]); await this.sleep(60); }
    catch (error) { failed = true; throw error; }
    finally { try { await cleanHost(this.host).input('keyUp', [key]); } catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); } }
    await this.sleep(60); return true;
  }
  async singleSelectText(option) {
    if (typeof option !== 'string') throw new TypeError('F选项文本必须是字符串');
    const expected = normalizeFOptionText(option); if (!expected) throw new TypeError('F选项文本不能为空');
    const release = await acquireSelection(this.host.signal); let lease;
    try {
      lease = this.host.pauseAutoPick?.(); await this.sleep(100); let clicks;
      for (let retry = 0; retry <= 5; retry++) {
        const result = await this.captured(async frame => {
          const { region: pick, key } = await findPickInteraction(this.host, frame, field(this.config, 'PickKey', 'F'));
          if (!exists(pick)) return { finished: true, selected: false };
          if (await this.current(frame, pick) === expected) return { finished: true, selected: await this.press(key) };
          const roi = fOptionCandidateRect(frame, pick, field(this.config, 'ItemTextLeftOffset', 115), field(this.config, 'ItemTextRightOffset', 400));
          const rows = roi[2] > 0 && roi[3] > 0 ? await this.host.vision('image.ocr', { handle: frame.handle, recognition: { type: 'Ocr', roi } }) : [];
          return { clicks: fOptionScrollClicks(mergeFOptionRows(rows), pick, expected) };
        });
        if (result.finished) return result.selected;
        if (result.clicks !== null && result.clicks !== 0) { clicks = result.clicks; break; }
        if (retry === 5) return false;
        await this.sleep(60); await this.input('moveMouseBy', [Math.max(1, Math.round(400 * this.dpi)), 0]); await this.sleep(60); await this.sleep(200);
      }
      for (let i = 0; i < Math.abs(clicks); i++) { await this.sleep(60); await this.input('verticalScroll', [Math.sign(clicks)]); await this.sleep(60); }
      await this.sleep(200);
      return await this.captured(async frame => {
        const { region: pick, key } = await findPickInteraction(this.host, frame, field(this.config, 'PickKey', 'F'));
        return exists(pick) && await this.current(frame, pick) === expected ? this.press(key) : false;
      });
    } finally { try { lease?.dispose(); } finally { release(); } }
  }
}
