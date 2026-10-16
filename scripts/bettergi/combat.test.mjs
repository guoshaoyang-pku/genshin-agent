import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CombatTasks, parseManualSkillCd } from './combat.mjs';
import { executeCombatScript, parseCombatScript } from './native.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const rects = [1, 2, 3, 4].map(index => ({ x: 1859, y: 160 + index * 96, width: 28, height: 24 }));
const observedTeam = ['钟离', '行秋', '纳西妲', '桑多涅'].map((name, i) => ({ name, index: i + 1, indexRect: rects[i] }));

function fixture({ options = {}, onVision, onInput, onSleep, controller } = {}) {
  let time = 0, sequence = 0;
  const inputs = [], operations = [], live = new Set();
  const host = {
    sourceRoot, signal: controller?.signal, now: () => time, random: () => 0, inputs, operations, live,
    async capture() { const handle = ++sequence; live.add(handle); return { handle, width: 1920, height: 1080 }; },
    async sleep(ms) { time += ms; await onSleep?.(ms); },
    async input(method, args = []) { inputs.push({ method, args, at: time }); await onInput?.(method, args); },
    async vision(op, args) {
      operations.push({ op, args, at: time });
      if (op === 'image.dispose') { assert.ok(live.delete(args.handle)); return; }
      const custom = await onVision?.(op, args);
      if (custom !== undefined) return custom;
      if (op === 'party.recognize') return { avatars: observedTeam, indexRects: rects, multiGameStatus: {} };
      if (op === 'party.assets') return { avatarIndexRects: rects };
      if (op === 'party.active') return { index: 1, context: {} };
      if (op === 'party.layout') return { recognizedIndexCount: 4, indexRects: rects };
      if (op === 'party.skill') return { state: 'Unknown', code: null, cd: null };
      if (op === 'party.burst') return { state: 'NotReady' };
      if (op === 'party.bloodBars') return [];
      if (op === 'party.damageNumber') return null;
      if (op === 'party.overheat') return { overheated: false };
      if (op === 'image.mat') return args.args[1] === 790 ? [0, 220, 220] : [250, 250, 250];
      throw new Error('Unexpected vision operation: ' + op);
    },
  };
  const combat = new CombatTasks(host, options);
  combat.find = async () => null;
  combat.isInMainUi = async () => false;
  return { host, combat };
}

test('manual cooldown parser preserves reverse precedence and exact untrimmed name boundaries', () => {
  assert.equal(parseManualSkillCd('钟离', '钟离,12;钟离,-2.5'), -2.5);
  assert.equal(parseManualSkillCd('钟离', '钟离,12;钟离'), -1);
  assert.equal(parseManualSkillCd('钟离', '钟离,12;钟离,bad'), -1);
  assert.equal(parseManualSkillCd('钟离', '大钟离,5;钟离x,10; 钟离,2'), null);
  assert.equal(parseManualSkillCd('钟离', '钟离, 1e1 ;钟离x'), 10);
  assert.equal(parseManualSkillCd('钟离', '钟离,0'), 0);
});

test('team recognition retries original five times, disposes frames and caches only complete teams', async () => {
  let reads = 0;
  const { host, combat } = fixture({ onVision: op => {
    if (op === 'party.recognize' && ++reads < 5) return { avatars: [], indexRects: rects };
  } });
  const team = await combat.initializeTeam();
  assert.equal(team.length, 4);
  assert.equal(team[0].skillCD, 4);
  assert.equal(team[0].skillHoldCD, 12);
  assert.equal(reads, 5);
  assert.equal(host.now(), 4000);
  assert.equal(await combat.initializeTeam(), team);
  assert.equal(reads, 5);
  assert.equal(host.live.size, 0);
  combat.clearTeam();
  await combat.initializeTeam();
  assert.equal(reads, 6);
});

