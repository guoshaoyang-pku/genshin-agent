import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyTasks, DailyTaskError, TalkOptionRes } from './daily.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (text = '', x = 100, y = 200, width = 100, height = 20) => ({ text, x, y, width, height, globalX: x, globalY: y });

function hostFor({ width = 1920, height = 1080, controller, onInput, onSleep, onCapture, recognize, ocr, mat } = {}) {
  let clock = 0, sequence = 0, captureCount = 0;
  const calls = [], visionCalls = [], captures = new Set(), owned = new Set(), disposed = new Set(), held = new Set(), files = new Map();
  const host = {
    sourceRoot, calls, visionCalls, captures, owned, disposed, held, signal: controller?.signal,
    now: () => clock,
    async sleep(ms) { clock += ms; await onSleep?.(ms, host); },
    async input(method, args = []) {
      calls.push({ at: clock, method, args });
      if (method.endsWith('Down')) held.add(method);
      if (method.endsWith('Up')) held.delete(method.replace(/Up$/, 'Down'));
      if (method === 'releaseAll') held.clear();
      await onInput?.(method, args, host);
    },
    async capture() {
      const handle = 'frame-' + (++sequence); captures.add(handle); owned.add(handle);
      const frame = { handle, width, height, number: ++captureCount };
      await onCapture?.(frame, host); return frame;
    },
    async vision(op, args) {
      visionCalls.push({ op, args });
      if (op === 'recognition.load') {
        if (!files.has(args.path)) files.set(args.path, JSON.parse(await readFile(args.path, 'utf8')));
        assert.ok(files.get(args.path).objects[args.objectName], args.objectName + ' missing original recognition');
        return { original: args.objectName };
      }
      if (op === 'image.dispose') { assert.ok(owned.has(args.handle), args.handle); assert.ok(!disposed.has(args.handle), 'double dispose ' + args.handle); disposed.add(args.handle); return; }
      if (op === 'image.ocr') return await ocr?.(args, host) ?? [];
      if (op === 'image.find' || op === 'image.findMulti') return await recognize?.(args.recognition.original, args, host) ?? (op === 'image.findMulti' ? [] : empty);
      if (op === 'image.crop') {
        const descriptor = { handle: 'crop-' + (++sequence), width: args.width, height: args.height }; owned.add(descriptor.handle); return descriptor;
      }
      if (op === 'image.mat') {
        const result = await mat?.(args, host);
        if (result !== undefined) return result;
        const descriptor = { handle: 'mat-' + (++sequence), width: 100, height: 20 }; owned.add(descriptor.handle); return descriptor;
      }
      throw new Error('Unexpected vision op ' + op);
    },
  };
  return host;
}
function done(host) {
  assert.equal(host.calls.at(-1)?.method, 'releaseAll');
  assert.equal(host.held.size, 0);
  assert.deepEqual(host.owned, host.disposed);
}
function mainRecognition(phase, name) {
  if (name === 'PaimonMenu' && phase === 'main') return region();
  if (name === 'PageCloseWhite' && phase !== 'main') return region();
  return empty;
}

