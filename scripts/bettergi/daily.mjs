import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeTasks } from './native.mjs';

// BetterGI Common/Job tasks, c9db8b8291fe4ac25a600aee1582298005919eb2 (GPL-3.0).
export const TalkOptionRes = Object.freeze({ NotFound: 0, FoundButNotOrange: 1, FoundAndClick: 2 });
export class DailyTaskError extends Error {
  constructor(task, code, message) { super(message); this.name = 'DailyTaskError'; this.task = task; this.code = code; }
}
const exists = region => !!region && region.width > 0 && region.height > 0;
function checkAbort(host) { host.signal?.throwIfAborted(); }
async function sleep(host, ms) { checkAbort(host); await host.sleep(ms); checkAbort(host); }
async function input(host, method, args = []) { checkAbort(host); return host.input(method, args); }
async function released(host, body) {
  let failed;
  try { checkAbort(host); const result = await body(); checkAbort(host); return result; } catch (error) { failed = error; throw error; }
  finally {
    try { await host.input('releaseAll', []); } catch (error) {
      if (!failed) throw error;
      host.log?.('error', `Remote input release failed: ${error.message}`);
    }
  }
}
function integer(value, name, min, max) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim()))) throw new TypeError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return parsed;
}
function xmlText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => entity[0] === '#'
    ? String.fromCodePoint(Number.parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10)) : entities[entity.toLowerCase()]);
}
export async function localized(host, task, keys, folder = 'Common/Job') {
  const locale = new Intl.Locale(host.gameCultureInfoName ?? 'zh-Hans');
  const cultures = [locale.baseName];
  if (locale.script || locale.language === 'zh') cultures.push(`${locale.language}-${locale.script ?? locale.maximize().script}`);
  cultures.push(locale.language);
  const values = new Map();
  for (const culture of new Set(cultures)) {
    let xml;
    try { xml = await readFile(path.join(host.sourceRoot, 'BetterGenshinImpact/GameTask', folder, `${task}.${culture}.resx`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    xml = xml.replace(/<!--[\s\S]*?-->/g, '');
    for (const [, key, value] of xml.matchAll(/<data\b[^>]*\bname="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) {
      const decodedKey = xmlText(key);
      if (!values.has(decodedKey)) values.set(decodedKey, xmlText(value));
    }
  }
  return keys.map(key => new RegExp(values.get(key) ?? key));
}

export class DailyTasks extends NativeTasks {
  async captured(body) {
    return super.captured(frame => { this.metrics = [frame.width, frame.height]; return body(frame); });
  }
  async fixed(method, x, y) {
    if (!this.metrics) await this.captured(() => {});
    const scale = Math.min(this.metrics[0] / 1920, this.metrics[1] / 1080);
    return input(this.host, method, [x * scale, y * scale]);
  }
  async leftHeld(body) {
    await input(this.host, 'leftButtonDown');
    try { return await body(); } finally { await this.host.input('leftButtonUp', []); }
  }
  async ocr(frame, roi) { return this.host.vision('image.ocr', { handle: frame.handle, recognition: { roi } }); }
  async pageObserved(frame) {
    return exists(await this.find(frame, 'Common/Element', 'PageCloseWhite')) && !await this.isInMainUi(frame);
  }
  fail(task, code, message) { throw new DailyTaskError(task, code, message); }

  async setTime(hour, minute = 0, skipAnimation = false) {
    return released(this.host, async () => {
      hour = integer(hour, 'hour', 0, 24) % 24; minute = integer(minute, 'minute', 0, 59);
      if (typeof skipAnimation !== 'boolean') throw new TypeError('skipAnimation must be boolean');
      await this.returnMainUi();
      await input(this.host, 'keyPress', ['VK_ESCAPE']); await sleep(this.host, 800);
      await this.fixed('click', 50, 700); await sleep(this.host, 900);
      if (!await this.captured(frame => this.pageObserved(frame))) this.fail('setTime', 'missingTimeUi', 'Time page was not observed after the source menu click');
      const end = (hour + 6) * 60 + minute - 20;
      const position = (radius, index) => [1441 + radius * Math.cos(index * Math.PI / 720), 501.6 + radius * Math.sin(index * Math.PI / 720)];
      for (let i = -2; i <= 0; i++) {
        await this.fixed('moveMouseTo', ...position(30, end + i * 1440 / 3)); await sleep(this.host, 50);
        await this.leftHeld(() => sleep(this.host, 50)); await sleep(this.host, 50);
      }
      await this.fixed('moveMouseTo', ...position(150, end + 5)); await sleep(this.host, 50);
      await this.leftHeld(async () => {
        await sleep(this.host, 50); await this.fixed('moveMouseTo', ...position(300, end + 20.5)); await sleep(this.host, 50);
      });
      await sleep(this.host, 50); await sleep(this.host, 100);
      await this.fixed('moveMouseTo', 1500, 1000); await sleep(this.host, 300);
      await input(this.host, 'leftButtonClick'); await sleep(this.host, 7);
      if (skipAnimation) {
        await sleep(this.host, 10); await this.fixed('moveMouseTo', 200, 200);
        await this.leftHeld(() => sleep(this.host, 10)); await sleep(this.host, 1010);
        await this.fixed('click', 45, 715); await sleep(this.host, 100);
        await this.fixed('click', 45, 715); await sleep(this.host, 200);
        try { await this.returnMainUi(); } catch (error) {
          checkAbort(this.host);
          if (!error.message.includes('ReturnMainUiTask exhausted')) throw error;
        }
        if (await this.isInMainUi()) return { hour, minute, verified: true, completion: 'mainUiAfterSkip', mainUiVerified: true, timeValueVerified: false };
      }
      await sleep(this.host, 3000);
      for (let attempt = 1; attempt <= 25; attempt++) {
        await sleep(this.host, 1000);
        if (await this.captured(async frame => exists(await this.find(frame, 'Common/Element', 'PageCloseWhite')))) {
          await this.returnMainUi();
          return { hour, minute, verified: true, completion: 'pageClose', mainUiVerified: true, timeValueVerified: false, attempts: attempt };
        }
      }
      this.fail('setTime', 'completionTimeout', 'SetTimeTask did not observe PageCloseWhite within its original 25 attempts');
    });
  }

  async talkOptions(frame) {
    const icons = await this.find(frame, 'AutoSkip', 'OptionIcon', true);
    if (!icons.length) return null;
    const lowest = [...icons].sort((a, b) => b.y - a.y)[0], scale = Math.min(frame.width / 1920, 1);
    const roi = [Math.trunc(lowest.x + lowest.width + 8 * scale), Math.trunc(frame.height / 8), Math.trunc(535 * scale), Math.trunc(lowest.y + lowest.height + 30 * scale - frame.height / 12)];
    return (await this.ocr(frame, roi)).sort((a, b) => a.y - b.y);
  }
  async orangeOption(frame, region) {
    const handles = [];
    try {
      const crop = await this.host.vision('image.crop', { handle: frame.handle, x: region.x, y: region.y, width: region.width, height: region.height });
      handles.push(crop.handle);
      const hsv = await this.host.vision('image.mat', { handle: crop.handle, method: 'CvtColor', args: ['BGR2HSV'] }); handles.push(hsv.handle);
      const mask = await this.host.vision('image.mat', { handle: hsv.handle, method: 'InRange', args: [[10, 150, 150], [25, 255, 255]] }); handles.push(mask.handle);
      const pixels = await this.host.vision('image.mat', { handle: mask.handle, method: 'CountNonZero', args: [] });
      return pixels / (mask.width * mask.height) > 0.1;
    } finally { for (const handle of handles.reverse()) await this.host.vision('image.dispose', { handle }); }
  }
  async chooseTalkOption(text, skipTimes = 10, isOrange = false) {
    return released(this.host, async () => {
      if (typeof text !== 'string' || typeof isOrange !== 'boolean') throw new TypeError('Talk text must be a string and isOrange must be boolean');
      skipTimes = integer(skipTimes, 'skipTimes', 0, 2147483647);
      let talkUi = false;
      for (let attempt = 0; attempt < 10 && !talkUi; attempt++) {
        await sleep(this.host, 500);
        talkUi = await this.captured(async frame => exists(await this.find(frame, 'AutoSkip', 'DisabledUiButton')));
      }
      const missing = code => ({ result: TalkOptionRes.NotFound, status: 'NotFound', found: false, clicked: false, verified: false, code });
      if (!talkUi) return missing('missingTalkUi');
      await sleep(this.host, 500);
      let first = true;
      for (let attempt = 0; attempt < skipTimes; attempt++) {
        const outcome = await this.captured(async frame => {
          const options = await this.talkOptions(frame);
          if (options === null) return 'skip';
          if (first) { first = false; return 'wait'; }
          const target = options.find(region => region.text.includes(text));
          if (!target) return 'miss';
          if (isOrange && !await this.orangeOption(frame, target)) return { result: TalkOptionRes.FoundButNotOrange, status: 'FoundButNotOrange', found: true, clicked: false, verified: true, text: target.text };
          await this.click(target);
          return { result: TalkOptionRes.FoundAndClick, status: 'FoundAndClick', found: true, clicked: true, text: target.text };
        });
        if (outcome === 'skip') { await input(this.host, 'keyPress', ['VK_SPACE']); await sleep(this.host, 500); }
        else if (outcome === 'wait') await sleep(this.host, 1000);
        else if (typeof outcome === 'object') {
          if (!outcome.clicked) return outcome;
          await sleep(this.host, 300);
          const completion = await this.captured(async frame => {
            if (!exists(await this.find(frame, 'AutoSkip', 'DisabledUiButton'))) return 'talkUiClosed';
            return (await this.talkOptions(frame) ?? []).some(region => region.text.includes(text)) ? null : 'optionDisappeared';
          });
          if (!completion) this.fail('chooseTalkOption', 'selectionUnverified', 'Clicked talk option is still present after the original 300ms delay');
          return { ...outcome, verified: true, completion };
        }
      }
      return missing('optionNotFound');
    });
  }

  async manualSelection(frame) {
    if (exists(await this.find(frame, 'Common/Element', 'PromptDialogLeftBottomStar'))) return true;
    if (!(exists(await this.find(frame, 'Common/Element', 'BtnBlackCancel')) || exists(await this.find(frame, 'Common/Element', 'BtnWhiteCancel')))) return false;
    return exists(await this.find(frame, 'Common/Element', 'BtnBlackConfirm')) || exists(await this.find(frame, 'Common/Element', 'BtnWhiteConfirm'));
  }
  async claimText(frame, patterns) {
    const text = await this.ocr(frame, [Math.trunc(frame.width * 0.7), Math.trunc(frame.height * 0.8), Math.trunc(frame.width * 0.3), Math.trunc(frame.height * 0.2)]);
    return text.find(region => patterns.some(pattern => pattern.test(region.text)));
  }
  async battlePassStage(stage, patterns) {
    const target = await this.captured(async frame => {
      if (await this.manualSelection(frame)) return { manualRequired: true };
      if (!await this.pageObserved(frame)) this.fail('claimBattlePassRewards', 'missingBattlePassUi', 'Battle pass page was not observed after opening its tab');
      return { region: await this.claimText(frame, patterns) };
    });
    if (target.manualRequired) return { stage, clicked: false, manualRequired: true, completion: 'manualSelectionDialog' };
    if (!target.region) return { stage, clicked: false, manualRequired: false, completion: 'claimTextAbsent' };
    await this.click(target.region); await sleep(this.host, 1000);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(this.host, 500);
      const completion = await this.captured(async frame => {
        if (await this.manualSelection(frame)) return 'manualSelectionDialog';
        if (exists(await this.find(frame, 'Common/Element', 'Primogem'))) return 'primogemOverlay';
        if (await this.pageObserved(frame) && !await this.claimText(frame, patterns)) return 'claimTextDisappeared';
        return null;
      });
      if (completion) {
        if (completion === 'primogemOverlay') await input(this.host, 'keyPress', ['VK_ESCAPE']);
        return { stage, clicked: true, manualRequired: completion === 'manualSelectionDialog', completion };
      }
    }
    this.fail('claimBattlePassRewards', 'claimUnverified', `Battle pass ${stage} claim has no observed completion`);
  }
  async claimBattlePassRewards() {
    return released(this.host, async () => {
      const patterns = await localized(this.host, 'ClaimBattlePassRewardsTask', ['一键', '领取']);
      await this.returnMainUi(); await sleep(this.host, 200);
      await input(this.host, 'keyPress', ['VK_F4']); await sleep(this.host, 1000);
      await this.fixed('click', 960, 45); await sleep(this.host, 500);
      const stages = [await this.battlePassStage('points', patterns)];
      if (!stages[0].manualRequired) {
        await sleep(this.host, 2500);
        if (await this.captured(async frame => exists(await this.find(frame, 'Common/Element', 'Primogem')))) await input(this.host, 'keyPress', ['VK_ESCAPE']);
        await this.fixed('click', 858, 45); await sleep(this.host, 1500);
        stages.push(await this.battlePassStage('rewards', patterns));
      }
      if (stages.some(stage => stage.manualRequired)) {
        this.host.log?.('warn', '纪行：检测到需手动选择的奖励，请手动处理');
        return { verified: true, manualRequired: true, mainUiVerified: false, stages };
      }
      await this.returnMainUi();
      return { verified: true, manualRequired: false, mainUiVerified: true, stages };
    });
  }

  async claimEncounterPointsRewards() {
    return released(this.host, async () => {
      const [commissions] = await localized(this.host, 'ClaimEncounterPointsRewardsTask', ['委托']);
      await this.returnMainUi(); await sleep(this.host, 200);
      await input(this.host, 'keyPress', ['VK_F1']); await sleep(this.host, 1000);
      let found = false, earlyClaim = false;
      for (let attempt = 0; attempt < 5 && !found; attempt++) {
        await sleep(this.host, 1000);
        const target = await this.captured(async frame => (await this.ocr(frame, [0, 0, 380 * Math.min(frame.width / 1920, 1), frame.height])).find(region => commissions.test(region.text)));
        if (!target) continue;
        found = true;
        const claim = await this.captured(frame => this.find(frame, 'Common/Element', 'BtnClaimEncounterPointsRewards'));
        if (exists(claim)) { await this.click(claim); earlyClaim = true; }
        else await this.click(target);
      }
      if (!found) this.fail('claimEncounterPointsRewards', 'missingCommissionsUi', 'Commissions tab was not observed within the original five attempts');
      await sleep(this.host, 1000);
      let claimClicked = earlyClaim;
      if (!earlyClaim) {
        const claim = await this.captured(frame => this.find(frame, 'Common/Element', 'BtnClaimEncounterPointsRewards'));
        if (exists(claim)) { await this.click(claim); claimClicked = true; await sleep(this.host, 1000); }
      }
      const completion = await this.captured(async frame => {
        if (claimClicked && exists(await this.find(frame, 'Common/Element', 'Primogem'))) return 'primogemOverlay';
        if (!await this.pageObserved(frame) || exists(await this.find(frame, 'Common/Element', 'BtnClaimEncounterPointsRewards'))) return null;
        const sidebar = await this.ocr(frame, [0, 0, 380 * Math.min(frame.width / 1920, 1), frame.height]);
        return sidebar.some(region => commissions.test(region.text)) ? (claimClicked ? 'claimButtonDisappeared' : 'claimButtonAbsent') : null;
      });
      if (!completion) this.fail('claimEncounterPointsRewards', 'claimUnverified', 'Encounter points claim has no observed completion on the Commissions page');
      if (!earlyClaim) await this.returnMainUi();
      return { verified: true, earlyClaim, claimClicked, completion, mainUiVerified: !earlyClaim };
    });
  }

  async welkinOverlay(frame) {
    return exists(await this.find(frame, 'GameLoading', 'GirlMoon')) || exists(await this.find(frame, 'GameLoading', 'WelkinMoon')) || exists(await this.find(frame, 'Common/Element', 'Primogem'));
  }
  async blessingOfTheWelkinMoon() {
    return released(this.host, async () => {
      const offset = this.host.serverTimeZoneOffsetHours ?? 8, utc = Number((this.host.utcNow ?? Date.now)());
      if (!Number.isFinite(utc) || !Number.isFinite(offset) || Math.abs(offset) > 14) throw new RangeError('Invalid UTC time or server timezone offset');
      const time = new Date(utc + offset * 3600000 + 300000);
      if (!Number.isFinite(time.getTime())) throw new RangeError('UTC time is outside the supported date range');
      if (time.getUTCHours() !== 4 || time.getUTCMinutes() >= 10) return { acted: false, verified: false, reason: 'outsideServerResetWindow' };
      if (!await this.captured(frame => this.welkinOverlay(frame))) return { acted: false, verified: true, reason: 'overlayAbsent' };
      await this.fixed('moveMouseTo', 100, 100);
      let absent = 0;
      for (let iteration = 1; iteration <= 20; iteration++) {
        if (!absent) { await this.fixed('click', 100, 100); await sleep(this.host, 100); await this.fixed('click', 100, 100); }
        await sleep(this.host, 500);
        absent = await this.captured(frame => this.welkinOverlay(frame)) ? 0 : absent + 1;
        if (absent === 3) return { acted: true, verified: true, completion: 'threeConsecutiveAbsentFrames', iterations: iteration };
      }
      this.fail('blessingOfTheWelkinMoon', 'completionTimeout', 'Welkin overlay did not disappear for three consecutive captures within the original 20 iterations');
    });
  }
}
