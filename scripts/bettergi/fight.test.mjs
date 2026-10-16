import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutoFightTask, fightConfig, loadCombatStrategies, parseFinishDetect, selectCombatStrategy } from './fight.mjs';
import { parseJsonCombatStrategy } from './fight-json.mjs';
import { FightSeek, enemyMovement } from './fight-seek.mjs';

const teamNames = ['钟离', '行秋', '纳西妲', '枫原万叶'];
const command = (name, method, args = []) => ({ name, method, args });
function fixture({ commands = [command('钟离', 'attack')], config = {}, onVision, onInput, onSleep, controller } = {}) {
  let time = 0, sequence = 0, active = 1;
  const events = [], handles = new Set();
  const state = { team: teamNames.map((name, i) => ({ name, index: i + 1, skillCD: 4, skillHoldCD: 12, lastSkillAt: -Infinity, ocrReadyAt: -Infinity, manualSkillCd: -1 })) };
  state.catalog = { aliases: new Map(teamNames.map(name => [name, name])), avatars: state.team };
  const host = {
    signal: controller?.signal, sourceRoot: '/source', now: () => time,
    async capture() { const handle = ++sequence; handles.add(handle); return { handle, width: 1920, height: 1080 }; },
    async sleep(ms) { time += ms; events.push({ method: 'sleep', ms, time }); await onSleep?.(ms); },
    async input(method, args = []) {
      events.push({ method, args, time });
      if (method === 'keyPress' && /^[1-4]$/.test(args[0])) active = Number(args[0]);
      await onInput?.(method, args);
    },
    async vision(op, args) {
      events.push({ op, args, time });
      if (op === 'image.dispose') { assert.ok(handles.delete(args.handle)); return; }
      const value = await onVision?.(op, args); if (value !== undefined) return value;
      if (op === 'party.resetTargetTracker') return {};
      if (op === 'party.active') return { index: active, context: {} };
      if (op === 'recognition.load') return { name: args.objectName };
      if (op === 'image.find') return null;
      if (op === 'image.ocr') return [];
      if (op === 'party.bloodBars') return [];
      if (op === 'party.damageNumber') return null;
      if (op === 'fight.experience') return { detected: false };
      if (op === 'image.mat') return args.args[1] === 790 ? [0, 220, 220] : [250, 250, 250];
      throw new Error('Unexpected ' + op);
    },
    log(level, message) { events.push({ level, message }); },
  };
  const strategies = [{ name: 'original', avatarNames: [...new Set(commands.map(command => command.name))], commands }];
  const task = new AutoFightTask(host, { config: { KazuhaPickupEnabled: false, PickDropsAfterFightEnabled: false, ...config }, strategies }, state);
  return { host, task, state, events, handles, advance: ms => { time += ms; } };
}

test('strategy selection maximizes observed matches, prefers fewer avatars and preserves source order', () => {
  const strategies = [{ avatarNames: ['钟离', '行秋', '琴'] }, { avatarNames: ['钟离', '行秋'] }, { avatarNames: ['行秋', '钟离'] }];
  assert.equal(selectCombatStrategy(strategies, ['钟离', '行秋']).strategy, strategies[1]);
  assert.throws(() => selectCombatStrategy(strategies, ['纳西妲']), /未匹配/);
});

test('JSON strategy executes through the full fight entry before TXT command filtering', async () => {
  const f = fixture();
  f.task.strategies = [parseJsonCombatStrategy({ Info: { Name: '原版 JSON' }, Actions: [{ Name: '结束检查', Character: '钟离', Action: 'check()' }] })];
  const receipt = await f.task.start();
  assert.equal(receipt.kind, 'json'); assert.equal(receipt.strategy, '原版 JSON');
  assert.equal(receipt.nodesExecuted, 1); assert.equal(receipt.commandsExecuted, 1);
  assert.equal(receipt.ended, true); assert.equal(receipt.timedOut, false);
  assert.equal(f.handles.size, 0); assert.equal(f.state.fightActive, false);
});

test('single JSON strategy with current-avatar actions does not require a named character', async () => {
  const f = fixture();
  f.task.strategies = [parseJsonCombatStrategy({ Actions: [{ Name: '检查', Action: 'check()' }] })];
  const receipt = await f.task.start();
  assert.equal(receipt.availableActions, 1); assert.equal(receipt.ended, true);
  assert.equal(f.handles.size, 0);
});