test('setTime reuses exact clock geometry, click/drag timing and source completion recognition', async () => {
  let phase = 'main';
  const host = hostFor({
    recognize: name => mainRecognition(phase, name),
    onInput(method, args) {
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = phase === 'main' ? 'menu' : 'main';
      if (method === 'click' && args[0] === 50) phase = 'clock';
    },
  });
  const result = await new DailyTasks(host).setTime('24', '15');
  assert.equal(result.hour, 0); assert.equal(result.minute, 15);
  assert.equal(result.completion, 'pageClose'); assert.equal(result.attempts, 1); assert.equal(result.timeValueVerified, false);
  const positions = host.calls.filter(call => call.method === 'moveMouseTo').map(call => call.args);
  const point = (r, index) => [1441 + r * Math.cos(index * Math.PI / 720), 501.6 + r * Math.sin(index * Math.PI / 720)];
  const end = 355;
  const expected = [point(30, end - 960), point(30, end - 480), point(30, end), point(150, end + 5), point(300, end + 20.5), [1500, 1000]];
  positions.forEach((actual, i) => actual.forEach((value, j) => assert.ok(Math.abs(value - expected[i][j]) < 1e-10)));
  assert.equal(host.calls.filter(call => call.method === 'leftButtonDown').length, 4);
  assert.equal(host.now(), 7657);
  done(host);
});
test('fixed clock coordinates scale once for a 1280x720 capture and skip mode observes main UI', async () => {
  let phase = 'main';
  const host = hostFor({ width: 1280, height: 720, recognize: name => mainRecognition(phase, name), onInput(method, args) {
    if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = phase === 'main' ? 'menu' : 'main';
  } });
  const result = await new DailyTasks(host).setTime(8, 30, true);
  assert.equal(result.completion, 'mainUiAfterSkip');
  assert.deepEqual(host.calls.find(call => call.method === 'click').args, [50 * (2 / 3), 700 * (2 / 3)]);
  assert.equal(host.calls.filter(call => call.method === 'click' && call.args[0] === 30).length, 2);
  done(host);
});
test('setTime exhaustion, invalid arguments and cancellation release held mouse buttons', async () => {
  let phase = 'main', closeChecks = 0;
  const timedOut = hostFor({ recognize: name => { if (name === 'PaimonMenu' && phase === 'main') return region(); if (name === 'PageCloseWhite' && ++closeChecks === 1) return region(); return empty; }, onInput: method => { if (method === 'keyPress') phase = 'clock'; } });
  await assert.rejects(new DailyTasks(timedOut).setTime(12), error => error instanceof DailyTaskError && error.code === 'completionTimeout');
  assert.equal(closeChecks, 26); done(timedOut);
  const missing = hostFor({ recognize: name => name === 'PaimonMenu' ? region() : empty });
  await assert.rejects(new DailyTasks(missing).setTime(12), error => error.code === 'missingTimeUi'); done(missing);
  for (const args of [[-1, 0], [25, 0], [8, 60], [true, 0], ['', 0], [1.5, 0], [8, 0, 'true']]) {
    const host = hostFor(); await assert.rejects(new DailyTasks(host).setTime(...args)); done(host); assert.equal(host.captures.size, 0);
  }
  const controller = new AbortController();
  let cancelPhase = 'main';
  const canceled = hostFor({ controller, recognize: name => mainRecognition(cancelPhase, name), onInput: method => { if (method === 'keyPress') cancelPhase = 'clock'; }, onSleep(_ms, host) { if (host.held.size) controller.abort(new Error('cancel clock drag')); } });
  await assert.rejects(new DailyTasks(canceled).setTime(12), /cancel clock drag/);
  assert.deepEqual(canceled.calls.slice(-3).map(call => call.method), ['leftButtonDown', 'leftButtonUp', 'releaseAll']); done(canceled);
});

