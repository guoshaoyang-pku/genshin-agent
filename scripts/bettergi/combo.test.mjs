import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { AutoComboTask, ComboTreeSession, buildComboSession, observeComboParty, comboSkillCooldowns } from './combo.mjs';
import { CombatTasks } from './combat.mjs';
import { createComboBuilder } from './combo-build.mjs';
import { ComboNode, Status } from './combo-tree.mjs';
import { loadComboResources } from './combo-resources.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const resources = await loadComboResources(sourceRoot);
const names = ['钟离', '行秋', '香菱', '班尼特'];
const avatars = () => names.map((name, i) => ({ name, index: i + 1, manualSkillCd: -1, lastSkillAt: -Infinity, ocrReadyAt: -Infinity, indexRect: { x: 1800, y: 256 + 96 * i, width: 28, height: 24 } }));
const config = { PlanningLlmEndpoint: 'http://localhost:5000/v1', ModelName: 'fixture' };
function modelResponse(calls = []) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args], i) => ({ id: String(i), type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } })) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }), { status: 200 });
}
function buildFixture() {
  const events = [], requests = [], previews = [], team = avatars();
  let inDomain = false, mainUi = true;
  const host = { sourceRoot, log: (...args) => events.push(['log', ...args]) };
  const combat = {
    host, state: { team },
    async captured(body) { return body({ handle: 1 }); },
    async find(frame, group, name) { return inDomain && name === 'InDomain' ? { x: 1, width: 10, height: 10 } : null; },
    async isInMainUi() { return mainUi; },
    async returnMainUi() { events.push(['returnMainUi']); },
    async initializeTeam(options) { events.push(['initializeTeam', options]); return team; },
  };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (body.messages.some(message => message.role === 'tool')) return modelResponse();
    const fallback = body.messages[1].content.includes('兜底');
    return modelResponse([...(fallback ? [] : [['Sequence', { name: '主序列' }]]), ['Attack', { name: '普攻', avatarName: names[0] }], ['BuildTree']]);
  };
  const options = { combat, resources, fetch, onPreview: preview => previews.push(preview) };
  return { host, combat, events, requests, previews, team, options, set inDomain(value) { inDomain = value; }, set mainUi(value) { mainUi = value; } };
}
function completedBuilder(team, fallback = false) {
  const builder = createComboBuilder(team, { resources, fallback });
  if (!fallback) builder.invoke('Sequence', { name: 'main' });
  builder.invoke('Attack', { name: 'attack', avatarName: team[0].name });
  assert.match(builder.invoke('BuildTree').message, /成功/);
  return builder;
}
function runFixture({ start = 100000, team = avatars(), controller = new AbortController() } = {}) {
  let time = start; const events = [];
  const host = {
    signal: controller.signal, sourceRoot, now: () => time,
    async sleep(ms) { events.push(['sleep', ms]); time += ms; await yieldToEvents(); },
    async input(method, args = []) { events.push([method, ...args]); },
    async vision(op, args) { events.push([op, args]); return {}; },
    log: (...args) => events.push(['log', ...args]),
  };
  const blackboard = new Map([['stale', true]]);
  const session = { avatars: team, blackboard, builtAt: 'fixture', async bindAndBuild() { return { comboTree: new ComboNode('main', async () => Status.Running), fallbackTree: new ComboNode('fallback', async () => Status.Running) }; } };
  return { host, controller, events, session, get time() { return time; }, set time(value) { time = value; } };
}

test('build observes party and constructs independent original main and fallback trees', async () => {
  const f = buildFixture(), session = await buildComboSession(f.host, config, f.options);
  assert.ok(session instanceof ComboTreeSession); assert.equal(session.avatars, f.team);
  assert.equal(session.builder.blackboard, session.fallbackBuilder.blackboard);
  assert.equal(session.builder.root.type, 'Sequence'); assert.equal(session.fallbackBuilder.root.name, '兜底攻击序列');
  assert.equal(f.requests.length, 4); assert.equal(f.requests[0].body.tools.length, 22); assert.equal(f.requests[2].body.tools.length, 7);
  assert.equal(f.requests[0].url, config.PlanningLlmEndpoint + '/chat/completions');
  assert.ok(f.requests[0].body.messages[0].content.includes('钟离'));
  assert.deepEqual(f.events[0], ['returnMainUi']);
  assert.deepEqual(f.events.find(event => event[0] === 'initializeTeam')[1], { force: true, requireObserved: true });
  assert.ok(f.team.every(avatar => avatar.enableESkillClassify));
  assert.deepEqual(f.previews.filter(item => item.complete).map(item => item.fallback), [false, true]);
});

