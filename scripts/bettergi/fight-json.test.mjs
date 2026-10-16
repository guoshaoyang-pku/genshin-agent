// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutoFightJsonTask, loadJsonCombatStrategy, parseJsonCombatStrategy, runAutoFightJson } from './fight-json.mjs';
import { AutoFightTask } from './fight.mjs';

const strategy = (actions, info = {}) => parseJsonCombatStrategy(JSON.stringify({ Info: info, Actions: actions }));
const action = (name, command = 'check', extra = {}) => ({ Name: name, Action: command, ...extra });

function setup(overrides = {}) {
  let time = 0, captures = 0, disposals = 0;
  const events = [], warnings = [], controller = new AbortController(), cooldowns = [...(overrides.cooldowns ?? [true])];
  const runtime = {
    state: { team: [{ name: '芙宁娜', index: 1 }, { name: '香菱', index: 2 }], skillTracker: new Map(), lastActiveIndex: 2, lastFightCheckAt: -100000, rotationCount: 88 },
    options: { Timeout: 1, FightFinishDetectEnabled: true, KazuhaPickupEnabled: false, PickDropsAfterFightEnabled: false, ExpBasedPickupEnabled: false,
      EnableCombatTargeting: false, TargetingDetectionInterval: 50, FinishDetectConfig: { FastCheckEnabled: false, CheckAfterSwitchAvatar: false }, ...overrides.options },
    finish: { checkTime: 5, checkNames: [], delayTime: 400, delayTimes: new Map(), detectDelayTime: 50, ...overrides.finish },
    host: {
      now: () => time, signal: controller.signal,
      log: (...args) => warnings.push(args),
      async sleep(ms) { events.push(['sleep', ms]); time += ms; await overrides.onSleep?.(ms, runtime); },
      async input(method, args) { events.push(['input', method, args]); if (method !== 'releaseAll') time++; await overrides.onInput?.(method, args, runtime); },
      async vision(op, args) { events.push(['vision', op, args]); return op === 'fight.qReady' ? { readyIndexes: [2] } : op === 'party.lowHp' ? false : op === 'fight.experience' ? { detected: overrides.experience ?? false } : {}; },
      async combat(method, args) {
        events.push(['combat', method, args]);
        if (method === 'switchAvatar') return runtime.switchAvatar(args);
        if (overrides.onCombat) return overrides.onCombat(method, args, runtime);
      },
    },
    async initializeTeam() { return this.state.team; },
    async captured(body) {
      captures++; time++; const handle = 'frame' + captures; events.push(['capture', handle]);
      try { return await body({ handle }); } finally { disposals++; events.push(['dispose', handle]); }
    },
    async switchAvatar(args) { events.push(['switch', args.name]); if (overrides.switchResult === false) return false; this.state.lastActiveIndex = this.state.team.find(avatar => avatar.name === args.name)?.index; return true; },
    async checkFight(args) { events.push(['check', args]); this.state.lastFightCheckAt = time; return overrides.checkResult ?? true; },
    async active(frame, context) { return this.state.lastActiveIndex; },
    async guardianCooldown(avatar, skill, frame) { events.push(['cooldown', avatar.name, skill, frame.handle]); return cooldowns.length > 1 ? cooldowns.shift() : cooldowns[0] ?? false; },
    async targetTick() { events.push(['target']); },
    background(body, interval, options) {
      const kind = options?.cleanup ? 'targeting' : 'experience'; events.push(['background', kind, interval, options]);
      const work = kind === 'experience' && overrides.experience ? body(runtime) : Promise.resolve();
      return { async stop() { events.push(['stop', kind]); await work; await overrides.onStop?.(kind); } };
    },
    seeker: { async stopMovements() { events.push(['stopMovements']); await overrides.onStop?.('movements'); } },
    async pickup(args) { events.push(['pickup', args, this.options.KazuhaPickupEnabled]); await overrides.onPickup?.(runtime); return { skillPickup: this.options.KazuhaPickupEnabled ? { issued: true } : null, scan: this.options.PickDropsAfterFightEnabled ? { issued: true } : null }; },
  };
  return { runtime, events, warnings, controller, advance: ms => { time += ms; }, resources: () => ({ captures, disposals }) };
}