test('strategy loading supports original JSON and TXT files recursively and reports parse failures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-fight-load-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'a.txt'), '钟离 attack()');
  await writeFile(path.join(root, 'broken.json'), '{');
  await writeFile(path.join(root, 'nested', 'b.JSON'), JSON.stringify({ Info: { Name: 'json-source' }, Actions: [{ Character: '钟离', Action: 'attack()' }] }));
  const logs = [], result = await loadCombatStrategies(root, new Map([['钟离', '钟离']]), (...args) => logs.push(args));
  assert.deepEqual(result.map(value => value.name), ['a', 'json-source']);
  assert.equal(result[1].kind, 'json'); assert.equal(logs.length, 1);
  assert.match(logs[0][1], /broken.json/);
});

test('fixed strategy names prefer JSON and preserve its syntax errors instead of falling back to TXT', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-fight-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'named.txt'), '钟离 attack()');
  const filename = path.join(root, 'named.json');
  await writeFile(filename, JSON.stringify({ Actions: [{ Character: '钟离', Action: 'check()' }] }));
  const f = fixture(); f.task.strategies = undefined; f.task.strategyRoot = root; f.task.options.StrategyName = 'named';
  f.host.sourceRoot = path.resolve(import.meta.dirname, '../../third_party/bettergi/source');
  const selected = await f.task.strategy(f.state.team);
  assert.equal(selected.strategy.filename, filename); assert.equal(selected.strategy.kind, 'json');
  await writeFile(filename, '{');
  await assert.rejects(f.task.strategy(f.state.team), /JSON 战斗策略格式错误/);
});

test('global and task fight settings preserve nested defaults and source per-avatar finish delays', () => {
  const config = fightConfig({ finishDetectConfig: { fastCheckEnabled: true, checkEndDelay: '0.2;钟离,1.4;' } }, { Timeout: 8, FinishDetectConfig: { BeforeDetectDelay: '0', FastCheckParams: '2;行秋;3' } });
  assert.equal(config.FinishDetectConfig.FastCheckEnabled, true);
  assert.equal(config.FinishDetectConfig.CheckEndDelay, '0.2;钟离,1.4;');
  assert.equal(config.Timeout, 8);
  const parsed = parseFinishDetect(config.FinishDetectConfig);
  assert.equal(parsed.delayTime, 200); assert.equal(parsed.detectDelayTime, 0);
  assert.equal(parsed.delayTimes.get('钟离'), 1400);
  assert.equal(parsed.checkTime, 3); assert.deepEqual(parsed.checkNames, ['行秋']);
});

test('full TXT task repeats rounds and only reports finish after the original visual probe', async () => {
  let reads = 0;
  const f = fixture({ commands: [{ ...command('钟离', 'attack'), activatingRound: [99] }], onVision(op, args) {
    if (op === 'image.mat' && args.args[1] === 790 && ++reads === 1) return [0, 0, 0];
  } });
  const result = await f.task.start();
  assert.equal(result.passes, 2); assert.equal(result.executed, 2); assert.equal(result.ended, true);
  assert.equal(result.timedOut, false); assert.equal(result.completion, 'partyLoadingObserved');
  assert.equal(f.events.filter(event => event.method === 'leftButtonClick').length, 2);
  assert.equal(f.state.fightActive, false); assert.equal(f.handles.size, 0);
});

test('task-specific finish settings reach commands and timeout never becomes observed victory', async () => {
  const f = fixture({ config: { FightFinishDetectEnabled: false, Timeout: 0 } });
  const result = await f.task.start();
  assert.equal(result.executed, 1); assert.equal(result.passes, 1);
  assert.equal(result.completed, true); assert.equal(result.ended, false);
  assert.equal(result.timedOut, true); assert.equal(result.completion, 'timeout');
  assert.equal(f.events.some(event => event.op === 'image.mat'), false);
});

test('cooldown skipping preserves the active avatar action block and original previous-command boundary', async () => {
  const f = fixture({ commands: [command('钟离', 'keypress', ['E']), command('钟离', 'attack'), command('行秋', 'attack')], config: { ActionSchedulerByCd: '钟离,12' } });
  f.task.afterUseSkill = async () => { f.state.team[0].lastSkillAt = f.host.now(); return 12; };
  const result = await f.task.start();
  assert.equal(result.executed, 3); assert.equal(result.countFight, 2);
  assert.equal(f.events.filter(event => event.method === 'leftButtonClick').length, 2);
  assert.ok(f.events.some(event => event.method === 'keyPress' && event.args[0] === '2'));
});