test('recognition failures exhaust attempts without leaving a fabricated team', async () => {
  const { host, combat } = fixture({ onVision: op => { if (op === 'party.recognize') throw new Error('classifier unavailable'); } });
  await assert.rejects(combat.initializeTeam(), /五次重试/);
  assert.deepEqual(combat.state.team, []);
  assert.equal(host.live.size, 0);
});

test('forced team resolves original aliases and original fixed index rectangles', async () => {
  const { host, combat } = fixture({ options: { TeamNames: '钟离， 行秋,草神,桑多涅', ActionSchedulerByCd: '钟离,3' } });
  const team = await combat.initializeTeam();
  assert.deepEqual(team.map(avatar => avatar.name), observedTeam.map(avatar => avatar.name));
  assert.deepEqual(team.map(avatar => avatar.indexRect), rects);
  assert.equal(team[0].manualSkillCd, 3);
  assert.equal(team[2].nameEn, 'Nahida');
  assert.equal(host.operations.some(call => call.op === 'party.recognize'), false);
  assert.equal(host.live.size, 0);
  await assert.rejects(fixture({ options: { TeamNames: '钟离,行秋' } }).combat.initializeTeam(), /必须是4个/);
  await assert.rejects(fixture({ options: { TeamNames: '钟离,行秋,纳西妲,not-a-role' } }).combat.initializeTeam(), /名称校验失败/);
});

test('all negative manual cooldowns infer the catalog maximum, zero disables scheduling', () => {
  const { combat } = fixture();
  const avatar = { manualSkillCd: -2.5, lastSkillAt: 0, ocrReadyAt: -Infinity, skillCD: 6, skillHoldCD: 12 };
  assert.equal(combat.remaining(avatar), 12);
  avatar.ocrReadyAt = 9000;
  assert.equal(combat.remaining(avatar), 9);
  avatar.ocrReadyAt = 999999;
  assert.equal(combat.remaining(avatar), 12);
  avatar.manualSkillCd = 2;
  assert.equal(combat.remaining(avatar), 2);
  avatar.manualSkillCd = 0;
  assert.equal(combat.remaining(avatar), 0);
});

test('ordinary switching does not change TrySwitch target history', async () => {
  const { host, combat } = fixture();
  assert.equal(await combat.switchAvatar({ index: 1 }), true);
  assert.equal(combat.state.lastSwitchTarget, undefined);
  assert.equal(host.inputs.length, 0);
  assert.equal(await combat.switchAvatar({ index: 1 }, true), true);
  assert.deepEqual(host.inputs.map(call => call.args), [['X'], ['1']]);
  assert.equal(await combat.switchAvatar({ index: 1 }, true), true);
  assert.equal(host.inputs.length, 2);
});

test('switching succeeds only after observed target and bounded failure stays false for TrySwitch', async () => {
  let active = 1;
  const { host, combat } = fixture({
    onVision: op => op === 'party.active' ? { index: active, context: {} } : undefined,
    onInput: (method, args) => { if (method === 'keyPress' && args[0] === '2') active = 2; },
  });
  assert.equal(await combat.switchAvatar({ index: 2 }), true);
  assert.equal(host.now(), 250);
  assert.equal(host.live.size, 0);
  const failed = fixture();
  assert.equal(await failed.combat.switchAvatar({ index: 2 }, true), false);
  assert.equal(failed.host.now(), 1000);
  await assert.rejects(failed.combat.switchAvatar({ index: 2 }), /未得到画面确认/);
  assert.equal(failed.host.live.size, 0);
});

test('unknown active character fails after three observations, without a first-slot fallback', async () => {
  const { host, combat } = fixture({ onVision: op => op === 'party.active' ? { index: -1, context: {} } : undefined });
  await assert.rejects(combat.currentAvatar(), /无法确认/);
  assert.equal(host.operations.filter(call => call.op === 'party.active').length, 3);
  assert.equal(host.live.size, 0);
  const dslHost = { ...host, combat: async operation => operation === 'initializeTeam' ? [{ name: '钟离', index: 1 }] : null };
  await assert.rejects(executeCombatScript(parseCombatScript('attack', { aliases: (await combat.catalog()).aliases, validate: false }), dslHost), /无法确认/);
  assert.equal(host.inputs.at(-1).method, 'releaseAll');
});