function talkHost({ texts = ['选择这个选项'], orange = 201, remain = false, bubbles = true, ...options } = {}) {
  let clicked = false, ocrCount = 0;
  const host = hostFor({ ...options,
    recognize: (name, args, host) => {
      const custom = options.recognize?.(name, args, host); if (custom !== undefined) return custom;
      if (name === 'DisabledUiButton') return !clicked || remain ? region() : empty;
      if (name === 'OptionIcon') return bubbles ? [region('', 1100, 550, 20, 20), region('', 1100, 300, 20, 20)] : [];
      return empty;
    },
    ocr(args, host) { ocrCount++; return options.ocr?.(args, host, ocrCount) ?? texts.map((text, i) => region(text, 1130, 330 + i * 40)); },
    mat: args => { if (args.method === 'CountNonZero') return orange; },
    onInput(method, args, host) { if (method === 'click') clicked = true; return options.onInput?.(method, args, host); },
  });
  return host;
}
test('dialogue preserves talk wait, first OCR delay, lowest-bubble ROI and substring matching', async () => {
  const host = talkHost({ texts: ['No', '我要选择这个选项'] });
  const result = await new DailyTasks(host).chooseTalkOption('选择这个');
  assert.equal(result.result, TalkOptionRes.FoundAndClick); assert.equal(result.completion, 'talkUiClosed');
  const ocr = host.visionCalls.filter(call => call.op === 'image.ocr');
  assert.equal(ocr.length, 2); assert.deepEqual(ocr[0].args.recognition.roi, [1128, 135, 535, 510]);
  assert.equal(host.calls.find(call => call.method === 'click').at, 2000);
  assert.equal(host.now(), 2300); done(host);
});
test('dialogue OCR returns upstream unfiltered English options and uses observed disappearance', async () => {
  const host = talkHost({ texts: ['No'], remain: true, ocr(_args, _host, count) { return count < 3 ? [region('No')] : []; } });
  const result = await new DailyTasks(host).chooseTalkOption('No');
  assert.equal(result.completion, 'optionDisappeared'); done(host);
});
test('dialogue missing UI, no bubble, missing text and source zero retry are explicit misses', async () => {
  const absent = hostFor();
  assert.deepEqual(await new DailyTasks(absent).chooseTalkOption('x'), { result: 0, status: 'NotFound', found: false, clicked: false, verified: false, code: 'missingTalkUi' });
  assert.equal(absent.now(), 5000); assert.equal(absent.calls.filter(call => call.method === 'keyPress').length, 0); done(absent);
  const bubbles = talkHost({ bubbles: false });
  assert.equal((await new DailyTasks(bubbles).chooseTalkOption('x', 3)).code, 'optionNotFound');
  assert.equal(bubbles.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_SPACE').length, 3); done(bubbles);
  const missing = talkHost(); assert.equal((await new DailyTasks(missing).chooseTalkOption('absent', 3)).clicked, false); done(missing);
  const zero = talkHost(); assert.equal((await new DailyTasks(zero).chooseTalkOption('x', 0)).result, 0); done(zero);
});
test('orange dialogue uses original HSV bounds and strict greater-than-ten-percent threshold', async () => {
  const white = talkHost({ orange: 200 });
  assert.equal((await new DailyTasks(white).chooseTalkOption('选项', 10, true)).result, TalkOptionRes.FoundButNotOrange);
  assert.equal(white.calls.filter(call => call.method === 'click').length, 0); done(white);
  const orange = talkHost();
  assert.equal((await new DailyTasks(orange).chooseTalkOption('选项', 10, true)).result, TalkOptionRes.FoundAndClick);
  assert.deepEqual(orange.visionCalls.find(call => call.args.method === 'InRange').args.args, [[10, 150, 150], [25, 255, 255]]); done(orange);
});
test('unchanged clicked dialogue is a verification failure, and cancellation or vision failure cleans captures', async () => {
  const unchanged = talkHost({ remain: true });
  await assert.rejects(new DailyTasks(unchanged).chooseTalkOption('选项'), error => error.code === 'selectionUnverified'); done(unchanged);
  const controller = new AbortController();
  const canceled = talkHost({ controller, onSleep: () => controller.abort(new Error('cancel talk')) });
  await assert.rejects(new DailyTasks(canceled).chooseTalkOption('x'), /cancel talk/); done(canceled);
  const failed = talkHost({ ocr: () => { throw new Error('ocr unavailable'); } });
  await assert.rejects(new DailyTasks(failed).chooseTalkOption('x'), /ocr unavailable/); done(failed);
});

function battlePassHost({ locale, label, claims = true, manual, unchanged = false, missingUi = false, ...options } = {}) {
  let phase = 'main', claimed = new Set();
  const host = hostFor({ ...options,
    recognize(name, args, host) {
      const custom = options.recognize?.(name, args, host); if (custom !== undefined) return custom;
      if (name === 'PromptDialogLeftBottomStar' && phase === 'manual' && manual === 'star') return region();
      if (phase === 'manual' && manual === 'buttons' && ['BtnWhiteCancel', 'BtnBlackConfirm'].includes(name)) return region();
      return missingUi && phase !== 'main' ? empty : mainRecognition(phase, name);
    },
    ocr(args) { assert.deepEqual(args.recognition.roi, [1344, 864, 576, 216]); return claims && ['points', 'rewards'].includes(phase) && (!claimed.has(phase) || unchanged) ? [region(label ?? '一键领取', 1700, 960)] : []; },
    onInput(method, args, host) {
      if (method === 'keyPress' && args[0] === 'VK_F4') phase = 'battlePass';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = 'main';
      if (method === 'click' && args[1] === 45) phase = args[0] === 960 ? 'points' : 'rewards';
      else if (method === 'click' && phase === 'rewards' && manual) phase = 'manual';
      else if (method === 'click') claimed.add(phase);
      return options.onInput?.(method, args, host);
    },
  });
  host.gameCultureInfoName = locale; return host;
}
test('battle pass claims points before rewards and records disappearance evidence', async () => {
  const host = battlePassHost();
  const result = await new DailyTasks(host).claimBattlePassRewards();
  assert.deepEqual(result.stages.map(stage => stage.stage), ['points', 'rewards']);
  assert.ok(result.stages.every(stage => stage.clicked && stage.completion === 'claimTextDisappeared'));
  assert.equal(result.mainUiVerified, true); assert.equal(result.manualRequired, false);
  assert.deepEqual(host.calls.filter(call => call.method === 'click').map(call => call.args), [[960, 45], [1750, 970], [858, 45], [1750, 970]]); done(host);
});
test('battle pass no-claim result requires observed page and locale reads original translations', async () => {
  const none = battlePassHost({ claims: false });
  const result = await new DailyTasks(none).claimBattlePassRewards(); assert.ok(result.stages.every(stage => !stage.clicked && stage.completion === 'claimTextAbsent')); done(none);
  for (const [locale, label] of [['en-US', 'Claim All'], ['fr', 'récupérer'], ['it', 'Riscatta'], ['zh-Hant', '領取']]) {
    const host = battlePassHost({ locale, label });
    assert.equal((await new DailyTasks(host).claimBattlePassRewards()).stages.filter(stage => stage.clicked).length, 2, locale); done(host);
  }
});
test('battle pass manual star or paired dialog buttons leave reward selection untouched', async () => {
  for (const manual of ['star', 'buttons']) {
    const host = battlePassHost({ manual });
    const result = await new DailyTasks(host).claimBattlePassRewards();
    assert.equal(result.manualRequired, true); assert.equal(result.mainUiVerified, false);
    assert.equal(host.calls.filter(call => call.method === 'click').length, 4);
    assert.equal(host.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'VK_ESCAPE').length, 0); done(host);
  }
});
test('battle pass missing UI, unchanged reward and canceled click fail without false success', async () => {
  const missing = battlePassHost({ missingUi: true });
  await assert.rejects(new DailyTasks(missing).claimBattlePassRewards(), error => error.code === 'missingBattlePassUi'); done(missing);
  const unchanged = battlePassHost({ unchanged: true });
  await assert.rejects(new DailyTasks(unchanged).claimBattlePassRewards(), error => error.code === 'claimUnverified'); done(unchanged);
  const controller = new AbortController();
  const canceled = battlePassHost({ controller, onInput(method, args) { if (method === 'click' && args[1] > 900) controller.abort(new Error('cancel battle pass')); } });
  await assert.rejects(new DailyTasks(canceled).claimBattlePassRewards(), /cancel battle pass/); done(canceled);
});