test('parser preserves original defaults, property casing, duplicate indexes and character order', () => {
  const parsed = parseJsonCombatStrategy('{"aCtIoNs":[{"CHARACTER":"香菱","INDEX":2},{"Character":"香菱","Index":2},{"Character":"芙宁娜"}]}');
  assert.deepEqual(parsed.info, { name: '', author: '', config: null, preActions: [] });
  assert.deepEqual(parsed.avatarNames, ['香菱', '芙宁娜']);
  assert.deepEqual(parsed.actions[0], { name: '', character: '香菱', action: '', index: 2, ensureCast: false, condition: { expression: '' }, morePriorities: [] });
  assert.equal(parsed.kind, 'json');
  assert.doesNotThrow(() => strategy([action('相同', '', { Index: 1 }), action('相同', '', { Index: 1 })]));
});

test('parser accepts Newtonsoft comments/trailing commas/single quotes/unquoted keys without damaging strings', () => {
  const parsed = parseJsonCombatStrategy("{ // comment\n Info: {Name:'a // b /* c */', Author:'A\\'B', Config:{url:'https://a/b', path:'C:\\\\dir'},}, Actions: [{Name:'开场-e-一', Action:'wait(1)',},],}");
  assert.equal(parsed.name, 'a // b /* c */'); assert.equal(parsed.info.author, "A'B");
  assert.deepEqual(parsed.info.config, { url: 'https://a/b', path: 'C:\\dir' });
  assert.equal(parsed.actions[0].name, '开场-e-一');
  assert.equal(parseJsonCombatStrategy('\uFEFF{"Actions":[{}]}').actions.length, 1);
});

test('parser validates source action-name grammar but defers command/expression semantics until execution', () => {
  for (const name of ['TRUE', 'last-exec', '1', '开 场', 'a_b', 'a,b', 'a+b']) assert.throws(() => strategy([action(name)]), /动作名称/);
  const parsed = strategy([action('合法-e-名字', 'not-a-command', { Condition: { Expression: 'impossible @@ expression' } })]);
  assert.equal(parsed.actions[0].action, 'not-a-command');
  assert.equal(parsed.actions[0].condition.expression, 'impossible @@ expression');
});

test('parser handles CLR primitive conversions and ignores unknown fields', () => {
  const parsed = parseJsonCombatStrategy('{"Unknown":1,"Info":{"Name":12,"Author":true,"PreActions":null},"Actions":[{"Index":"-2","EnsureCast":"TrUe","Action":3,"Name":null,"Character":null,"Condition":{"Expression":null},"MorePriorities":[{"Priority":0}]}]}');
  assert.equal(parsed.info.name, '12'); assert.equal(parsed.info.author, 'True');
  assert.deepEqual(parsed.info.preActions, []); assert.equal(parsed.actions[0].index, -2); assert.equal(parsed.actions[0].ensureCast, true);
  assert.equal(parsed.actions[0].action, '3'); assert.equal(parsed.actions[0].condition.expression, null);
});

test('parser rejects structurally invalid/null models and incomplete JSON', () => {
  for (const value of ['null', '[]', '{}', '{"Info":null,"Actions":[{}]}', '{"Actions":null}', '{"Actions":[]}', '{"Actions":[null]}', '{"Actions":[{"Condition":null}]}', '{"Actions":[{"MorePriorities":null}]}', '{"Info":{"PreActions":1},"Actions":[{}]}', '{"Actions":[{"Index":2147483648}]}', '{"Actions":[{"EnsureCast":"yes"}]}', '{/*oops', '{"Actions":[{}],"Info":{"Name":"oops}}']) assert.throws(() => parseJsonCombatStrategy(value), undefined, value);
});