test('active recognition refreshes sidebar only at source failure multiples and matching counts', async () => {
  const { host, combat } = fixture({ onVision: op => op === 'party.active' ? { index: -1, context: { totalCheckFailedCount: 3 } } : undefined });
  const context = {};
  await combat.captured(frame => combat.active(frame, context));
  assert.equal(context.totalCheckFailedCount, 0);
  assert.equal(host.operations.filter(call => call.op === 'party.layout').length, 1);
});

test('skill press polls cooldown and records observed ready time', async () => {
  let reads = 0;
  const { host, combat } = fixture({ onVision: op => op === 'party.skill' ? (++reads === 1 ? { state: 'Unknown' } : { state: 'Cooldown', cd: 8 }) : undefined });
  const result = await combat.useSkill({ name: '钟离' });
  assert.deepEqual(result, { issued: true, cooldownObserved: true, cd: 8, fallbackApplied: false });
  assert.equal(reads, 2);
  assert.equal(host.now(), 70);
  assert.equal(combat.remaining(await combat.avatar({ name: '钟离' })), 8);
  assert.equal(host.live.size, 0);
});

test('unobserved generic cooldown is reported without claiming a successful cast', async () => {
  const { host, combat } = fixture();
  const result = await combat.useSkill({ name: '钟离', hold: true });
  assert.equal(result.cooldownObserved, false);
  assert.equal(result.fallbackApplied, false);
  assert.equal(result.cd, 0);
  assert.deepEqual(host.inputs.slice(0, 2).map(call => [call.method, call.at]), [['keyDown', 0], ['keyUp', 1000]]);
  assert.equal(host.operations.filter(call => call.op === 'party.skill').length, 7);
});

test('Nahida hold preserves source rotation and releases E even on cancellation', async () => {
  const controller = new AbortController();
  const { host, combat } = fixture({ controller, onSleep: ms => { if (ms === 50) controller.abort(new Error('stop skill')); } });
  await assert.rejects(combat.useSkill({ name: '纳西妲', hold: true }), /stop skill/);
  assert.equal(host.inputs.at(-1).method, 'keyUp');
  assert.deepEqual(host.inputs.at(-1).args, ['E']);
  assert.equal(host.live.size, 0);
});

test('burst skips unavailable state and requires an observed cast transition', async () => {
  const unavailable = fixture();
  assert.deepEqual(await unavailable.combat.useBurst({ name: '钟离' }), { issued: false, state: 'NotReady', castObserved: false });
  assert.equal(unavailable.host.inputs.length, 0);
  let reads = 0;
  const cast = fixture({ onVision: op => op === 'party.burst' ? { state: ++reads > 1 ? 'NotReady' : 'Ready' } : undefined });
  const result = await cast.combat.useBurst({ name: '钟离' });
  assert.equal(result.completion, 'burstStateChanged');
  assert.equal(result.castObserved, true);
  assert.equal(cast.host.now(), 1700);
  assert.equal(cast.host.live.size, 0);
});

test('burst cannot succeed from ten issued Q inputs without visual transition', async () => {
  const { host, combat } = fixture({ onVision: op => op === 'party.burst' ? { state: 'Ready' } : undefined });
  await assert.rejects(combat.useBurst({ name: '钟离' }), /十次/);
  assert.equal(host.inputs.length, 10);
  assert.equal(host.live.size, 0);
});

test('ready waits for observed sidebar, bounds animation wait and disposes each frame', async () => {
  const { host, combat } = fixture({ onVision: op => op === 'party.layout' ? { recognizedIndexCount: 0 } : undefined });
  await assert.rejects(combat.ready(), /未观察到/);
  assert.equal(host.operations.filter(call => call.op === 'party.layout').length, 20);
  assert.equal(host.now(), 3010);
  assert.equal(host.live.size, 0);
});

