// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONDITION_FUNCTION_NAMES, ConditionEvaluator, isValidActionName } from './fight-condition.mjs';

function setup(options = {}) {
  let time = 1000, captures = 0, disposals = 0;
  const calls = [], warnings = [], controller = new AbortController();
  const runtime = {
    state: { team: [{ name: '芙宁娜', index: 1, manualSkillCd: 999 }, { name: '香菱', index: 2 }], skillTracker: new Map(), lastActiveIndex: 1, lastFightCheckAt: 500 },
    host: { now: () => time, signal: controller.signal, log: (...args) => warnings.push(args),
      vision: async (op, args) => { calls.push([op, args]); return options.vision ? options.vision(op, args) : op === 'fight.qReady' ? { readyIndexes: [2] } : op === 'party.lowHp'; } },
    async captured(body) { captures++; try { return await body({ handle: 'owned-' + captures }); } finally { disposals++; } },
    async active(frame, context) { context.rounds = (context.rounds ?? 0) + 1; if (context.rounds > 1) { this.state.lastActiveIndex = 1; return 1; } return -2; },
  };
  const evaluator = new ConditionEvaluator(runtime, { actionNames: ['芙芙-e-开场', '香菱', '另一个', 'First'] });
  return { runtime, evaluator, calls, warnings, controller, advance(ms) { time += ms; }, resources: () => ({ captures, disposals }) };
}