test('load reads actual file and names fallback to filename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bgi-json-fight-'));
  try {
    const filename = path.join(root, 'actual.JSON'); await writeFile(filename, '{"Actions":[{}]}');
    const parsed = await loadJsonCombatStrategy(filename);
    assert.equal(parsed.filename, filename); assert.equal(parsed.name, 'actual');
    await assert.rejects(loadJsonCombatStrategy(path.join(root, 'missing.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('pinned import has no JSON combat corpus; parser/model fixtures are source-backed examples', async () => {
  const root = new URL('../../third_party/bettergi/scripts/repo/combat/', import.meta.url);
  const entries = await readdir(root, { recursive: true });
  assert.equal(entries.some(name => name.toLowerCase().endsWith('.json')), false);
  const model = await readFile(new URL('../../third_party/bettergi/source/BetterGenshinImpact/GameTask/AutoFight/Script/JsonCombatStrategy.cs', import.meta.url), 'utf8');
  for (const key of ['PreActions', 'EnsureCast', 'MorePriorities', 'Character', 'Expression']) assert.match(model, new RegExp('\\b' + key + '\\b'));
});

test('team-filtered empty actions produce no-action receipt with no fake completed/end observation', async () => {
  const { runtime, events, resources } = setup();
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('不在队伍', 'check', { Character: '钟离' })]) });
  assert.equal(result.completion, 'noAvailableActions'); assert.equal(result.completed, false); assert.equal(result.ended, false); assert.equal(result.timedOut, false);
  assert.deepEqual(events, []); assert.deepEqual(resources(), { captures: 0, disposals: 0 });
});

test('MorePriorities use stable priority scheduling and history records real action index', async () => {
  const { runtime, resources } = setup();
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([
    action('开场', 'wait(0.01)', { Index: 10, Condition: { Expression: 'false' }, MorePriorities: [{ Expression: 'count()=0', Priority: -1 }] }),
    action('结束', 'check', { Index: 1, Condition: { Expression: 'count(开场)=1' } }),
  ]) });
  const result = await task.start();
  assert.equal(result.ended, true); assert.equal(result.timedOut, false); assert.equal(result.nodesExecuted, 2); assert.equal(result.priorityEntries, 3);
  assert.deepEqual(task.evaluator.history.map(({ index, name }) => [index, name]), [[10, '开场'], [1, '结束']]);
  assert.deepEqual(resources(), { captures: 2, disposals: 2 });
});

test('equal priority preserves declaration order and main-before-more order', async () => {
  const { runtime } = setup();
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([
    action('甲', 'jump', { Index: 0, Condition: { Expression: 'count()=0' }, MorePriorities: [{ Expression: 'count()=1', Priority: 0 }] }),
    action('乙', 'check', { Index: 0, Condition: { Expression: 'count(甲)=2' } }),
  ]) });
  const result = await task.start();
  assert.equal(result.nodesExecuted, 3); assert.deepEqual(task.evaluator.history.map(event => event.name), ['甲', '甲', '乙']);
});

test('generic action starts with first team member, separate from active screen state', async () => {
  const { runtime, events } = setup();
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('通用', 'jump,check', { Condition: { Expression: '!onfield()' } })]) });
  const result = await task.start();
  assert.equal(result.ended, true); assert.equal(task.currentAvatarName, '芙宁娜');
  assert.deepEqual(events.filter(event => event[0] === 'switch').map(event => event[1]), ['芙宁娜', '芙宁娜']);
});

test('preactions include timeout/battle time, preserve private current avatar and reset shared check time afterward', async () => {
  const { runtime, events } = setup({ options: { Timeout: .1 } });
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('结束')], { PreActions: ['香菱 jump'] }) });
  const result = await task.start();
  assert.equal(result.timedOut, true); assert.equal(result.ended, false); assert.equal(result.preActionsExecuted, 1); assert.equal(result.nodesExecuted, 0);
  assert.equal(task.currentAvatarName, '芙宁娜'); assert.ok(runtime.state.fightStartAt >= 300);
  assert.ok(await task.evaluator.evaluate('t>0.3', 1));
  assert.ok(events.some(event => event[0] === 'switch' && event[1] === '香菱'));
});

test('preactions reuse pipe/round LineCommands but ignore round scheduling, as original executor does', async () => {
  const { runtime, events } = setup();
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('结束')], { PreActions: ['round(2),jump|round(3),jump'] }) });
  assert.equal(result.ended, true); assert.equal(result.preActionsExecuted, 2);
  assert.equal(events.filter(event => event[0] === 'input' && event[1] === 'keyPress' && event[2][0] === 'VK_SPACE').length, 2);
});