test('fight finish respects block period then source L progress bar pixels', async () => {
  const { host, combat } = fixture({ options: { FightFinishDetectEnabled: true, FinishDetectConfig: { BlockCheckBeforeBattleSeconds: 20, PaimonEndCheckEnabled: false } } });
  combat.state.fightStartAt = 0;
  assert.equal(await combat.checkFight(), false);
  assert.equal(host.inputs.length, 0);
  await host.sleep(10000);
  assert.equal(await combat.checkFight({ delayTime: 100, detectDelayTime: 50 }), true);
  assert.deepEqual(host.inputs.map(call => call.args[0]), ['L', 'X', 'L']);
  assert.equal(host.live.size, 0);
});

test('visible enemies skip exactly five finish checks before the mandatory check', async () => {
  const { host, combat } = fixture({ options: { FightFinishDetectEnabled: true, FinishDetectConfig: { SkipFightEndCheckWhenEnemyVisible: true, PaimonEndCheckEnabled: false } },
    onVision: op => op === 'party.bloodBars' ? [{ x: 400 }] : undefined });
  for (let i = 0; i < 5; i++) assert.equal(await combat.checkFight(), false);
  assert.equal(host.inputs.length, 0);
  assert.equal(await combat.checkFight(), true);
  assert.equal(combat.state.skipCheckCounter, 0);
});

test('Paimon shortcut cancels finish detection before probing progress pixels', async () => {
  const { host, combat } = fixture({ options: { FightFinishDetectEnabled: true } });
  combat.isInMainUi = async () => true;
  assert.equal(await combat.checkFight({ delayTime: 0 }), false);
  assert.deepEqual(host.inputs.map(call => call.args[0]), ['L', 'X']);
  assert.equal(host.operations.some(call => call.op === 'image.mat'), false);
});

test('defeat detection requires revive text and routes to statue before PATH_RETRY', async () => {
  const { host, combat } = fixture({ onVision: op => op === 'image.ocr' ? [{ text: '复苏' }] : undefined });
  combat.find = async () => ({ x: 1, y: 1, width: 2, height: 2 });
  const calls = []; host.genshin = async (method, args) => calls.push({ method, args });
  await assert.rejects(combat.switchAvatar({ index: 1 }), error => error.code === 'PATH_RETRY');
  assert.deepEqual(calls, [{ method: 'tpToStatueOfTheSeven', args: [] }]);
  assert.equal(host.now(), 600);
  assert.equal(host.live.size, 0);
});

test('Sandrone charge stops on source target loss and never claims damage outcome', async () => {
  const { host, combat } = fixture();
  const result = await combat.charge({ name: '桑多涅', ms: 5000 });
  assert.equal(result.completion, 'targetLost');
  assert.equal(result.elapsedMs, 1500);
  assert.equal(result.outcomeVerified, false);
  assert.equal(host.inputs.at(-1).method, 'leftButtonUp');
  assert.equal(host.live.size, 0);
});

test('Sandrone charge overheat requires three hits after three seconds', async () => {
  const { host, combat } = fixture({ onVision: op => {
    if (op === 'party.bloodBars') return [{ x: 500, y: 400, width: 100, height: 5 }];
    if (op === 'party.overheat') return { overheated: true };
  } });
  const result = await combat.charge({ name: '桑多涅', ms: 5000 });
  assert.equal(result.completion, 'overheat');
  assert.equal(result.elapsedMs, 3100);
  assert.equal(host.inputs.at(-1).method, 'leftButtonUp');
});

test('invalid charge polling interval fails before sending held input', async () => {
  const { host, combat } = fixture({ options: { TargetingDetectionInterval: 0 } });
  await assert.rejects(combat.charge({ name: '桑多涅' }), /interval/);
  assert.equal(host.inputs.length, 0);
});
