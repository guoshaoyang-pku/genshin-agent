// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoArtifactSalvageTask / ArtifactSetFilterScreen, c9db8b8.
import { InventoryTasks } from './inventory.mjs';
import { ArtifactStatus, DEFAULT_SALVAGE_JAVASCRIPT, RecognitionFailurePolicy, isMatchJavaScript } from './salvage-filter.mjs';
export * from './salvage-filter.mjs';

const SOURCE_COMMIT = 'c9db8b8291fe4ac25a600aee1582298005919eb2';
const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const exists = region => !!region && region.width > 0 && region.height > 0;
const check = host => host.signal?.throwIfAborted();
const now = host => host.now?.() ?? performance.now();
function int32(value, label) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new TypeError(label + ' must be an Int32');
  return value;
}
function policy(value) {
  if (value == null) return value;
  if (Number.isInteger(value)) return value;
  const key = Object.keys(RecognitionFailurePolicy).find(key => key.toLowerCase() === String(value).toLowerCase());
  if (key === undefined) throw new TypeError('Invalid RecognitionFailurePolicy: ' + value);
  return RecognitionFailurePolicy[key];
}
export function salvageParameters(param = {}, config = {}) {
  if (!param || typeof param !== 'object' || Array.isArray(param)) throw new TypeError('AutoArtifactSalvageTaskParam must be an object');
  const defaults = field(config, 'AutoArtifactSalvageConfig', {});
  const star = int32(field(param, 'Star', Number(field(defaults, 'MaxArtifactStar', '4'))), 'Star');
  if (star < 1 || star > 4) throw new RangeError('Star must be in the original quick-salvage range 1..4');
  const javaScript = field(param, 'JavaScript', field(defaults, 'JavaScript', DEFAULT_SALVAGE_JAVASCRIPT));
  const artifactSetFilter = field(param, 'ArtifactSetFilter', field(defaults, 'ArtifactSetFilter', ''));
  const maxNumToCheck = field(param, 'MaxNumToCheck', field(defaults, 'MaxNumToCheck', 100));
  if (javaScript !== null && typeof javaScript !== 'string') throw new TypeError('JavaScript must be string or null');
  if (artifactSetFilter !== null && typeof artifactSetFilter !== 'string') throw new TypeError('ArtifactSetFilter must be string or null');
  if (maxNumToCheck !== null) int32(maxNumToCheck, 'MaxNumToCheck');
  return { star, javaScript, artifactSetFilter, maxNumToCheck,
    recognitionFailurePolicy: policy(field(param, 'RecognitionFailurePolicy', field(defaults, 'RecognitionFailurePolicy', 0))),
    culture: field(param, 'Culture', field(param, 'GameCultureInfo', null)) ?? field(field(config, 'OtherConfig', {}), 'GameCultureInfoName', 'zh-Hans'),
    mode: field(field(config, 'OtherConfig', {}), 'ItemIconRecognitionMode', 1) };
}