test('observed party receipt separates game observation from background network build', async () => {
  const f = buildFixture(), observedTeam = await observeComboParty(f.host, { combat: f.combat });
  const before = f.events.length;
  await buildComboSession(f.host, config, { ...f.options, observedTeam });
  assert.ok(!f.events.slice(before).some(([op]) => op === 'returnMainUi' || op === 'initializeTeam'));
  await assert.rejects(buildComboSession(f.host, config, { ...f.options, observedTeam: { avatars: f.team } }), /observed party receipt/);
});

test('build accepts recognized domain, validates UI before party and never substitutes a forced team', async () => {
  const f = buildFixture(); f.inDomain = true; f.mainUi = false;
  await buildComboSession(f.host, config, f.options); assert.ok(!f.events.some(event => event[0] === 'returnMainUi'));
  const invalid = buildFixture(); invalid.mainUi = false;
  await assert.rejects(buildComboSession(invalid.host, config, invalid.options), /无法识别队伍角色/);
  assert.ok(!invalid.events.some(event => event[0] === 'initializeTeam')); assert.equal(invalid.requests.length, 0);
  const observed = avatars(), read = [];
  const host = {
    sourceRoot, async capture() { return { handle: 1, width: 1920, height: 1080 }; },
    async vision(op) { read.push(op); if (op === 'party.recognize') return { avatars: observed, indexRects: observed.map(avatar => avatar.indexRect) }; if (op === 'image.dispose') return null; throw new Error(op); },
  };
  const catalog = { avatars: observed, aliases: new Map(names.map(name => [name, name])) };
  const combat = new CombatTasks(host, { TeamNames: '不存在,不存在,不存在,不存在' }, { catalog });
  assert.deepEqual((await combat.initializeTeam({ force: true, requireObserved: true })).map(avatar => avatar.name), names);
  assert.deepEqual(read, ['party.recognize', 'image.dispose']);
});

test('fallback build failure degrades to first-party Attack while cancellation propagates', async () => {
  const f = buildFixture(), original = f.options.fetch;
  f.options.fetch = async (url, options) => JSON.parse(options.body).messages[1].content.includes('兜底') ? new Response('fixture unavailable', { status: 503 }) : original(url, options);
  const session = await buildComboSession(f.host, config, f.options);
  assert.equal(session.fallbackBuilder.root.children[0].avatarName, names[0]);
  assert.ok(f.previews.some(preview => preview.complete && preview.fallback && preview.degraded));
  assert.ok(f.events.some(event => event[0] === 'log' && event[1] === 'warn'));
  const canceled = buildFixture(), originalCanceled = canceled.options.fetch, controller = new AbortController(); canceled.host.signal = controller.signal;
  canceled.options.fetch = async (url, options) => {
    if (JSON.parse(options.body).messages[1].content.includes('兜底')) { controller.abort(); controller.signal.throwIfAborted(); }
    return originalCanceled(url, options);
  };
  await assert.rejects(buildComboSession(canceled.host, config, canceled.options), { name: 'AbortError' });
  assert.ok(!canceled.previews.some(preview => preview.degraded)); assert.ok(canceled.previews.some(preview => preview.failed));
});

test('failed main build reports preview and never attempts fallback or degrades', async () => {
  const f = buildFixture(); let calls = 0;
  f.options.fetch = async () => { calls++; return new Response('failure', { status: 502 }); };
  await assert.rejects(buildComboSession(f.host, config, f.options), /HTTP 502/);
  assert.equal(calls, 1); assert.ok(f.previews.some(preview => preview.failed)); assert.ok(!f.previews.some(preview => preview.fallback));
});

