import test from 'node:test';
import assert from 'node:assert/strict';
import { ComboComposite, ComboNode, Status, burstReady, createComboNode, recordedSkillState, skillState } from './combo-tree.mjs';

const { Invalid, Running, Success, Failure } = Status;
const node = (name, update, terminate) => new ComboNode(name, update, { terminate });
function fixture() {
  let time = 0, active = 1, captures = 0;
  const events = [], contexts = [];
  const avatar = { name: '钟离', nameEn: 'Zhongli', index: 1, manualSkillCd: 0, lastSkillAt: -Infinity, ocrReadyAt: -Infinity, skillCD: 4 };
  const host = {
    now: () => time,
    async sleep(ms) { time += ms; events.push(['sleep', ms]); },
    async input(method, args = []) { events.push([method, ...args]); },
    async vision(op, args) { events.push([op, args]); return op === 'party.skill' ? { state: 'Ready', code: '01', cd: 0 } : op === 'party.burst' ? { state: 'Ready' } : { ready: true }; },
  };
  const combat = {
    host, state: { team: [avatar] },
    async captured(body) { captures++; return body({ handle: captures }); },
    async active(frame, context) { contexts.push(context); return active; },
    async switchAvatar(args) { events.push(['switch', args.name]); active = avatar.index; },
    async useSkill(args) { events.push(['E', args]); },
    async useBurst(args) { events.push(['Q', args]); return { issued: false }; },
    record(name, cd) { events.push(['record', name, cd]); },
    async call(operation, args) { return this[operation](args); },
  };
  return { host, combat, avatar, events, contexts, get captures() { return captures; }, set time(value) { time = value; }, set active(value) { active = value; } };
}
const spec = (type, extra = {}) => ({ type, name: type, avatarName: '钟离', ...extra });

test('leaf lifecycle distinguishes terminal, running and handoff without termination', async () => {
  let initialized = 0, ticks = 0; const terminated = [], visited = new Set();
  const leaf = new ComboNode('leaf', async () => ++ticks === 2 ? Success : Running, { initialize: () => initialized++, terminate: status => terminated.push(status) });
  assert.equal(await leaf.tick(visited), Running); assert.equal(await leaf.tick(visited), Success);
  assert.equal(initialized, 1); assert.deepEqual(terminated, [Success]);
  assert.equal(await leaf.tick(visited), Running); assert.equal(initialized, 2);
  assert.equal(await leaf.handoff(visited), Invalid); assert.deepEqual(terminated, [Success]);
  assert.equal(await leaf.handoff(visited), Invalid); assert.ok(visited.has(leaf));
  assert.equal(await leaf.tick(), Running); assert.equal(initialized, 3);
});

test('memory sequences resume child while reactive guards invalidate dangling runners', async () => {
  for (const memory of [true, false]) {
    let permitted = true, guards = 0, work = 0; const stopped = [];
    const guard = node('guard', async () => { guards++; return permitted ? Success : Failure; });
    const runner = node('runner', async () => { work++; return Running; }, status => stopped.push(status));
    const sequence = new ComboComposite('Sequence', 's', [guard, runner], { memory });
    assert.equal(await sequence.tick(), Running); permitted = false;
    assert.equal(await sequence.tick(), memory ? Running : Failure);
    assert.equal(guards, memory ? 1 : 2); assert.equal(work, memory ? 2 : 1);
    assert.deepEqual(stopped, memory ? [] : [Invalid]);
    sequence.stop(Invalid); permitted = true;
    assert.equal(await sequence.tick(), Running); assert.equal(guards, memory ? 2 : 3);
    assert.equal(sequence.current, runner);
  }
  assert.equal(await new ComboComposite('Sequence', 'empty', []).tick(), Success);
});