test('JSON action uses LinePart, so pipe separators are not silently promoted to full-script rotations', async () => {
  const { runtime } = setup();
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('坏命令', 'jump|check')]) });
  await assert.rejects(task.start(), /未知的方法/);
  assert.equal(task.evaluator.history.length, 0);
});

test('named actions require observed switch success before macro input', async () => {
  const { runtime, events } = setup({ switchResult: false, options: { Timeout: .002 } });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('切人', 'keypress(E)', { Character: '香菱' })]) });
  assert.equal(result.timedOut, true); assert.equal(result.nodesExecuted, 0);
  assert.equal(events.some(event => event[0] === 'input' && event[1] === 'keyPress'), false);
});

test('default fast check runs before switching and can stop all action input', async () => {
  const { runtime, events } = setup({ options: { FinishDetectConfig: { FastCheckEnabled: true, CheckAfterSwitchAvatar: false } }, finish: { checkNames: ['芙宁娜'], delayTimes: new Map([['芙宁娜', 1400]]) } });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('动作', 'jump', { Character: '香菱' })]) });
  assert.equal(result.ended, true); assert.equal(result.commandsExecuted, 0);
  assert.deepEqual(events.find(event => event[0] === 'check')[1], { delayTime: 1400, detectDelayTime: 50 });
  assert.equal(events.some(event => event[0] === 'switch'), false);
});

test('after-switch fast check shortens delay to 50ms only when character changes', async () => {
  for (const [character, expected] of [['香菱', 50], ['芙宁娜', 1400], ['', 1400]]) {
    const { runtime, events } = setup({ options: { FinishDetectConfig: { FastCheckEnabled: true, CheckAfterSwitchAvatar: true } }, finish: { checkNames: ['芙宁娜'], delayTimes: new Map([['芙宁娜', 1400]]) } });
    const result = await runAutoFightJson(runtime, { strategy: strategy([action('动作', 'jump', { Character: character })]) });
    assert.equal(result.commandsExecuted, 0); assert.equal(events.find(event => event[0] === 'check')[1].delayTime, expected);
    if (character) assert.ok(events.findIndex(event => event[0] === 'switch') < events.findIndex(event => event[0] === 'check'));
  }
});

test('fast checks use shared last-check seconds, including strategy check updates', async () => {
  const { runtime, events } = setup({ options: { FinishDetectConfig: { FastCheckEnabled: true } }, finish: { checkTime: .001 } });
  await runAutoFightJson(runtime, { strategy: strategy([action('等待', 'wait(.01)', { Condition: { Expression: 'count()=0' } }), action('结束', 'jump', { Index: 1 })]) });
  assert.equal(events.filter(event => event[0] === 'check').length, 1);
  assert.equal(events.filter(event => event[0] === 'input' && event[1] === 'keyPress' && event[2][0] === 'VK_SPACE').length, 0);
});

test('check is opt-in to finish detection and stops later subcommands only after observed true', async () => {
  const { runtime, events } = setup();
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('结束', 'check,keypress(E)')]) });
  assert.equal(result.ended, true); assert.equal(result.commandsExecuted, 1);
  assert.equal(events.some(event => event[0] === 'input' && event[1] === 'keyPress'), false);
  const disabled = setup({ options: { FightFinishDetectEnabled: false, Timeout: .003 } });
  const timeout = await runAutoFightJson(disabled.runtime, { strategy: strategy([action('继续', 'check,keypress(E)')]) });
  assert.equal(timeout.timedOut, true); assert.equal(timeout.ended, false);
  assert.equal(disabled.events.some(event => event[0] === 'check'), false);
});

test('no met conditions wait 200ms and finish as timeout without rotation-limit success', async () => {
  const { runtime, events } = setup({ options: { Timeout: .4 } });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('条件不成立', 'jump', { Condition: { Expression: 'false' } })]) });
  assert.equal(result.completed, true); assert.equal(result.ended, false); assert.equal(result.timedOut, true); assert.equal(result.completion, 'timeout');
  assert.equal(result.nodesExecuted, 0); assert.equal(runtime.state.rotationCount, 0);
  assert.deepEqual(events.filter(event => event[0] === 'sleep').map(event => event[1]), [200, 200]);
});

