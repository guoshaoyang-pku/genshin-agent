// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI CountInventoryItem, GridScroller and AutoArtifactSalvage inventory UI, c9db8b8.
import { NativeTasks } from './native.mjs';
import { GridScreenName, ItemIconRecognitionMode } from './task-params.mjs';

const descriptions = ['武器', '圣遗物', '养成道具', '食物', '材料', '小道具', '任务', '贵重道具', '摆设'];
const tabs = ['BagWeapon', 'BagArtifact', 'BagCharacterDevelopmentItem', 'BagFood', 'BagMaterial', 'BagGadget', 'BagQuest', 'BagPreciousItem', 'BagFurnishing'];
const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const exists = region => !!region && region.width > 0 && region.height > 0;
const cleanupHost = host => Object.create(host, { signal: { value: null, writable: true } });
const check = host => host.signal?.throwIfAborted();
async function input(host, method, args = []) { check(host); const result = await host.input(method, args); check(host); return result; }
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function vision(host, op, args) { check(host); const result = await host.vision(op, args); check(host); return result; }
const now = host => host.now?.() ?? performance.now();
async function disposeImages(host, handles, failure) {
  let cleanupError;
  const clean = cleanupHost(host);
  for (const handle of handles) {
    try { await clean.vision('image.dispose', { handle }); }
    catch (error) { cleanupError ??= error; host.log?.('error', `Inventory image cleanup failed: ${error.message}`); }
  }
  if (cleanupError && !failure) throw cleanupError;
}

export class InventoryTaskError extends Error {
  constructor(code, message) { super(message); this.name = 'InventoryTaskError'; this.code = code; }
}
function pageName(value) {
  const entry = Object.entries(GridScreenName).find(([name, index]) => value === index || typeof value === 'string' && name.toLowerCase() === value.toLowerCase());
  const name = entry?.[0] ?? Object.keys(GridScreenName)[descriptions.indexOf(value)];
  if (!name || GridScreenName[name] > 8) throw new RangeError(`背包不支持的界面：${value}`);
  return name;
}
function modeName(value) {
  const entry = Object.entries(ItemIconRecognitionMode).find(([name, index]) => value === index || typeof value === 'string' && name.toLowerCase() === value.toLowerCase());
  if (!entry) throw new RangeError(`不支持的物品图标识别模式：${value}`);
  return entry[0];
}
export function inventoryParameters(param, config = {}) {
  if (!param || typeof param !== 'object' || Array.isArray(param)) throw new TypeError('CountInventoryItemParam is required');
  const names = field(param, 'ItemNames', []);
  if (!Array.isArray(names) || !names.length) throw new TypeError('参数ItemNames不能为空');
  if (names.some(name => typeof name !== 'string' || !name.trim())) throw new TypeError('参数ItemNames不能包含空名称');
  const page = field(param, 'GridScreenName', null), stopByItemSort = field(param, 'StopByItemSort', false);
  if (typeof stopByItemSort !== 'boolean') throw new TypeError('StopByItemSort must be boolean');
  return { itemNames: [...new Set(names)], page: page == null ? null : pageName(page), stopByItemSort,
    mode: modeName(field(param, 'IconRecognitionMode', field(field(config, 'OtherConfig', {}), 'ItemIconRecognitionMode', 1))) };
}

