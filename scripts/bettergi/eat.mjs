// SPDX-License-Identifier: GPL-3.0-only
// BetterGI AutoEat/AutoEatTask.cs and Dispatcher foodEffectType selection.
import { InventoryTasks } from './inventory.mjs';
import { ResinTasks } from './resin.mjs';

const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const cleanHost = host => Object.create(host, { signal: { value: null } });
const check = host => host.signal?.throwIfAborted();
const exists = region => region?.width > 0 && region?.height > 0;
const fullWidth = text => String(text).replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

export function eatParameters(config = {}, taskConfig = {}, partyConfig) {
  const global = field(config, 'AutoEatConfig', {});
  let foodName = field(taskConfig, 'FoodName', null);
  const effect = field(taskConfig, 'FoodEffectType', null);
  if (foodName !== null && effect !== null) throw new Error('不能同时指定foodName和foodEffectType');
  if (effect !== null) {
    if (!partyConfig) throw new Error('foodEffectType参数需要调度器配置，请在调度器下使用');
    const key = ({ 1: 'DefaultAtkBoostingDishName', 2: 'DefaultAdventurersDishName', 3: 'DefaultDefBoostingDishName', ATKBoostingDish: 'DefaultAtkBoostingDishName', AdventurersDish: 'DefaultAdventurersDishName', DEFBoostingDish: 'DefaultDefBoostingDishName' })[effect];
    if (!key) throw new Error('JS脚本入参错误：错误的foodEffectType');
    foodName = field(field(partyConfig, 'AutoEatConfig', {}), key, null);
    if (!foodName) return { skipped: 'missingConfiguredFood', FoodName: null };
  }
  if (foodName !== null && typeof foodName !== 'string') throw new TypeError('FoodName must be a string');
  const result = { FoodName: foodName, CheckInterval: field(global, 'CheckInterval', 150), EatInterval: field(global, 'EatInterval', 1000) };
  for (const key of ['CheckInterval', 'EatInterval']) if (!Number.isFinite(result[key]) || result[key] < 0 || key === 'CheckInterval' && result[key] === 0) throw new RangeError('Invalid AutoEatConfig.' + key);
  return result;
}

export class AutoEatTask extends InventoryTasks {
  constructor(host, { config = {}, taskConfig = {}, partyConfig } = {}) {
    super(host, config); this.param = eatParameters(config, taskConfig, partyConfig);
  }
  captured(body) { return ResinTasks.prototype.captured.call(this, body); }
  async sleep(ms) { check(this.host); await this.host.sleep(ms); check(this.host); }
  async input(method, args) { check(this.host); await this.host.input(method, args); check(this.host); }
  async takeFoodEquipped() {
    try {
      const text = await this.captured(frame => {
        const s = Math.min(frame.width / 1920, frame.height / 1080, 1);
        return ResinTasks.prototype.count.call(this, frame, { x: Math.trunc(1800 * s), y: Math.trunc(845 * s), width: Math.trunc(40 * s), height: Math.trunc(20 * s) }, 'gray');
      });
      return /^[+-]?[0-9]+$/.test(text.trim()) && Number(text) >= -2147483648 && Number(text) <= 2147483647;
    } catch (error) { check(this.host); this.host.log?.('debug', '检测便携营养袋时发生异常：' + String(error)); return false; }
  }
  async loop() {
    if (!await this.takeFoodEquipped()) return null;
    let lastEatAt = -Infinity;
    const key = field(field(this.config, 'KeyBindingsConfig', {}), 'QuickUseGadget', 'VK_Z');
    while (true) {
      check(this.host);
      try {
        const lowHp = await this.captured(frame => this.host.vision('party.lowHp', { handle: frame.handle }));
        const time = this.host.now?.() ?? performance.now();
        if (lowHp && time - lastEatAt >= this.param.EatInterval) { await this.input('keyPress', [key]); lastEatAt = time; }
        await this.sleep(this.param.CheckInterval);
      } catch (error) {
        check(this.host); this.host.log?.('debug', '自动吃药检测异常：' + String(error)); await this.sleep(1000);
      }
    }
  }
  async namedFood() {
    const mode = field(field(this.config, 'OtherConfig', {}), 'ItemIconRecognitionMode', 1);
    let failed = false;
    try {
      await this.returnMainUi(); await this.openInventory('Food');
      await this.host.vision('inventory.modelStatus', { mode });
      const params = await this.captured(frame => this.host.vision('inventory.params', { page: 'Food', width: frame.width, height: frame.height }));
      while (true) {
        const found = await this.captured(async frame => {
          const grid = await this.host.vision('inventory.grid', { handle: frame.handle, page: 'Food' });
          for (const cell of grid.cells) {
            const item = await this.host.vision('inventory.item', { handle: frame.handle, rect: cell.rect, mode }); check(this.host);
            if (item.name !== this.param.FoodName) continue;
            await this.click(cell.rect);
            const observation = await this.host.vision('inventory.itemText', { handle: frame.handle, rect: cell.rect }); check(this.host);
            const text = fullWidth(observation.text).trim(), count = Number(text);
            const remaining = /^[+-]?[0-9]+$/.test(text) && count >= -2147483648 && count <= 2147483647 ? (count - 1) | 0 : -2;
            await this.sleep(300);
            const confirmObserved = await this.captured(async current => {
              const button = await this.find(current, 'Common/Element', 'BtnWhiteConfirm');
              if (!exists(button)) return false; await this.click(button); return true;
            });
            return { count: remaining, confirmObserved };
          }
          return null;
        });
        if (found) { this.lastObservation = { ...found, name: this.param.FoodName, inventoryVerified: false }; await this.returnMainUi(); return found.count; }
        await this.captured(async frame => {
          const { roi } = await this.host.vision('inventory.params', { page: 'Food', width: frame.width, height: frame.height });
          await this.input('moveMouseTo', [roi.x + Math.trunc(roi.width / 2), roi.y + Math.trunc(roi.height / 2)]);
        });
        await this.sleep(300);
        if (!await this.scroll('Food', params)) { await this.returnMainUi(); return -1; }
      }
    } catch (error) { failed = true; throw error; }
    finally { try { await cleanHost(this.host).vision('inventory.release', { mode }); } catch (error) { if (!failed) throw error; this.host.log?.('error', String(error)); } }
  }
  async start() {
    let failed = false;
    try {
      check(this.host); if (this.param.skipped) return null;
      return this.param.FoodName?.trim() ? await this.namedFood() : await this.loop();
    } catch (error) { failed = true; throw error; }
    finally { try { await cleanHost(this.host).input('releaseAll', []); } catch (error) { if (!failed) throw error; this.host.log?.('error', String(error)); } }
  }
}

export const runAutoEat = (host, options) => new AutoEatTask(host, options).start();