test('JSON ignores TXT manual-CD scheduler/rotation stop and keeps priority starvation behavior', async () => {
  const { runtime } = setup({ options: { Timeout: .015, ActionSchedulerByCd: '芙宁娜,999', BattleThresholdForLoot: 999 } });
  runtime.state.team[0].manualSkillCd = 999;
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('高优先', 'jump'), action('饿死', 'check', { Index: 1 })]) });
  const result = await task.start();
  assert.equal(result.timedOut, true); assert.ok(result.nodesExecuted > 6);
  assert.ok(task.evaluator.history.every(event => event.name === '高优先'));
});

test('EnsureCast retries whole action at most five times with source cooldown observation, one history event', async () => {
  const { runtime, events, resources } = setup({ cooldowns: [false, false, true] });
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('技能', 'keypress(E)', { Index: 0, EnsureCast: true, Condition: { Expression: 'count()=0' } }), action('结束', 'check', { Index: 1 })]) });
  const result = await task.start();
  assert.equal(result.ended, true); assert.equal(result.castObservations[0].observed, true); assert.equal(result.castObservations[0].retries, 2);
  assert.equal(events.filter(event => event[0] === 'input' && event[1] === 'keyPress' && event[2][0] === 'E').length, 3);
  assert.equal(events.filter(event => event[0] === 'input' && event[1] === 'leftButtonClick').length, 2);
  assert.equal(task.evaluator.history.filter(event => event.name === '技能').length, 1);
  assert.equal(resources().captures, resources().disposals);
});

test('EnsureCast exhausted observations surface failure and never enter successful action history', async () => {
  const { runtime, events, resources } = setup({ cooldowns: [false], options: { Timeout: 100 } });
  const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('失败', 'keypress(E)', { EnsureCast: true })]) });
  await assert.rejects(task.start(), { code: 'ENSURE_CAST_UNOBSERVED', retries: 5 });
  assert.equal(events.filter(event => event[0] === 'cooldown').length, 6);
  assert.equal(events.filter(event => event[0] === 'input' && event[1] === 'keyPress' && event[2][0] === 'E').length, 6);
  assert.equal(task.evaluator.history.length, 0); assert.equal(runtime.state.fightActive, false);
  assert.equal(events.some(event => event[0] === 'pickup'), false); assert.equal(resources().captures, resources().disposals);
});

test('observed fight end inside EnsureCast retries stops retrying and is not claimed as cast evidence', async () => {
  let checks = 0;
  const { runtime, events } = setup({ cooldowns: [false] });
  runtime.checkFight = async () => ++checks > 1;
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('重试中结束', 'keypress(E),check', { EnsureCast: true })]) });
  assert.equal(result.ended, true); assert.equal(result.castObservations[0].observed, false); assert.equal(result.castObservations[0].reason, 'fightEndObserved');
  assert.equal(events.filter(event => event[0] === 'cooldown').length, 1);
});

test('fight end before EnsureCast skips further skill attempts', async () => {
  const { runtime, events } = setup({ cooldowns: [false] });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('已结束', 'check', { EnsureCast: true })]) });
  assert.equal(result.ended, true); assert.deepEqual(result.castObservations, []);
  assert.equal(events.some(event => event[0] === 'cooldown'), false);
});

test('targeting cleanup completes before pickup, independent of experience worker', async () => {
  const { runtime, events } = setup({ experience: true, options: { EnableCombatTargeting: true, KazuhaPickupEnabled: true, ExpBasedPickupEnabled: true } });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('结束')]) });
  assert.equal(result.experienceObserved, true);
  const pickupAt = events.findIndex(event => event[0] === 'pickup');
  assert.ok(events.findIndex(event => event[0] === 'stop' && event[1] === 'targeting') < pickupAt);
  assert.ok(events.findIndex(event => event[0] === 'stop' && event[1] === 'experience') < pickupAt);
  assert.equal(events.filter(event => event[0] === 'stop' && event[1] === 'targeting').length, 1);
  assert.equal(runtime.state.fightActive, false);
});