function encounterHost({ early = false, absent = false, unchanged = false, missingCommissions = false, losePage = false, locale, label, ...options } = {}) {
  let phase = 'main', claimed = false;
  const host = hostFor({ ...options,
    recognize(name) {
      if (name === 'BtnClaimEncounterPointsRewards') return !absent && (!claimed || unchanged) && (phase === 'commissions' || (early && phase === 'book')) ? region('', 1500, 900) : empty;
      return losePage && claimed ? empty : mainRecognition(phase, name);
    },
    ocr() { return phase !== 'main' && !missingCommissions ? [region(label ?? '委托', 100, 250)] : []; },
    onInput(method, args, host) {
      if (method === 'keyPress' && args[0] === 'VK_F1') phase = 'book';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = 'main';
      if (method === 'click' && args[0] < 500) phase = 'commissions';
      else if (method === 'click') claimed = true;
      return options.onInput?.(method, args, host);
    },
  });
  host.gameCultureInfoName = locale; return host;
}
test('encounter points original early-claim keeps book open and normal branch returns main', async () => {
  const early = encounterHost({ early: true });
  const first = await new DailyTasks(early).claimEncounterPointsRewards();
  assert.deepEqual(first, { verified: true, earlyClaim: true, claimClicked: true, completion: 'claimButtonDisappeared', mainUiVerified: false });
  assert.equal(early.calls.filter(call => call.method === 'click').length, 1); done(early);
  const regular = encounterHost({ locale: 'en-GB', label: 'Commissions' });
  const second = await new DailyTasks(regular).claimEncounterPointsRewards(); assert.equal(second.mainUiVerified, true); assert.equal(second.earlyClaim, false);
  assert.equal(regular.calls.filter(call => call.method === 'click').length, 2);
  assert.deepEqual(regular.visionCalls.find(call => call.op === 'image.ocr').args.recognition.roi, [0, 0, 380, 1080]); done(regular);
});
test('encounter points no-button is honest no-action; failed page or unchanged claim is failure', async () => {
  const absent = encounterHost({ absent: true });
  const result = await new DailyTasks(absent).claimEncounterPointsRewards(); assert.equal(result.claimClicked, false); assert.equal(result.completion, 'claimButtonAbsent'); done(absent);
  const missing = encounterHost({ missingCommissions: true });
  await assert.rejects(new DailyTasks(missing).claimEncounterPointsRewards(), error => error.code === 'missingCommissionsUi');
  assert.equal(missing.visionCalls.filter(call => call.op === 'image.ocr').length, 5); done(missing);
  for (const options of [{ unchanged: true }, { losePage: true }]) {
    const host = encounterHost(options); await assert.rejects(new DailyTasks(host).claimEncounterPointsRewards(), error => error.code === 'claimUnverified'); done(host);
  }
});
test('encounter points cancellation after original early claim cleans up without main-UI clicks', async () => {
  const controller = new AbortController();
  const host = encounterHost({ early: true, controller, onInput(method) { if (method === 'click') controller.abort(new Error('cancel encounter')); } });
  await assert.rejects(new DailyTasks(host).claimEncounterPointsRewards(), /cancel encounter/);
  assert.equal(host.calls.filter(call => call.method === 'click').length, 1); done(host);
});

