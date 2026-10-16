// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoCookTask/AutoCookConfig, c9db8b8291fe4ac25a600aee1582298005919eb2.
import { NativeTasks } from './native.mjs';

const exists = r => !!r && r.width > 0 && r.height > 0;
const field = (value, key, fallback) => { const name = Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : value[name]; };
const check = host => host.signal?.throwIfAborted();
const now = host => host.now ? host.now() : performance.now();
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }

export class CookingTask extends NativeTasks {
  constructor(host, options = {}) {
    super(host);
    const config = field(options, 'config', options);
    const settings = field(config, 'AutoCookConfig', field(config, 'AutoCook', config));
    const interval = field(settings, 'checkIntervalMs', 10);
    if (!Number.isInteger(interval)) throw new TypeError('AutoCook.CheckIntervalMs must be an integer');
    this.checkIntervalMs = Math.max(1, interval);
    this.stopWhenRecover = field(settings, 'stopTaskWhenRecoverButtonDetected', true);
    if (typeof this.stopWhenRecover !== 'boolean') throw new TypeError('AutoCook.StopTaskWhenRecoverButtonDetected must be boolean');
  }

  async countTargetColor(frame, roi) {
    const handles = [];
    try {
      check(this.host);
      const crop = await this.host.vision('image.crop', { handle: frame.handle, x: roi[0], y: roi[1], width: roi[2], height: roi[3] }); handles.push(crop); check(this.host);
      const rgb = await this.host.vision('image.mat', { handle: crop.handle, method: 'CvtColor', args: ['BGR2RGB'] }); handles.push(rgb); check(this.host);
      const mask = await this.host.vision('image.mat', { handle: rgb.handle, method: 'InRange', args: [[255, 192, 64], [255, 192, 64]] }); handles.push(mask); check(this.host);
      const count = await this.host.vision('image.mat', { handle: mask.handle, method: 'CountNonZero', args: [] }); check(this.host);
      if (!Number.isInteger(count) || count < 0) throw new TypeError('AutoCook.CountTargetColor must return a nonnegative integer');
      return count;
    } finally {
      for (const image of handles.reverse()) await this.host.vision('image.dispose', { handle: image.handle });
    }
  }

  async start() {
    if (this.running) throw new Error('AutoCook task is already running');
    this.running = true;
    const result = { completion: 'recoverButtonObserved', recoverButtonObserved: false, frames: 0, confirmations: 0, spacePresses: 0, verified: false };
    let failed, metrics, roi, peakMinCount, triggerDropCount;
    let lastUiCheck = -Infinity, inCookUi = false, peak = null, candidate = null, stableFrames = 0;
    const reset = () => { peak = candidate = null; stableFrames = 0; };
    try {
      check(this.host); this.host.log?.('info', '自动烹饪任务启动');
      while (true) {
        const stopped = await this.captured(async frame => {
          check(this.host); result.frames++;
          if (!metrics) {
            if (!(frame.width > 0 && frame.height > 0)) throw new RangeError('AutoCook requires positive capture dimensions');
            metrics = [frame.width, frame.height];
            const scale = Math.min(frame.width / 1920, frame.height / 1080, 1);
            roi = [600, 660, 730, 190].map(value => Math.trunc(value * scale));
            peakMinCount = Math.trunc(600 * scale); triggerDropCount = Math.trunc(300 * scale);
          } else if (frame.width !== metrics[0] || frame.height !== metrics[1]) throw new Error('AutoCook capture dimensions changed during the task');
          const time = now(this.host);
          if (!inCookUi || time - lastUiCheck >= 400) {
            const currentInCookUi = exists(await this.find(frame, 'Common/Element', 'UiLeftTopCookIcon'));
            check(this.host);
            if (currentInCookUi !== inCookUi) reset();
            inCookUi = currentInCookUi; lastUiCheck = time;
            if (!inCookUi) reset();
            else {
              if (this.stopWhenRecover) {
                const recover = await this.find(frame, 'Common/Element', 'BtnWhiteRecover'); check(this.host);
                if (exists(recover)) {
                  result.recoverButtonObserved = true;
                  this.host.log?.('info', '自动烹饪：检测到自动烹饪按钮，结束任务'); return true;
                }
              }
              const confirm = await this.find(frame, 'Common/Element', 'BtnWhiteConfirm'); check(this.host);
              if (exists(confirm)) {
                await sleep(this.host, 500); await this.click(confirm); check(this.host);
                result.confirmations++; reset(); this.host.log?.('info', '自动烹饪：自动点击确认');
              }
            }
          }
          if (!inCookUi) return false;
          const count = await this.countTargetColor(frame, roi);
          if (peak != null) {
            if (count <= peak - triggerDropCount) {
              check(this.host); await this.host.input('keyPress', ['SPACE']); check(this.host); result.spacePresses++;
              this.host.log?.('info', `自动烹饪：烹饪条像素数量较峰值下降超过${triggerDropCount}，按下空格。峰值:${peak} 当前:${count}`); reset();
            }
          } else if (count <= peakMinCount) { candidate = null; stableFrames = 0; }
          else if (candidate == null || Math.abs(count - candidate) > 20) { candidate = count; stableFrames = 1; }
          else {
            candidate = Math.max(candidate, count); stableFrames++;
            if (stableFrames >= 3 && candidate > peakMinCount) {
              peak = candidate; candidate = null; stableFrames = 0; this.host.log?.('info', `自动烹饪：识别到完美烹饪条峰值像素数:${peak}`);
            }
          }
          return false;
        });
        if (stopped) return result;
        await sleep(this.host, this.checkIntervalMs);
      }
    } catch (error) { failed = error; throw error; }
    finally {
      try { await this.host.input('releaseAll', []); } catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); }
      finally { this.running = false; }
    }
  }
}

export function runAutoCook(host, options) { return new CookingTask(host, options).start(); }