export class InventoryTasks extends NativeTasks {
  constructor(host, config = {}) { super(host); this.config = config; }
  async captured(body) {
    check(this.host);
    const frame = await this.host.capture();
    let failure;
    try { check(this.host); return await body(frame); }
    catch (error) { failure = error; throw error; }
    finally { await disposeImages(this.host, [frame.handle], failure); }
  }
  async tab(frame, page, checked) { return this.find(frame, 'Common/Element', tabs[GridScreenName[page]] + (checked ? 'Checked' : 'Unchecked')); }
  async selected(page) { return this.captured(async frame => exists(await this.tab(frame, page, true))); }
  async waitSelected(page) {
    for (let attempt = 0; attempt < 5; attempt++) { await sleep(this.host, 500); if (await this.selected(page)) return; }
    throw new InventoryTaskError('tabUnverified', `未能确认背包分类已选中：${page}`);
  }
  async inventoryKey() {
    const bindings = field(this.config, 'KeyBindingsConfig', {});
    await input(this.host, 'keyPress', [field(bindings, 'OpenInventory', 'VK_B')]);
  }
  async openInventory(page) {
    await this.inventoryKey(); await sleep(this.host, 1200);
    let opened = false;
    for (let attempt = 0; attempt < 5 && !opened; attempt++) {
      await sleep(this.host, 1000);
      opened = await this.captured(async frame => {
        if (exists(await this.find(frame, 'Common/Element', 'PromptDialogLeftBottomStar'))) {
          const recognition = await this.recognition('Common/Element', 'BtnWhiteConfirm', frame);
          const button = await vision(this.host, 'image.find', { handle: frame.handle, recognition: { ...recognition, roi: [0, 0, frame.width, Math.round(frame.height * .8)] } });
          if (exists(button)) await this.click(button);
          await sleep(this.host, 300); return false;
        }
        if (exists(await this.tab(frame, page, true))) return true;
        const unchecked = await this.tab(frame, page, false);
        if (exists(unchecked)) { await this.click(unchecked); return true; }
        if (await this.isInMainUi(frame)) await this.inventoryKey();
        return false;
      });
    }
    if (!opened) throw new InventoryTaskError('inventoryNotOpened', `未找到背包分类按钮：${page}`);
    await sleep(this.host, 800);
    if (!await this.selected(page)) await this.waitSelected(page);
  }
  async switchInventoryTab(page) {
    if (await this.selected(page)) return;
    let clicked = false;
    for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
      clicked = await this.captured(async frame => { const tab = await this.tab(frame, page, false); if (!exists(tab)) return false; await this.click(tab); return true; });
      if (!clicked) await sleep(this.host, 300);
    }
    if (!clicked) throw new InventoryTaskError('tabNotFound', `未找到背包分类按钮：${page}`);
    await this.waitSelected(page); await sleep(this.host, 800);
  }
  async scroll(page, params) {
    const handles = []; let failure;
    try {
      check(this.host);
      const previous = await this.host.capture(); handles.push(previous.handle); check(this.host);
      for (let i = 0; i < params.s1Round; i++) { await input(this.host, 'verticalScroll', [-2]); await sleep(this.host, params.roundMilliseconds); }
      await sleep(this.host, 300);
      const next = await this.host.capture(); handles.push(next.handle); check(this.host);
      const result = await vision(this.host, 'inventory.scrolling', { previousHandle: previous.handle, nextHandle: next.handle, page });
      if (!result.isScrolling) { await sleep(this.host, 300); return false; }
      for (let i = 0; i < params.s2Round; i++) { await input(this.host, 'verticalScroll', [-2]); await sleep(this.host, params.roundMilliseconds); }
      const end = now(this.host) + 2000;
      while (now(this.host) < end) {
        await sleep(this.host, 60);
        const aligned = await this.captured(async frame => {
          const grid = await vision(this.host, 'inventory.grid', { handle: frame.handle, page, postProcess: false });
          if (!grid.rawRects.length) return null;
          return Math.min(...grid.rawRects.map(rect => rect.y - grid.roi.y)) <= frame.width * params.s3Scale;
        });
        if (aligned === true) break;
        if (aligned === false) await input(this.host, 'verticalScroll', [-1]);
      }
      await this.captured(async frame => {
        const grid = await vision(this.host, 'inventory.grid', { handle: frame.handle, page, postProcess: false });
        await input(this.host, 'moveMouseTo', [grid.roi.x + grid.roi.width, grid.roi.y + grid.roi.height]);
      });
      await sleep(this.host, 300); return true;
    } catch (error) { failure = error; throw error; }
    finally { await disposeImages(this.host, handles.reverse(), failure); }
  }
  async preScrollWeaponOre(params) {
    await this.captured(async frame => {
      const scale = Math.min(frame.width / 1920, frame.height / 1080);
      await input(this.host, 'moveMouseTo', [1289 * scale, 936 * scale]);
    });
    try { await input(this.host, 'leftButtonDown'); await sleep(this.host, 2000); }
    finally { await cleanupHost(this.host).input('leftButtonUp', []); }
    while (await this.scroll('Weapons', params)) await sleep(this.host, 300);
  }
  async scanPage(page, names, settings, metadata, detail) {
    const params = await this.captured(frame => vision(this.host, 'inventory.params', { page, width: frame.width, height: frame.height }));
    const pageResult = { page, frames: 0, recognizedItems: 0, stopReason: null, missing: [] };
    detail.pages.push(pageResult);
    if (page === 'Weapons' && names.some(name => name.startsWith('精锻用'))) await this.preScrollWeaponOre(params);
    let maxSort = null;
    if (settings.stopByItemSort) {
      const orders = names.map(name => metadata.get(name)?.sortOrder);
      if (orders.every(Number.isInteger)) maxSort = Math.max(...orders);
      else this.host.log?.('warning', `${page}目标存在缺失的sort_order，不启用排序提前停止`);
    }
    while (!pageResult.stopReason) {
      await this.captured(async frame => {
        const grid = await vision(this.host, 'inventory.grid', { handle: frame.handle, page });
        pageResult.frames++;
        if (!grid.cells.length) { pageResult.stopReason = 'noGrid'; return; }
        for (const cell of grid.cells) {
          const item = await vision(this.host, 'inventory.item', { handle: frame.handle, rect: cell.rect, mode: settings.mode });
          if (!item.name) continue;
          pageResult.recognizedItems++;
          const order = metadata.get(item.name)?.sortOrder;
          if (maxSort !== null && Number.isInteger(order) && order > maxSort) { pageResult.stopReason = 'sortOrder'; break; }
          if (names.includes(item.name) && !Object.hasOwn(detail.counts, item.name)) {
            const count = await vision(this.host, 'inventory.count', { handle: frame.handle, rect: cell.rect });
            if (!Number.isInteger(count.count) || count.count < -2 || count.count === -1 || count.count > 2147483647) throw new InventoryTaskError('invalidCountObservation', '数量识别未返回有效的源结果');
            Object.defineProperty(detail.counts, item.name, { value: count.count, enumerable: true, writable: true, configurable: true });
            detail.observations.push({ page, name: item.name, ...count, icon: { score: item.score, scoreKind: item.scoreKind, candidateName: item.candidateName }, rect: cell.rect, isPhantom: cell.isPhantom });
            if (names.every(name => Object.hasOwn(detail.counts, name))) { pageResult.stopReason = 'allTargetsObserved'; break; }
          }
        }
      });
      if (pageResult.stopReason) break;
      await this.captured(async frame => {
        const { roi } = await vision(this.host, 'inventory.params', { page, width: frame.width, height: frame.height });
        await input(this.host, 'moveMouseTo', [roi.x + Math.trunc(roi.width / 2), roi.y + Math.trunc(roi.height / 2)]);
      });
      await sleep(this.host, 300);
      if (!await this.scroll(page, params)) pageResult.stopReason = 'bottom';
    }
    pageResult.missing = names.filter(name => !Object.hasOwn(detail.counts, name));
  }
  async countInventoryItemDetailed(param) {
    let failed, mode;
    try {
      check(this.host);
      const settings = inventoryParameters(param, this.config); mode = settings.mode;
      const catalog = await vision(this.host, 'inventory.metadata', {});
      const metadata = new Map(catalog.entries.map(entry => [entry.name, entry]));
      const batches = new Map();
      for (const name of settings.itemNames) {
        const page = settings.page ?? metadata.get(name)?.page;
        if (!page) throw new InventoryTaskError('unresolvedPage', `以下目标物品无法解析所在的背包页面：${settings.itemNames.filter(n => !metadata.has(n)).join(', ')}`);
        pageName(page);
        if (!batches.has(page)) batches.set(page, []);
        batches.get(page).push(name);
      }
      await vision(this.host, 'inventory.modelStatus', { mode });
      const detail = { counts: {}, missing: [], observations: [], pages: [], verified: false, mainUiVerified: false };
      await this.returnMainUi();
      let first = true;
      for (const [page, names] of [...batches].sort(([a], [b]) => GridScreenName[a] - GridScreenName[b])) {
        if (first) { await this.openInventory(page); first = false; }
        else await this.switchInventoryTab(page);
        await this.scanPage(page, names, settings, metadata, detail);
      }
      await this.returnMainUi(); detail.mainUiVerified = true;
      detail.missing = settings.itemNames.filter(name => !Object.hasOwn(detail.counts, name));
      detail.verified = !detail.missing.length && Object.values(detail.counts).every(count => count >= 0);
      check(this.host); return detail;
    } catch (error) { failed = error; throw error; }
    finally {
      const clean = cleanupHost(this.host), errors = [];
      try { await clean.input('releaseAll', []); } catch (error) { errors.push(error); }
      if (mode) { try { await clean.vision('inventory.release', { mode }); } catch (error) { errors.push(error); } }
      if (errors.length) { if (!failed) throw errors[0]; for (const error of errors) this.host.log?.('error', `Inventory cleanup failed: ${error.message}`); }
    }
  }
  async countInventoryItem(param) { return (await this.countInventoryItemDetailed(param)).counts; }
}