test('reactive selector preempts lower priority using Stop while memory resumes it', async () => {
  for (const memory of [true, false]) {
    let highReady = false, highTicks = 0; const stopped = [];
    const high = node('high', async () => { highTicks++; return highReady ? Success : Failure; });
    const low = node('low', async () => Running, status => stopped.push(status));
    const selector = new ComboComposite('Selector', 's', [high, low], { memory });
    assert.equal(await selector.tick(), Running); highReady = true;
    assert.equal(await selector.tick(), memory ? Running : Success);
    assert.equal(highTicks, memory ? 1 : 2); assert.equal(low.status, memory ? Running : Invalid);
    assert.deepEqual(stopped, memory ? [] : [Invalid]);
    if (memory) assert.equal(high.status, Invalid);
  }
  assert.equal(await new ComboComposite('Selector', 'empty', []).tick(), Failure);
});

test('parallel policies tick sequentially, synchronize success, prefer failure and stop runners', async () => {
  let firstTicks = 0, lastTicks = 0, finish = false;
  const first = node('first', async () => { firstTicks++; return Success; });
  const last = node('last', async () => { lastTicks++; return finish ? Success : Running; });
  const all = new ComboComposite('ParallelAll', 'all', [first, last]);
  assert.equal(await all.tick(), Running); finish = true;
  assert.equal(await all.tick(), Success); assert.equal(firstTicks, 1); assert.equal(lastTicks, 2); assert.equal(all.current, last);
  const order = [], stopped = [];
  const good = node('good', async () => { order.push('good'); return Success; });
  const bad = node('bad', async () => { order.push('bad'); return Failure; });
  const running = node('running', async () => { order.push('running'); return Running; }, status => stopped.push(status));
  const one = new ComboComposite('ParallelOne', 'one', [good, bad, running]);
  assert.equal(await one.tick(), Failure); assert.deepEqual(order, ['good', 'bad', 'running']);
  assert.equal(one.current, bad); assert.deepEqual(stopped, [Invalid]);
  const finalSuccess = node('last success', async () => Success);
  const winner = new ComboComposite('ParallelOne', 'winner', [good, running, finalSuccess]);
  assert.equal(await winner.tick(), Success); assert.equal(winner.current, finalSuccess); assert.equal(running.status, Invalid);
  assert.equal(await new ComboComposite('ParallelAll', '', []).tick(), Success);
  assert.equal(await new ComboComposite('ParallelOne', '', []).tick(), Success);
});

test('handoff advances all running parallel children and preserves pending unwind', async () => {
  const stopped = []; let handoffs = 0;
  const slow = node('slow', async () => Running, status => stopped.push(status));
  slow.handoff = async () => ++handoffs < 2 ? slow.status : (slow.status = Invalid);
  const ordinary = node('ordinary', async () => Running, status => stopped.push(status));
  const parallel = new ComboComposite('ParallelAll', '', [slow, ordinary]);
  await parallel.tick(); assert.equal(await parallel.handoff(), Running); assert.equal(ordinary.status, Invalid);
  assert.equal(await parallel.handoff(), Invalid); assert.equal(handoffs, 2); assert.deepEqual(stopped, []);
});

test('recorded skill tri-state uses manual equality and strict OCR expiry without inferred maximum', () => {
  const avatar = { manualSkillCd: 2, lastSkillAt: 1000, ocrReadyAt: 99000 };
  assert.equal(recordedSkillState(avatar, 2999), 'Cooldown'); assert.equal(recordedSkillState(avatar, 3000), 'Ready');
  avatar.manualSkillCd = -1; avatar.ocrReadyAt = 3000;
  assert.equal(recordedSkillState(avatar, 3000), 'Cooldown'); assert.equal(recordedSkillState(avatar, 3001), 'Ready');
  avatar.ocrReadyAt = 1000; assert.equal(recordedSkillState(avatar, 99999), 'Unknown');
  avatar.ocrReadyAt = avatar.lastSkillAt = -Infinity; assert.equal(recordedSkillState(avatar, 0), 'Ready');
});