test('unobserved experience waits 1100ms, skips only skill pickup and retains timed scan', async () => {
  const { runtime, events } = setup({ options: { KazuhaPickupEnabled: true, ExpBasedPickupEnabled: true, PickDropsAfterFightEnabled: true } });
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('结束')]) });
  assert.equal(result.experienceObserved, false); assert.equal(result.pickup.skipped, 'experienceNotObserved');
  assert.equal(result.pickup.skillPickup, null); assert.deepEqual(result.pickup.scan, { issued: true });
  assert.equal(events.filter(event => event[0] === 'sleep' && event[1] === 100).length, 11);
  assert.equal(runtime.options.KazuhaPickupEnabled, true, 'shared runtime options preserved');
});

test('action/cancellation/retry failure releases input, stops both workers and propagates original despite cleanup errors', async () => {
  for (const failure of [new Error('input failed'), Object.assign(new Error('cancel'), { name: 'AbortError' }), Object.assign(new Error('revival'), { code: 'PATH_RETRY' })]) {
    const { runtime, events, warnings, resources } = setup({ options: { EnableCombatTargeting: true, KazuhaPickupEnabled: true, ExpBasedPickupEnabled: true },
      onInput: method => { if (method === 'keyPress') throw failure; if (method === 'releaseAll') throw new Error('release failed'); }, onStop: () => { throw new Error('stop failed'); } });
    const task = new AutoFightJsonTask(runtime, { strategy: strategy([action('失败', 'keypress(E)')]) });
    await assert.rejects(task.start(), error => error === failure);
    assert.equal(task.evaluator.history.length, 0); assert.equal(runtime.state.fightActive, false);
    assert.equal(events.filter(event => event[0] === 'stop').length, 2); assert.ok(warnings.length >= 3);
    assert.equal(resources().captures, resources().disposals); assert.equal(events.some(event => event[0] === 'pickup'), false);
  }
});

test('cancellation during preactions cleans state and experience even before targeting starts', async () => {
  const { runtime, controller, events } = setup({ options: { EnableCombatTargeting: true, KazuhaPickupEnabled: true, ExpBasedPickupEnabled: true }, onSleep: () => controller.abort(new Error('stop preactions')) });
  await assert.rejects(runAutoFightJson(runtime, { strategy: strategy([action('结束')], { PreActions: ['wait(.1)'] }) }), /stop preactions/);
  assert.equal(runtime.state.fightActive, false); assert.ok(events.some(event => event[0] === 'input' && event[1] === 'releaseAll'));
  assert.ok(events.some(event => event[0] === 'stop' && event[1] === 'experience'));
  assert.equal(events.some(event => event[0] === 'background' && event[1] === 'targeting'), false);
});

test('background failure and cleanup-only failure prevent successful receipts', async () => {
  const first = setup(); first.runtime.backgroundFailure = new Error('targeting crashed');
  await assert.rejects(runAutoFightJson(first.runtime, { strategy: strategy([action('结束')]) }), /targeting crashed/);
  const second = setup({ onStop: kind => { if (kind === 'movements') throw new Error('movement cleanup failed'); } });
  await assert.rejects(runAutoFightJson(second.runtime, { strategy: strategy([action('结束')]) }), /movement cleanup failed/);
  assert.equal(second.events.some(event => event[0] === 'pickup'), false);
});

test('composes with real AutoFightTask lifecycle and native commands without circular imports', async () => {
  let time = 0; const events = [];
  const host = { now: () => time, sleep: async ms => { time += ms; }, input: async (method, args) => events.push([method, args]), vision: async () => {}, signal: new AbortController().signal };
  const runtime = new AutoFightTask(host, { config: { KazuhaPickupEnabled: false, PickDropsAfterFightEnabled: false } }, { team: [{ name: '芙宁娜', index: 1 }], skillTracker: new Map() });
  runtime.captured = async body => body({ handle: 'real-runtime-test' });
  runtime.switchAvatar = async () => true; runtime.checkFight = async () => true; runtime.seeker.stopMovements = async () => {};
  const result = await runAutoFightJson(runtime, { strategy: strategy([action('本体', 'jump,check')]) });
  assert.equal(result.ended, true); assert.equal(result.commandsExecuted, 2);
  assert.ok(events.some(([method, args]) => method === 'keyPress' && args[0] === 'VK_SPACE'));
});