function welkinHost(states, options = {}) {
  let overlay;
  const host = hostFor({ ...options, onCapture(frame) { overlay = states[Math.min(frame.number - 1, states.length - 1)]; }, recognize(name) { return name === overlay ? region() : empty; } });
  host.utcNow = () => Date.parse('2026-10-15T20:00:00Z'); return host;
}
test('Welkin uses original server gate, consecutive-three absence with reset, and source double click', async () => {
  const host = welkinHost(['GirlMoon', 'WelkinMoon', null, 'Primogem', null, null, null]);
  const result = await new DailyTasks(host).blessingOfTheWelkinMoon();
  assert.deepEqual(result, { acted: true, verified: true, completion: 'threeConsecutiveAbsentFrames', iterations: 6 });
  assert.equal(host.calls.filter(call => call.method === 'click').length, 6); done(host);
});
test('Welkin reset-window boundaries and absent overlay distinguish skip from claimed', async () => {
  for (const [time, capture] of [['19:54:59Z', false], ['19:55:00Z', true], ['20:04:59Z', true], ['20:05:00Z', false]]) {
    const host = welkinHost([null]); host.utcNow = () => Date.parse('2026-10-15T' + time);
    const result = await new DailyTasks(host).blessingOfTheWelkinMoon();
    assert.equal(host.captures.size > 0, capture, time); assert.equal(result.acted, false); assert.equal(result.reason, capture ? 'overlayAbsent' : 'outsideServerResetWindow'); done(host);
  }
  const europe = welkinHost([null]); europe.utcNow = () => Date.parse('2026-10-16T03:00:00Z'); europe.serverTimeZoneOffsetHours = 1;
  assert.equal((await new DailyTasks(europe).blessingOfTheWelkinMoon()).reason, 'overlayAbsent'); done(europe);
});
test('Welkin original twenty-iteration budget and cancellation cannot report completion', async () => {
  const stuck = welkinHost(['GirlMoon']);
  await assert.rejects(new DailyTasks(stuck).blessingOfTheWelkinMoon(), error => error.code === 'completionTimeout');
  assert.equal(stuck.captures.size, 21); assert.equal(stuck.calls.filter(call => call.method === 'click').length, 40); done(stuck);
  const controller = new AbortController();
  const canceled = welkinHost(['GirlMoon'], { controller, onSleep: () => controller.abort(new Error('cancel welkin')) });
  await assert.rejects(new DailyTasks(canceled).blessingOfTheWelkinMoon(), /cancel welkin/); done(canceled);
});
test('all daily methods honor an already-aborted task before any capture or click', async () => {
  for (const [method, args] of [['setTime', [12]], ['chooseTalkOption', ['x']], ['claimBattlePassRewards', []], ['claimEncounterPointsRewards', []], ['blessingOfTheWelkinMoon', []]]) {
    const controller = new AbortController(); controller.abort(new Error('already canceled'));
    const host = hostFor({ controller });
    await assert.rejects(new DailyTasks(host)[method](...args), /already canceled/);
    assert.equal(host.calls.length, 1); assert.equal(host.captures.size, 0); done(host);
  }
});