test('active E reads classifier and records only original-ready or positive OCR while manual bypasses capture', async () => {
  const f = fixture(); f.time = 1000; f.avatar.lastSkillAt = 500;
  assert.equal(await skillState(f.combat, f.avatar), 'Ready'); assert.equal(f.avatar.ocrReadyAt, 1000);
  assert.equal(f.events.find(event => event[0] === 'party.skill')[1].onlyCode01Ready, true);
  f.host.vision = async () => ({ state: 'Ready', code: '03', cd: 0 }); f.time = 1500;
  assert.equal(await skillState(f.combat, f.avatar, false), 'Ready'); assert.equal(f.avatar.ocrReadyAt, 1000);
  f.host.vision = async () => ({ state: 'Cooldown', code: '01', cd: 4 });
  assert.equal(await skillState(f.combat, f.avatar), 'Cooldown'); assert.equal(f.avatar.ocrReadyAt, 5500);
  assert.deepEqual(f.events.at(-1), ['record', '钟离', 4]);
  assert.notEqual(f.contexts[0], f.contexts[1]);
  const captures = f.captures; f.avatar.manualSkillCd = 1; f.time = 1500;
  assert.equal(await skillState(f.combat, f.avatar), 'Ready'); assert.equal(f.captures, captures);
});

test('unknown E condition switches and rechecks without mutating usage; cooldown conditional has no input', async () => {
  const f = fixture(); f.active = 2; f.avatar.lastSkillAt = 100;
  const condition = createComboNode(spec('IsSkillReady'), f.combat);
  assert.equal(await condition.tick(), Success); assert.deepEqual(f.events.filter(event => event[0] === 'switch'), [['switch', '钟离']]);
  assert.equal(f.avatar.lastSkillAt, 100); assert.ok(!f.events.some(event => event[0] === 'E'));
  f.avatar.manualSkillCd = 10; f.time = 1000; f.events.length = 0;
  assert.equal(await createComboNode(spec('UseSkillIfReady', { hold: false }), f.combat).tick(), Failure); assert.deepEqual(f.events, []);
  f.avatar.manualSkillCd = 0; f.avatar.ocrReadyAt = -Infinity; f.host.vision = async () => ({ state: 'Unknown' });
  assert.equal(await condition.tick(), Failure); assert.equal(f.avatar.lastSkillAt, 100);
});

test('burst always captures, caches inactive readiness only, rereads active and clears before cast', async () => {
  const f = fixture(); f.active = 2;
  assert.equal(await burstReady(f.combat, f.avatar), true); assert.equal(f.avatar.isBurstReady, true);
  const reads = f.events.length;
  assert.equal(await burstReady(f.combat, f.avatar), true); assert.equal(f.events.length, reads); assert.equal(f.captures, 2);
  f.active = 1; f.host.vision = async op => { f.events.push([op]); return { state: 'Unknown', ready: false }; };
  assert.equal(await burstReady(f.combat, f.avatar), false); assert.equal(f.avatar.isBurstReady, true);
  assert.equal(f.contexts[0], f.contexts[2]);
  f.events.length = 0;
  assert.equal(await createComboNode(spec('UseBurstIfReady'), f.combat).tick(), Failure); assert.ok(!f.events.some(event => ['switch', 'Q'].includes(event[0])));
  f.combat.useBurst = async () => { assert.equal(f.avatar.isBurstReady, false); return { issued: false }; };
  assert.equal(await createComboNode(spec('UseBurst'), f.combat).tick(), Success);
});

test('Attack switches once, uses pre-switch time and retains click spacing across reentry', async () => {
  const f = fixture(); f.combat.switchAvatar = async () => { f.events.push(['switch']); f.time = 500; };
  const attack = createComboNode(spec('Attack'), f.combat);
  assert.equal(await attack.tick(), Running); f.time = 1000;
  assert.equal(await attack.tick(), Success); assert.equal(f.events.filter(event => event[0] === 'leftButtonClick').length, 1);
  f.combat.switchAvatar = async () => f.events.push(['switch']);
  f.time = 1100; assert.equal(await attack.tick(), Running);
  f.time = 1299; await attack.tick(); assert.equal(f.events.filter(event => event[0] === 'leftButtonClick').length, 2);
  f.time = 1300; await attack.tick(); assert.equal(f.events.filter(event => event[0] === 'leftButtonClick').length, 3);
  attack.stop(Invalid); f.time = 1350; await attack.tick();
  assert.equal(f.events.filter(event => event[0] === 'leftButtonClick').length, 3);
  assert.equal(f.events.filter(event => event[0] === 'switch').length, 3);
});