test('session rebind retains original avatar instances and indices, updates rectangles and resets transient state', async () => {
  const team = avatars(), blackboard = new Map([['stale', 1]]), tracker = new Map([['玛薇卡', 999]]);
  for (const avatar of team) Object.assign(avatar, { lastSkillAt: 1000, ocrReadyAt: 2000, isBurstReady: true, manualSkillCd: 7, enableESkillClassify: false });
  const observed = team.slice().reverse().map((avatar, i) => ({ name: avatar.name, index: i + 1, indexRect: { x: i + 1, width: 1, height: 1 } }));
  const combat = { state: { team: observed, skillTracker: tracker }, async initializeTeam(options) { assert.deepEqual(options, { force: true, requireObserved: true }); return observed; } };
  const session = new ComboTreeSession({ avatars: team, builder: completedBuilder(team), fallbackBuilder: completedBuilder(team, true), blackboard, builtAt: 'kept' });
  const first = await session.bindAndBuild(combat), second = await session.bindAndBuild(combat);
  assert.equal(combat.state.team, team); assert.equal(combat.state.team[0], team[0]); assert.deepEqual(team.map(avatar => avatar.index), [1, 2, 3, 4]);
  assert.equal(team[0].indexRect, observed[3].indexRect); assert.equal(combat.state.skillTracker, tracker); assert.equal(tracker.get('玛薇卡'), 999);
  assert.ok(team.every(avatar => avatar.lastSkillAt === -Infinity && avatar.ocrReadyAt === -Infinity && !avatar.isBurstReady && avatar.manualSkillCd === 7 && avatar.enableESkillClassify));
  assert.equal(blackboard.size, 0); assert.notEqual(first.comboTree, second.comboTree); assert.notEqual(first.comboTree.children[0], second.comboTree.children[0]); assert.notEqual(first.fallbackTree, second.fallbackTree);
  assert.equal(session.builtAt, 'kept');
  observed[0].name = '迪卢克';
  await assert.rejects(session.bindAndBuild(combat), /队伍成员与当前游戏内队伍不一致/);
});

test('run checks finish only between complete rounds and ignores timeout and pickup', async () => {
  const f = runFixture(); let mainTicks = 0, checks = 0;
  f.session.bindAndBuild = async () => ({ comboTree: new ComboNode('main', async () => ++mainTicks % 2 ? Status.Running : Status.Success), fallbackTree: new ComboNode('fallback', async () => { throw new Error('not expected'); }) });
  const task = new AutoComboTask(f.host, { session: f.session, config: { Timeout: 0, PickDropsAfterFightEnabled: true, FinishDetectConfig: { FastCheckParams: '0' } } });
  task.checkFight = async args => { checks++; assert.deepEqual(args, { delayTime: 400, detectDelayTime: 400 }); return checks === 2; };
  task.pickup = async () => { throw new Error('not expected'); };
  const result = await task.start();
  assert.deepEqual(result, { paused: false, ended: true, ticks: 3, team: names, builtAt: 'fixture' });
  assert.equal(mainTicks, 2); assert.equal(checks, 2); assert.deepEqual(f.events.filter(event => event[0] === 'sleep'), [['sleep', 35], ['sleep', 35]]);
  assert.equal(task.state.fightActive, false); assert.equal(f.session.blackboard.size, 0); assert.deepEqual(f.events.at(-1), ['releaseAll']);
});

test('host-controlled run preempts fallback reactively and cancellation returns a pause receipt', async () => {
  const f = runFixture({ start: 200000 }), visited = []; let mainTicks = 0, fallbackTicks = 0, fallbackStops = 0;
  f.session.bindAndBuild = async () => ({ comboTree: new ComboNode('main', async () => ++mainTicks === 1 ? Status.Failure : Status.Success), fallbackTree: new ComboNode('fallback', async () => { fallbackTicks++; return Status.Running; }, { terminate: () => fallbackStops++ }) });
  const task = new AutoComboTask(f.host, { session: f.session, taskConfig: { fightFinishDetectEnabled: false }, config: { Timeout: 0 }, onSnapshot: snapshot => { if (snapshot.kind === 'tree') { visited.push(snapshot); if (snapshot.ticks === 2) f.controller.abort(); } } });
  task.checkFight = async () => { throw new Error('not expected'); };
  const result = await task.run();
  assert.equal(result.paused, true); assert.equal(result.ended, false); assert.equal(result.ticks, 2);
  assert.equal(mainTicks, 2); assert.equal(fallbackTicks, 1); assert.equal(fallbackStops, 1);
  assert.equal(visited[0].fallbackTree.visited, true); assert.equal(visited[1].fallbackTree.status, Status.Invalid);
  assert.ok(f.events.some(event => event[0] === 'sleep' && event[1] === 35));
  assert.deepEqual(f.events.at(-1), ['releaseAll']);
});