test('function inventory matches the pinned original ConditionEvaluator source', async () => {
  const source = await readFile(new URL('../../third_party/bettergi/source/BetterGenshinImpact/GameTask/AutoFight/Script/ConditionEvaluator.cs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('FunctionNames ='), source.indexOf('/// <summary>', source.indexOf('FunctionNames =')));
  assert.deepEqual([...block.matchAll(/"([a-z-]+)"/g)].map(match => match[1]), CONDITION_FUNCTION_NAMES);
});

test('action names use the source identifier grammar and reject reserved names', () => {
  const valid = ['芙芙-e-开场', '香菱', 'First', 'E-1-2', '甲-乙-丙'];
  for (const name of valid) assert.equal(isValidActionName(name, valid), true, name);
  for (const name of ['', 'true', 'FALSE', 'e-ready', 'T', 'min', '123', '甲 乙', '甲_乙', '甲,乙', 'a+b', '-a', '甲/乙']) assert.equal(isValidActionName(name, valid), false, name);
  assert.equal(isValidActionName('a-b', []), false);
});

test('source precedence, numeric conversions, equality tolerance and zero division', async () => {
  const { evaluator: e } = setup();
  for (const expression of ['1+2*3=7', '(1+2)*3=9', '!(-1)', 'true+false=1', '1/0=0', '.5*2=1', '1.00001=1', 'false || 2>1 && true', '3>2=1', 'MIN(9,3+1)=4', 'max()=min()']) assert.equal(await e.evaluate(expression, 1), true, expression);
  for (const expression of ['-1', 'false', '1.001=1', 'TRUE', '1..2', '1>=1', '1==1', '1&&&2', '(', '1 @ 2']) assert.equal(await e.evaluate(expression, 1), false, expression);
  assert.equal(await e.evaluate('1e2', 1), true, 'source reads 1 then ignores trailing identifier e2; exponent notation is not parsed');
  assert.equal(await e.evaluate('true false', 1), true, 'original does not demand End token');
  assert.equal(await e.evaluate('   ', 1), true);
  assert.equal(await e.evaluate(null, 1), true);
});

test('logical short circuit avoids unknown functions and vision calls', async () => {
  const { evaluator: e, calls, warnings } = setup();
  assert.equal(await e.evaluate('true || doesnotexist()', 1), true);
  assert.equal(await e.evaluate('false && low-hp()', 1), false);
  assert.deepEqual(calls, []); assert.deepEqual(warnings, []);
  assert.equal(await e.evaluate('doesnotexist()', 1), false);
  assert.equal(warnings.length, 1);
});

test('hyphenated builtins/actions take longest known identifier, subtraction remains subtraction', async () => {
  const { evaluator: e, advance } = setup();
  e.updateLastExecTime(5, '芙芙-e-开场'); advance(7000);
  assert.equal(await e.evaluate('t-5=2', 1), true);
  assert.equal(await e.evaluate('since(芙芙-e-开场)-3=4', 1), true);
  assert.equal(await e.evaluate('last-exec(6,true,芙芙-e-开场)', 1), true);
});

test('battle-time uses seconds and strict comparison; greater accepts literal Bool AST only', async () => {
  const { evaluator: e, advance } = setup(); advance(5000);
  assert.equal(await e.evaluate('t=5 && battle-time(4) && battle-time(6,false)', 1), true);
  assert.equal(await e.evaluate('battle-time(5)', 1), false);
  assert.equal(await e.evaluate('battle-time(5,false)', 1), false);
  assert.equal(await e.evaluate('battle-time(4,0)', 1), true);
  assert.equal(await e.evaluate('battle-time(6,!true)', 1), false);
  assert.equal(await e.evaluate('battle-time()', 1), false);
});

test('history defaults strictly match both index and name with duplicate indexes', async () => {
  const { evaluator: e, advance } = setup();
  e.updateLastExecTime(7, 'First'); advance(1000);
  e.updateLastExecTime(7, '另一个'); advance(2000);
  assert.equal(await e.evaluate('since()=3 && count()=1', 7, null, 'first'), true);
  assert.equal(await e.evaluate('since()=2 && count()=1', 7, null, '另一个'), true);
  assert.equal(await e.evaluate('since(7)=2 && count(7)=2', 99), true);
  assert.equal(await e.evaluate('since(1+6)=2 && since(7.9)=2', 99), true);
  assert.equal(await e.evaluate('since(FIRST)=3 && count(first)=1', 99), true);
  assert.equal(await e.evaluate('since()>999 && count()=0', 7, null, ''), true);
  assert.equal(await e.evaluate('count()=2', 7), true);
});

test('count windows are inclusive and numeric functions accept nested history', async () => {
  const { evaluator: e, advance } = setup();
  e.updateLastExecTime(2, '香菱'); advance(1000); e.updateLastExecTime(2, '香菱'); advance(1000); e.updateLastExecTime(2, '香菱');
  assert.equal(await e.evaluate('count(香菱,0,1)=2 && count(2,1,2)=2', 1), true);
  assert.equal(await e.evaluate('count(2,2,1)=0', 1), true);
  assert.equal(await e.evaluate('min(since(2),5)=0 && max(since(2),3)=3', 1), true);
});

test('unseen targets, name typos and builtin bare target names preserve source behavior', async () => {
  const { evaluator: e, advance } = setup(); advance(2000);
  assert.equal(await e.evaluate('since(香菱)>10000 && last-exec(1,true,香菱)', 1), true);
  assert.equal(await e.evaluate('last-exec(1,false,香菱)', 1), false);
  assert.equal(await e.evaluate('since(拼错名)>1', 1), false);
  assert.equal(await e.evaluate('last-exec(1,true,拼错名)', 1), false);
  assert.equal(await e.evaluate('since(t)>1', 1), false);
  e.updateLastExecTime(1, 'First'); advance(1000);
  assert.equal(await e.evaluate('last-exec(1)', 1, null, 'First'), false);
  assert.equal(await e.evaluate('last-exec(1,false)', 1, null, 'First'), false);
  assert.equal(await e.evaluate('last-exec(2,0)', 1, null, 'First'), false, 'numeric flag uses default greater=true');
});

test('E readiness uses persistent OCR tracker, is case-insensitive and ignores manual CD', async () => {
  const { evaluator: e, runtime, advance } = setup();
  runtime.state.skillTracker.set('First', 5000);
  assert.equal(await e.evaluate('e-ready()', 1, '芙宁娜'), true);
  assert.equal(await e.evaluate('e-cd(first)=4 && !e-ready(FIRST)', 1), true);
  assert.equal(await e.evaluate('e-ready()', 1), false);
  assert.equal(await e.evaluate('e-ready() && e-cd()=0', 1, ''), true);
  advance(5000); assert.equal(await e.evaluate('e-ready(First) && e-cd(First)=0', 1), true);
});

test('Q and HP share caller-owned capture, cache each loop, and Q omits active refresh', async () => {
  const { evaluator: e, runtime, calls, resources } = setup();
  e.setCachedCapture({ handle: 'loop' });
  assert.equal(await e.evaluate('q-ready(香菱) && !q-ready(芙宁娜) && low-hp() && low-hp()', 1), true);
  assert.equal(await e.evaluate('q-ready()', 1), true, 'null character means any team member');
  assert.equal(await e.evaluate('q-ready()', 1, ''), false, 'empty character matches none');
  assert.deepEqual(calls, [['fight.qReady', { handle: 'loop', activeIndex: 1 }], ['party.lowHp', { handle: 'loop' }]]);
  assert.deepEqual(resources(), { captures: 0, disposals: 0 });
  runtime.state.lastActiveIndex = 0; e.setCachedCapture({ handle: 'next' });
  assert.equal(await e.evaluate('q-ready(香菱)', 1), true);
  assert.deepEqual(calls.at(-1), ['fight.qReady', { handle: 'next', activeIndex: 0 }]);
});

test('uncached vision releases captures and low-HP errors cache false per loop', async () => {
  const { evaluator: e, resources, calls } = setup({ vision: async op => { if (op === 'party.lowHp') throw new Error('OCR unavailable'); return { readyIndexes: [] }; } });
  assert.equal(await e.evaluate('low-hp()', 1), false);
  assert.equal(await e.evaluate('low-hp()', 1), false);
  assert.deepEqual(resources(), { captures: 1, disposals: 1 }); assert.equal(calls.length, 1);
  e.setCachedCapture(null); assert.equal(await e.evaluate('low-hp()', 1), false);
  assert.deepEqual(resources(), { captures: 2, disposals: 2 });
});

test('in-party and onfield follow exact source names, persistent active recognition context', async () => {
  const { evaluator: e, runtime, resources } = setup(); runtime.state.lastActiveIndex = 0;
  assert.equal(await e.evaluate('in-party(芙宁娜) && !in-party(芙芙)', 1), true);
  assert.equal(await e.evaluate('in-party(1)', 1), false);
  assert.equal(await e.evaluate('onfield()', 1, '芙宁娜'), false);
  assert.equal(await e.evaluate('onfield()', 1, '芙宁娜'), true);
  assert.equal(await e.evaluate('onfield()', 1, '香菱'), false);
  assert.equal(await e.evaluate('onfield()', 1, ''), false);
  assert.deepEqual(resources(), { captures: 2, disposals: 2 });
});

test('last-check reads shared check time instead of local battle start', async () => {
  const { evaluator: e, runtime, advance } = setup(); advance(2000);
  assert.equal(await e.evaluate('last-check()=2.5', 1), true);
  runtime.state.lastFightCheckAt = runtime.host.now();
  assert.equal(await e.evaluate('last-check()=0', 1), true);
});

test('cancellation and retry signals propagate instead of becoming false conditions', async () => {
  const aborted = setup(); aborted.controller.abort(new Error('user stopped'));
  await assert.rejects(aborted.evaluator.evaluate('true', 1), /user stopped/);
  for (const failure of [Object.assign(new Error('cancel'), { name: 'AbortError' }), Object.assign(new Error('revival'), { code: 'PATH_RETRY' })]) {
    const { evaluator } = setup({ vision: async () => { throw failure; } });
    await assert.rejects(evaluator.evaluate('low-hp()', 1), error => error === failure);
  }
});