export class SalvageTasks extends InventoryTasks {
  constructor(host, config = {}) {
    super(host, config);
    this.cleanupHost = Object.create(host, { signal: { value: null, writable: true } });
  }
  async input(method, args = []) { check(this.host); const value = await this.host.input(method, args); check(this.host); return value; }
  async sleep(ms) { check(this.host); await this.host.sleep(ms); check(this.host); }
  async vision(op, args) { check(this.host); const result = await this.host.vision(op, args); check(this.host); return result; }
  async click(region) { check(this.host); await super.click(region); check(this.host); }
  async captured(body) {
    check(this.host);
    // The allocation must return its handle even if cancellation arrives in flight.
    const frame = await this.cleanupHost.capture();
    let failed = false;
    try { check(this.host); const result = await body(frame); check(this.host); return result; }
    catch (error) { failed = true; throw error; }
    finally {
      try { await this.cleanupHost.vision('image.dispose', { handle: frame.handle }); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', 'Salvage image disposal failed: ' + error?.message); }
    }
  }
  async button(frame, name) {
    check(this.host); const button = await this.find(frame, 'Common/Element', name); check(this.host);
    if (!exists(button)) return null;
    await this.click(button); return button;
  }
  async ocr(frame, roi) { return this.vision('image.ocr', { handle: frame.handle, recognition: { roi } }); }
  async grid(frame, sets, postProcess = true) {
    return this.vision(sets ? 'salvage.setGrid' : 'inventory.grid', { handle: frame.handle, page: 'ArtifactSalvage', postProcess });
  }
  async params(sets) {
    return this.captured(frame => this.vision(sets ? 'salvage.setParams' : 'inventory.params', { page: 'ArtifactSalvage', width: frame.width, height: frame.height }));
  }
  async scrollGrid(params, sets) {
    return this.captured(async previous => {
      for (let i = 0; i < params.s1Round; i++) { await this.input('verticalScroll', [-2]); await this.sleep(params.roundMilliseconds); }
      await this.sleep(300);
      const result = await this.captured(next => this.vision('inventory.scrolling', {
        previousHandle: previous.handle, nextHandle: next.handle, page: 'ArtifactSalvage', roi: params.roi,
      }));
      if (!result.isScrolling) { await this.sleep(300); return false; }
      for (let i = 0; i < params.s2Round; i++) { await this.input('verticalScroll', [-2]); await this.sleep(params.roundMilliseconds); }
      const end = now(this.host) + 2000;
      while (now(this.host) < end) {
        await this.sleep(60);
        const aligned = await this.captured(async frame => {
          const grid = await this.grid(frame, sets, sets);
          const rects = sets ? grid.cells.map(cell => cell.rect) : grid.rawRects;
          return rects.length ? Math.min(...rects.map(rect => rect.y - grid.roi.y)) <= frame.width * params.s3Scale : null;
        });
        if (aligned === true) break;
        if (aligned === false) await this.input('verticalScroll', [-1]);
      }
      await this.captured(async frame => {
        const grid = await this.grid(frame, sets, false);
        await this.input('moveMouseTo', [grid.roi.x + grid.roi.width, grid.roi.y + grid.roi.height]);
      });
      await this.sleep(300); return true;
    });
  }
  async nextPage(params, sets) {
    await this.captured(async () => {
      const roi = params.roi;
      await this.input('moveMouseTo', [roi.x + Math.trunc(roi.width / 2), roi.y + Math.trunc(roi.height / 2)]);
    });
    await this.sleep(300); return this.scrollGrid(params, sets);
  }
  async quickSelect(settings, localized, receipt) {
    if (!await this.captured(frame => this.button(frame, 'BtnArtifactSalvage'))) { receipt.stopReason = 'salvageButtonMissing'; return null; }
    await this.sleep(1000);
    const quick = await this.captured(async frame => {
      const texts = await this.ocr(frame, [0, Math.trunc(frame.height * .9), Math.trunc(frame.width * .25), Math.trunc(frame.height * .1)]);
      const found = texts.find(text => new RegExp(localized.strings['快速选择']).test(text.text));
      if (!found) return false;
      await this.click(found); await this.sleep(500); return true;
    });
    if (!quick) { receipt.stopReason = 'quickSelectMissing'; return null; }
    return this.captured(async frame => {
      if (settings.star < 4) {
        const texts = await this.ocr(frame, [0, 0, Math.trunc(frame.width * .20), frame.height]);
        for (let star = settings.star + 1; star <= 4; star++) {
          const found = texts.find(text => new RegExp(localized.strings[`${star}星圣遗物`]).test(text.text));
          if (!found) { receipt.stopReason = 'starOptionMissing'; receipt.missingStar = star; return null; }
          await this.click(found); receipt.quickSalvage.deselectedStars.push(star); await this.sleep(500);
        }
      }
      const confirm = await this.find(frame, 'Common/Element', 'BtnWhiteConfirm');
      if (exists(confirm)) await this.click(confirm);
      await this.sleep(1500); return { confirm };
    });
  }
  async quickSalvage(settings, receipt) {
    const submitted = await this.captured(frame => this.button(frame, 'BtnArtifactSalvageConfirm'));
    receipt.quickSalvage.submitButtonObserved = !!submitted;
    if (!submitted) return;
    await this.sleep(1000);
    const confirm = await this.captured(frame => this.button(frame, 'BtnBlackConfirm'));
    receipt.quickSalvage.confirmationClicked = !!confirm;
    if (!confirm) return;
    await this.sleep(400);
    if (settings.javaScript !== null) { await this.input('leftButtonClick'); await this.sleep(1000); }
  }
  async filterSets(settings, filterButton, receipt) {
    await this.click(filterButton); await this.sleep(400);
    await this.input('click', [315, 190]);
    await this.sleep(1000);
    let session, failed = false;
    try {
      check(this.host); const created = await this.cleanupHost.vision('salvage.setCreate', { mode: settings.mode });
      session = created.session; receipt.setFilter.model = created.model; check(this.host);
      const params = await this.params(true);
      for (;;) {
        const count = await this.captured(async frame => {
          const grid = await this.grid(frame, true); receipt.setFilter.pages++;
          for (const cell of grid.cells) {
            const item = await this.vision('salvage.setIcon', { handle: frame.handle, rect: cell.rect, session });
            const selected = item.name != null && settings.artifactSetFilter.includes(item.name);
            receipt.setFilter.items.push({ ...item, selected, isPhantom: cell.isPhantom });
            if (selected) { await this.click(cell.rect); await this.sleep(100); }
          }
          return grid.cells.length;
        });
        if (!count || !await this.nextPage(params, true)) break;
      }
    } catch (error) { failed = true; throw error; }
    finally {
      if (session !== undefined) {
        try { await this.cleanupHost.vision('salvage.setRelease', { session }); }
        catch (error) { if (!failed) throw error; this.host.log?.('error', 'Salvage set recognizer cleanup failed: ' + error?.message); }
      }
    }
    receipt.setFilter.filterConfirmObserved = !!await this.captured(frame => this.button(frame, 'BtnWhiteConfirm'));
    await this.sleep(1500);
    receipt.setFilter.confirmObserved = !!await this.captured(frame => this.button(frame, 'BtnWhiteConfirm'));
    await this.sleep(600);
  }
  async salvage5Star(settings, receipt) {
    if (settings.javaScript == null || settings.maxNumToCheck == null || settings.recognitionFailurePolicy == null) throw new TypeError('JavaScript, MaxNumToCheck and RecognitionFailurePolicy cannot be null for five-star selection');
    const params = await this.params(false);
    let remaining = settings.maxNumToCheck, stop = false;
    for (;;) {
      const count = await this.captured(async frame => {
        const grid = await this.grid(frame, false); receipt.fiveStar.pages++;
        for (const cell of grid.cells) {
          const initial = await this.vision('salvage.status', { handle: frame.handle, rect: cell.rect });
          const observation = { rect: cell.rect, initialStatus: initial.statusName, selected: false };
          receipt.fiveStar.items.push(observation);
          if (initial.status !== ArtifactStatus.None) continue;
          await this.click(cell.rect); await this.sleep(300);
          const skipped = await this.captured(async selectedFrame => {
            const current = await this.vision('salvage.status', { handle: selectedFrame.handle, rect: cell.rect });
            observation.afterClickStatus = current.statusName;
            if (current.status !== ArtifactStatus.Selected) return false;
            observation.selected = true;
            let artifact;
            try { artifact = await this.vision('salvage.artifact', { handle: selectedFrame.handle, culture: settings.culture }); }
            catch (error) {
              check(this.host); observation.recognitionError = error?.message ?? String(error);
              if (settings.recognitionFailurePolicy !== RecognitionFailurePolicy.Skip) throw error;
              await this.click(cell.rect); await this.sleep(100); observation.selected = false; receipt.fiveStar.recognitionSkipped++; return true;
            }
            Object.assign(observation, artifact);
            const matches = await isMatchJavaScript(artifact.artifact, settings.javaScript, { signal: this.host.signal, log: this.host.log?.bind(this.host) });
            observation.selected = matches;
            if (!matches) { await this.click(cell.rect); await this.sleep(100); }
            else receipt.fiveStar.selected++;
            return false;
          });
          if (skipped) continue;
          remaining--; receipt.fiveStar.checked++;
          if (remaining <= 0) { receipt.fiveStar.stopReason = 'checkLimit'; stop = true; break; }
        }
        return grid.cells.length;
      });
      if (stop) break;
      if (!count) { receipt.fiveStar.stopReason = 'noGrid'; break; }
      if (!await this.nextPage(params, false)) { receipt.fiveStar.stopReason = 'bottom'; break; }
    }
    receipt.manualReviewRequired = true;
  }
  AutoArtifactSalvage(param) { return this.autoArtifactSalvage(param); }
  async autoArtifactSalvage(param = {}) {
    const receipt = { sourceCommit: SOURCE_COMMIT, completed: false, stopReason: null, manualReviewRequired: false,
      quickSalvage: { deselectedStars: [], submitButtonObserved: false, confirmationClicked: false, verifiedDecomposedCount: null },
      setFilter: { pages: 0, items: [], model: null }, fiveStar: { pages: 0, items: [], checked: 0, selected: 0, recognitionSkipped: 0, stopReason: null } };
    let failed = false;
    try {
      check(this.host); const settings = salvageParameters(param, this.config);
      const localized = await this.vision('salvage.metadata', { culture: settings.culture });
      receipt.star = settings.star;
      await this.returnMainUi(); await this.openInventory('Artifacts');
      const selection = await this.quickSelect(settings, localized, receipt);
      if (!selection) return receipt;
      await this.quickSalvage(settings, receipt);
      if (settings.javaScript !== null) {
        if (settings.artifactSetFilter?.trim()) await this.filterSets(settings, selection.confirm, receipt);
        await this.salvage5Star(settings, receipt); receipt.stopReason = 'manualReview';
      } else {
        await this.input('keyPress', ['VK_ESCAPE']); await this.returnMainUi(); receipt.mainUiVerified = true; receipt.stopReason = 'quickSalvageFinished';
      }
      check(this.host); receipt.completed = true; return receipt;
    } catch (error) {
      failed = true;
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = receipt;
      throw error;
    } finally {
      try { await this.cleanupHost.input('releaseAll', []); }
      catch (error) {
        receipt.completed = false; receipt.cleanupFailed = true;
        if (!failed) { if (error && typeof error === 'object' && Object.isExtensible(error)) error.evidence = receipt; throw error; }
        this.host.log?.('error', 'Salvage input cleanup failed: ' + error?.message);
      }
    }
  }
}