test('cleanup awaits targeting and overlay workers before movement and input release', async () => {
  const f = runFixture({ start: 300000 }), order = [];
  const task = new AutoComboTask(f.host, { session: f.session, taskConfig: { FightFinishDetectEnabled: false }, config: { EnableCombatTargeting: true }, onSnapshot: snapshot => { if (snapshot.kind === 'tree') f.controller.abort(); } });
  const intervals = [];
  task.background = (body, interval, options) => { const kind = options?.cleanup ? 'targeting' : 'overlay'; intervals.push([kind, interval, options]); return { async stop() { order.push(kind + ':start'); await yieldToEvents(); order.push(kind + ':done'); } }; };
  task.seeker.stopMovements = async () => { order.push('movements'); };
  f.host.input = async method => { order.push(method); };
  const result = await task.run();
  assert.equal(result.paused, true); assert.deepEqual(intervals, [['targeting', 50, { cleanup: true }], ['overlay', 100, undefined]]);
  assert.deepEqual(order, ['targeting:start', 'targeting:done', 'overlay:start', 'overlay:done', 'movements', 'releaseAll']);
  assert.equal(f.events[0][0], 'party.resetTargetTracker');
});

test('targeting errors are logged while combo ticks continue and worker cleanup finishes', async () => {
  const f = runFixture({ start: 400000 }); let ticks = 0;
  f.host.capture = async () => { throw new Error('fixture targeting failure'); };
  const task = new AutoComboTask(f.host, { session: f.session, taskConfig: { FightFinishDetectEnabled: false }, config: { EnableCombatTargeting: true }, onSnapshot: snapshot => { if (snapshot.kind === 'tree' && ++ticks === 3) f.controller.abort(); } });
  const result = await task.run();
  assert.equal(result.paused, true); assert.equal(result.ticks, 3);
  assert.match(task.backgroundFailure.message, /fixture targeting failure/);
  assert.ok(f.events.some(event => event[0] === 'log' && event[1] === 'error'));
  assert.ok(f.events.some(event => event[0] === 'middleButtonClick')); assert.deepEqual(f.events.at(-1), ['releaseAll']);
});

test('noncancellation failure still clears state and releases input; missing session is actionable', async () => {
  const f = runFixture({ start: 500000 });
  f.session.bindAndBuild = async () => { throw new Error('bad observed party'); };
  const task = new AutoComboTask(f.host, { session: f.session });
  await assert.rejects(task.start(), /bad observed party/); assert.equal(task.state.fightActive, false); assert.equal(f.session.blackboard.size, 0); assert.deepEqual(f.events.at(-1), ['releaseAll']);
  await assert.rejects(new AutoComboTask(f.host).start(), /尚未构建行为树，请先运行一次自动连招任务完成建树/);
});

test('Mavuika cleanup switches every other party avatar using an uncanceled host', async () => {
  const team = avatars(); team[1].name = '玛薇卡';
  const f = runFixture({ start: 600000, team }), switches = [], original = CombatTasks.prototype.switchAvatar;
  try {
    CombatTasks.prototype.switchAvatar = async function (args) { switches.push(args.name); assert.equal(this.host.signal, null); return true; };
    const task = new AutoComboTask(f.host, { session: f.session, taskConfig: { FightFinishDetectEnabled: false }, onSnapshot: snapshot => { if (snapshot.kind === 'tree') f.controller.abort(); } });
    const result = await task.run(); assert.equal(result.paused, true); assert.deepEqual(switches, ['钟离', '香菱', '班尼特']);
  } finally { CombatTasks.prototype.switchAvatar = original; }
});

test('cooldown snapshots preserve manual, OCR, ready and unknown states', () => {
  const template = { name: '钟离', index: 1, manualSkillCd: -1, lastSkillAt: 1000, ocrReadyAt: 0 };
  const team = [{ ...template, manualSkillCd: 3 }, { ...template, ocrReadyAt: 4500 }, { ...template }, { ...template, lastSkillAt: -Infinity, ocrReadyAt: -Infinity }];
  assert.deepEqual(comboSkillCooldowns(team, 2500).map(item => item.seconds), [1.5, 2, null, 0]);
  assert.deepEqual(comboSkillCooldowns(team, 9000).map(item => item.seconds), [0, 0, null, 0]);
});