test('per-avatar finish delay persists for later avatar checks in the same full task', async () => {
  let reads = 0;
  const f = fixture({ commands: [command('钟离', 'attack'), command('行秋', 'attack')], config: { FinishDetectConfig: { FastCheckEnabled: true, FastCheckParams: '钟离', CheckEndDelay: '0.2;钟离,0.9', BeforeDetectDelay: '0' } }, onVision(op, args) {
    if (op === 'image.mat' && args.args[1] === 790 && ++reads === 1) return [0, 0, 0];
  } });
  await f.task.start();
  assert.equal(f.events.filter(event => event.method === 'sleep' && event.ms === 900).length, 2);
});

test('failure during target tracker reset releases input and clears the fighting flag', async () => {
  const f = fixture({ onVision(op) { if (op === 'party.resetTargetTracker') throw new Error('reset failed'); } });
  await assert.rejects(f.task.start(), /reset failed/);
  assert.equal(f.state.fightActive, false); assert.equal(f.events.at(-1).method, 'releaseAll');
});

test('targeting rechecks exclusivity after recognition so a concurrent switch prevents camera input', async () => {
  const f = fixture({ onVision(op) {
    if (op === 'party.bloodBars') { f.state.exclusiveCount = 1; return [{ x: 1000, y: 400, width: 100, height: 5 }]; }
    if (op === 'image.find') return { x: 1, y: 1, width: 2, height: 2 };
  } });
  await f.task.targetTick();
  assert.equal(f.events.some(event => event.method === 'moveMouseBy'), false); assert.equal(f.handles.size, 0);
});

test('targeting chooses closest ordinary bar and uses damage numbers for legendary enemies', async () => {
  let legendary = false;
  const f = fixture({ onVision(op) {
    if (op === 'image.find') return { x: 1, y: 1, width: 2, height: 2 };
    if (op === 'party.bloodBars') return [{ x: 1500, y: 200, width: 100, height: 6 }, { x: 1000, y: 460, width: 100, height: 6, legendary }];
    if (op === 'party.damageNumber') return { centerX: 1100, centerY: 520 };
  } });
  await f.task.targetTick(); legendary = true; await f.task.targetTick();
  assert.deepEqual(f.events.filter(event => event.method === 'moveMouseBy').map(event => event.args), [[31, -4], [49, 10]]);
});

test('targeting worker cleanup joins before loot and runs once despite final cleanup', async () => {
  const f = fixture({ config: { EnableCombatTargeting: true } });
  f.task.pickup = async () => { f.events.push({ method: 'pickup' }); return {}; };
  await f.task.start();
  const middle = f.events.findIndex(event => event.method === 'middleButtonClick');
  assert.ok(middle >= 0 && middle < f.events.findIndex(event => event.method === 'pickup'));
  assert.equal(f.events.filter(event => event.method === 'middleButtonClick').length, 1);
  assert.equal(f.handles.size, 0);
});

test('cancelling a held attack propagates cancellation and releases every held input', async () => {
  const controller = new AbortController();
  const f = fixture({ commands: [command('钟离', 'charge', ['1'])], controller, onSleep() { controller.abort(new Error('stop combat')); } });
  await assert.rejects(f.task.start(), /stop combat/);
  assert.ok(f.events.some(event => event.method === 'leftButtonUp'));
  assert.equal(f.events.at(-1).method, 'releaseAll'); assert.equal(f.state.fightActive, false);
});

test('source movement boundaries keep raw coordinates and do not move tall peripheral bars', () => {
  assert.deepEqual(enemyMovement({ x: 499, y: 400, height: 6 }), ['W', 'A']);
  assert.deepEqual(enemyMovement({ x: 1316, y: 801, height: 6 }), ['S', 'D']);
  assert.deepEqual(enemyMovement({ x: 499, y: 400, height: 7 }), []);
  assert.equal(enemyMovement({ x: 920, y: 400, height: 7 }), 'tapS');
});

test('seek movement abort joins its worker and releases W/A without losing frame ownership', async () => {
  let held; const started = new Promise(resolve => { held = resolve; });
  const f = fixture({ onVision(op) { if (op === 'fight.seekComponents') return { components: [{ x: 400, y: 400, height: 4 }] }; } });
  f.host.sleep = function () { held(); return new Promise((resolve, reject) => this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true })); };
  const seeker = new FightSeek(f.host, f.state); seeker.moveForward(); await started; await seeker.stopMovements();
  assert.deepEqual(f.events.filter(event => event.method === 'keyUp').map(event => event.args), [['W'], ['A']]);
  assert.equal(f.state.seekMovements.size, 0); assert.equal(f.handles.size, 0);
});