test('blocking basic leaves reuse native command dispatch with one switch and paired held-input release', async () => {
  const f = fixture();
  for (const [type, extra, expected] of [
    ['Charge', {}, ['leftButtonDown', 'sleep', 'leftButtonUp']],
    ['Walk', { direction: 'w', seconds: .25 }, ['keyDown', 'sleep', 'keyUp']],
    ['Dash', { seconds: .4 }, ['rightButtonDown', 'sleep', 'rightButtonUp']],
    ['Jump', {}, ['keyPress']],
  ]) {
    f.events.length = 0; assert.equal(await createComboNode(spec(type, extra), f.combat).tick(), Success);
    assert.equal(f.events.filter(event => event[0] === 'switch').length, 1);
    assert.deepEqual(f.events.slice(1).map(event => event[0]), expected);
  }
  const controller = new AbortController(); f.host.signal = controller.signal;
  f.host.sleep = async () => controller.abort();
  await assert.rejects(createComboNode(spec('Walk', { direction: 'a', seconds: 1 }), f.combat).tick(), { name: 'AbortError' });
  assert.deepEqual(f.events.at(-1), ['keyUp', 'a']);
});

test('count windows cast once, skip failed children, tick one action and relax only matching avatar E', async () => {
  const f = fixture(), bb = new Map(), args = [];
  f.host.vision = async (op, options) => {
    if (op === 'party.skill') { args.push(options.onlyCode01Ready); return { state: options.onlyCode01Ready ? 'Ready' : 'Cooldown', code: '03' }; }
    return { state: 'Ready', ready: true };
  };
  const window = createComboNode(spec('UseSkillIfReadyThenDoActionsByCount', { hold: true, times: 2, children: [spec('IsSkillReady'), spec('Jump')] }), f.combat, bb);
  for (let i = 0; i < 4; i++) assert.equal(await window.tick(), i === 3 ? Success : Running);
  assert.deepEqual(args, [true, false, false]); assert.equal(f.events.filter(event => event[0] === 'E').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'keyPress').length, 2); assert.equal(bb.size, 0);
  assert.deepEqual(f.events.find(event => event[0] === 'E')[1], { name: '钟离', hold: true });
});

test('duration window finishes strictly after boundary and waits for running child completion', async () => {
  const f = fixture(), bb = new Map();
  const window = createComboNode(spec('UseBurstIfReadyThenDoActionsByDuration', { seconds: .5, children: [spec('Attack')] }), f.combat, bb);
  assert.equal(await window.tick(), Running); f.time = 600;
  assert.equal(await window.tick(), Running); assert.equal(bb.get('LeadCastingAvatar'), f.avatar);
  f.time = 1000; assert.equal(await window.tick(), Running);
  assert.equal(await window.tick(), Success); assert.equal(bb.size, 0);
  assert.equal(f.events.filter(event => event[0] === 'Q').length, 1);
  const exact = createComboNode(spec('UseBurstIfReadyThenDoActionsByDuration', { seconds: .5, children: [spec('Jump')] }), f.combat, bb);
  await exact.tick(); f.time = 1500; assert.equal(await exact.tick(), Running);
  f.time = 1501; assert.equal(await exact.tick(), Success);
});

test('window handoff avoids Terminate and reentry resets lead cast as source Initialize does', async () => {
  const f = fixture(), bb = new Map();
  const window = createComboNode(spec('UseSkillIfReadyThenDoActionsByCount', { hold: false, times: 1, children: [spec('Attack')] }), f.combat, bb);
  assert.equal(await window.tick(), Running); assert.equal(await window.handoff(), Invalid);
  assert.equal(bb.get('LeadCastingAvatar'), f.avatar);
  assert.equal(await window.tick(), Running); assert.equal(f.events.filter(event => event[0] === 'E').length, 2);
  window.stop(Invalid); assert.equal(bb.size, 0); assert.equal(window.children[0].status, Invalid);
});
