import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { TcgControl, TcgDuel, runAutoGeniusInvokation, resolveTcgStrategy } from './tcg.mjs';
import { loadAvatarCatalog, loadTcgCatalog, parseTcgScript } from './native.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const [cards, { aliases }] = await Promise.all([loadTcgCatalog(sourceRoot), loadAvatarCatalog(sourceRoot)]);
const button = { x: 100, y: 600, width: 101, height: 41 };
const areas = [[667, 632, 165, 282], [877, 632, 165, 282], [1088, 632, 165, 282]].map(([x, y, width, height]) => ({ x, y, width, height }));
const config = { sleepDelay: 0, activeCharacterCardSpace: 41, defaultCharacterCardRects: areas };

test('task strategy is case-insensitive and configured name loads original repository data', async () => {
  assert.equal(await resolveTcgStrategy({ sourceRoot }, { taskConfig: { StRaTeGy: 'original inline' } }), 'original inline');
  const expected = await readFile(new URL('../../third_party/bettergi/scripts/repo/tcg/莫娜砂糖琴.txt', import.meta.url), 'utf8');
  assert.equal(await resolveTcgStrategy({ sourceRoot }, { config: { AutoGeniusInvokationConfig: { StrategyName: '莫娜砂糖琴' } } }), expected);
  await assert.rejects(resolveTcgStrategy({ sourceRoot }, { taskConfig: { strategy: 7 } }), /string/);
  await assert.rejects(resolveTcgStrategy({ sourceRoot }, { taskConfig: { StrategyName: '../../../source/LICENSE' } }));
});
const prefix = '角色定义:\n角色1=莫娜|水{技能1=3水,技能2=3水,技能3=1水+2任}\n角色2=刻晴|雷{技能1=3雷,技能2=3雷,技能3=1雷+2任}\n角色3=迪卢克|火{技能1=3火,技能2=3火,技能3=1火+2任}\n策略定义:\n';
const content = (...commands) => prefix + commands.join('\n');
const dice = (count, element = 'omni') => ({ total: count, counts: Object.fromEntries(['anemo', 'electro', 'dendro', 'hydro', 'pyro', 'cryo', 'geo', 'omni'].map(key => [key, key === element ? count : 0])) });

function fixture(options = {}) {
  const controller = new AbortController(), images = new Set(), calls = [], inputs = [], logs = [], counts = new Map();
  let sequence = 0, time = 0;
  const host = {
    sourceRoot, signal: controller.signal, controller, images, calls, inputs, logs, counts, now: () => time, random: () => 0,
    async capture() {
      const frame = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080 };
      images.add(frame.handle); calls.push({ op: 'capture', at: time });
      await options.onCapture?.(host, frame); return frame;
    },
    async sleep(ms, signal = this.signal) {
      signal?.throwIfAborted(); calls.push({ op: 'sleep', ms, at: time });
      await options.onSleep?.(host, ms); signal?.throwIfAborted(); time += ms;
    },
    async input(method, args, signal = this.signal) {
      signal?.throwIfAborted(); inputs.push({ method, args, at: time, signal });
      await options.onInput?.(host, method, args);
    },
    async vision(op, args, signal = this.signal) {
      signal?.throwIfAborted(); calls.push({ op, args, at: time });
      if (op === 'image.dispose') { assert.ok(images.delete(args.handle), 'only allocated handles disposed'); await options.onDispose?.(host); return; }
      assert.ok(images.has(args.handle), 'observation borrows live capture');
      counts.set(op, (counts.get(op) ?? 0) + 1);
      const custom = await options.observe?.(op, args, host);
      if (custom !== undefined) return custom;
      if (op === 'tcg.ui') {
        const result = {};
        for (const name of args.names) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          result[name] = await options.ui?.(name, counts.get(name), host) ??
            (['ConfirmButton', 'InCharacterPick', 'RoundEndButton', 'ElementalTuningConfirmButton'].includes(name) ? button : null);
        }
        return result;
      }
      if (op === 'tcg.characterRects') return { rects: areas, method: 'originalRgbProjection' };
      if (op === 'tcg.rollDice') return { total: 8, upper: 4, lower: 4, matches: [] };
      if (op === 'tcg.actionDice') return dice(8);
      if (op === 'tcg.defeated') return { defeated: [false, false, false] };
      if (op === 'tcg.activeHp' || op === 'tcg.activeWord') return { index: 1, hp: 10, energy: 2, statuses: [], method: 'hpOcr' };
      if (op === 'tcg.diceCount') return { count: -10 };
      throw new Error('Unexpected vision: ' + op);
    },
    log(level, text) { logs.push({ level, text }); },
  };
  return host;
}
function duel(host, text = content('莫娜 使用 技能2')) {
  const value = new TcgDuel(parseTcgScript(text, { cards, aliases }), new TcgControl(host, config));
  value.rects = areas; value.characters.slice(1).forEach((character, i) => { character.area = areas[i]; });
  value.current = value.characters[1]; value.diceCount = 8; value.cardCount = 5;
  return value;
}
function clean(host) {
  assert.equal(host.images.size, 0); assert.equal(host.inputs.at(-1).method, 'releaseAll');
  assert.equal(host.inputs.at(-1).signal, null, 'cleanup overrides canceled host signal');
}

test('full prepare, roll, active OCR, skill and final turn return strategy exhaustion without win claim', async () => {
  const host = fixture();
  const result = await runAutoGeniusInvokation(host, { taskConfig: { StrategyContent: content('莫娜 使用 技能2') } });
  assert.equal(result.completion, 'strategyExhausted'); assert.equal(result.completed, true);
  assert.equal(result.verified, false); assert.equal(result.winnerVerified, false); assert.equal(result.rewardsVerified, false);
  assert.equal(result.remainingCommands, 0); assert.equal(result.roundsStarted, 1);
  assert.equal(result.diceCount, 5); assert.equal(result.actions[0].evidence, 'diceLackWarningAbsent');
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').slice(0, 7).map(call => call.ms), [1000, 3000, 1500, 200, 5000, 1000, 5000]);
  assert.equal(host.counts.get('RoundEndButton'), 6); assert.equal(host.counts.get('CharacterTakenOut'), 6);
  assert.deepEqual(host.inputs.filter(call => call.args?.[0] === 1720).map(call => call.args), [[1720, 960], [1720, 960]]); clean(host);
});

test('source burst wait is15seconds and Mona switch wait belongs to old active character', () => {
  const value = duel(fixture());
  assert.equal(value.waitTime({ action: 'UseSkill', targetIndex: 1, character: value.characters[2] }), 15000);
  assert.equal(value.waitTime({ action: 'SwitchLater', targetIndex: 2, character: value.characters[1] }), 3000);
  assert.equal(value.waitTime({ action: 'SwitchLater', targetIndex: 1, character: value.characters[2] }), 10000);
});

test('prediction budgets switches, negative clamped diceDelta and original adjacent queue including defeated', () => {
  const value = duel(fixture(), content('莫娜 使用 技能2 骰子减少5', '刻晴 使用 技能2', '迪卢克 使用 技能2'));
  value.diceCount = 4; assert.deepEqual(value.predictDice(), ['Omni', 'Hydro', 'Electro']);
  assert.deepEqual(value.control.diceOrder.slice(0, 3), ['electro', 'hydro', 'omni']);
  value.characters[1].isDefeated = true; value.diceCount = 3;
  assert.deepEqual(value.predictDice(), ['Omni']);
});

test('switch leaves skill queued, debits one die and records old character', async () => {
  const host = fixture(), value = duel(host, content('刻晴 使用 技能2'));
  const action = await value.action();
  assert.equal(action.action, 'SwitchLater'); assert.equal(action.character.index, 1); assert.equal(action.targetIndex, 2);
  assert.equal(value.queue.length, 1); assert.equal(value.diceCount, 7);
  assert.deepEqual(host.inputs.map(call => call.args), [[960, 540], [959, 773], [1820, 960], [1820, 960]]);
  assert.equal(host.images.size, 0);
});

test('action status skips, OCR difference1..4 corrects and difference>4 is discarded', async () => {
  for (const [count, expected] of [[6, 3], [2, 5], [-10, 5]]) {
    const host = fixture({ observe(op) { if (op === 'tcg.diceCount') return { count }; } });
    const value = duel(host); value.control.autoUseSkill = async () => true;
    assert.equal((await value.action()).action, 'UseSkill'); assert.equal(value.diceCount, expected);
  }
  const host = fixture({ observe(op) { if (op === 'tcg.activeHp') return { index: 1, hp: 10, energy: 0, statuses: ['Frozen'] }; } });
  const value = duel(host); assert.equal(await value.action(), null); assert.equal(value.queue.length, 1);
});

test('skill budget delta changes debit while specific tuning cost stays original', async () => {
  const value = duel(fixture(), content('莫娜 使用 技能2 骰子减少9'));
  let args; value.control.autoUseSkill = async (...values) => { args = values; return true; };
  await value.action(); assert.equal(value.diceCount, 8); assert.equal(args[1], 3); assert.equal(args[2], 'Hydro');
});

test('Keqing E alternates source hand-card estimate plus1 then minus1', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.activeHp') return { index: 2, hp: 10, energy: 0, statuses: [] }; } });
  const value = duel(host, content('刻晴 使用 技能2', '刻晴 使用 技能2'));
  value.control.autoUseSkill = async () => true; await value.action(); assert.equal(value.cardCount, 6);
  await value.action(); assert.equal(value.cardCount, 5); assert.equal(value.diceCount, 2);
});

test('failed skill keeps queue and source reset delay', async () => {
  const host = fixture(), value = duel(host); value.control.autoUseSkill = async () => false;
  assert.equal(await value.action(), null); assert.equal(value.queue.length, 1); assert.equal(value.diceCount, 8);
  assert.equal(host.calls.at(-1).ms, 1000); assert.deepEqual(host.inputs.at(-1).args, [960, 540]);
});

test('six source nine-dice observations correct model with explicit heuristic evidence', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.actionDice') return dice(9); } }), value = duel(host);
  assert.equal(await value.control.autoUseSkill(2, 3, 'Hydro', value), true);
  assert.equal(host.counts.get('tcg.actionDice'), 6); assert.equal(value.diceCount, 9);
  assert.deepEqual(value.evidence.diceCorrections[0], { method: 'sourceNineDiceHeuristic', from: 8, to: 9, observations: 6 });
});

test('dice mismatch without qualifying omni reaches original22observations timeout', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.actionDice') return dice(9, 'pyro'); } }), value = duel(host);
  await assert.rejects(value.control.autoUseSkill(2, 3, 'Hydro', value), /骰子数量/);
  assert.equal(host.counts.get('tcg.actionDice'), 22); assert.equal(host.images.size, 0);
});

test('tuning uses original count-specific coordinates and tries alternatives left to right', async () => {
  let confirms = 0;
  const host = fixture({ observe(op, args) { if (op === 'tcg.ui' && args.names[0] === 'ElementalTuningConfirmButton') return { ElementalTuningConfirmButton: ++confirms === 2 ? button : null }; } });
  const control = new TcgControl(host, config); assert.equal(await control.tuningAlternatives(8), true);
  const cardsClicked = host.inputs.filter(call => call.method === 'click' && call.args[1] === 1030);
  assert.deepEqual(cardsClicked.map(call => call.args), [[960, 1030], [600, 1030], [745, 1030]]);
  assert.equal(host.inputs.filter(call => call.method === 'leftButtonDown').length, 2);
  assert.equal(host.inputs.filter(call => call.method === 'leftButtonUp').length, 2);
  assert.equal(await control.tuningAlternatives(11), false);
});

test('tuning specific cost burns correct cards and retains source double-omni rule', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.actionDice') return { ...dice(8, 'pyro'), counts: { ...dice(8, 'pyro').counts, pyro: 7, omni: 1 } }; } });
  const value = duel(host); let tuned = 0; value.control.tuningAlternatives = async () => { tuned++; return true; };
  value.control.useSkill = async () => true;
  assert.equal(await value.control.autoUseSkill(2, 3, 'Hydro', value), true); assert.equal(tuned, 2); assert.equal(value.cardCount, 3);
  tuned = 0; assert.equal(await value.control.autoUseSkill(3, 2, 'Omni', value), true); assert.equal(tuned, 0);
  value.cardCount = 1; assert.equal(await value.control.autoUseSkill(2, 3, 'Hydro', value), false);
});

test('my-turn requires three cumulative observations even with intervening misses', async () => {
  let roundChecks = 0; const host = fixture({ observe(op, args) {
    if (op === 'tcg.ui' && args.names[0] === 'RoundEndButton') return { RoundEndButton: ++roundChecks % 2 ? button : null };
  } });
  const value = duel(host); await value.control.waitForMyTurn(value);
  assert.equal(roundChecks, 5); assert.equal(host.calls.filter(call => call.op === 'sleep').length, 4);
});

test('my-turn timeout retains60poll bound and opponent needs fourth empty observation', async () => {
  const host = fixture({ observe(op, args) { if (op === 'tcg.ui') return Object.fromEntries(args.names.map(name => [name, null])); } });
  const value = duel(host); await assert.rejects(value.control.waitForMyTurn(value), /超时/);
  assert.equal(host.counts.get('tcg.ui'), 120);
  host.calls.length = 0; await value.control.waitOpponentAction(value);
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').map(call => call.ms), [3001, 1001, 1001, 1001]);
});

test('defeat switch order follows remaining unique commands and skips defeated', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.defeated') return { defeated: [true, true, false] }; } });
  const value = duel(host, content('刻晴 使用 技能2', '刻晴 使用 技能1', '迪卢克 使用 技能2'));
  await value.control.whenDefeated(value);
  assert.deepEqual(host.inputs.map(call => call.args), [[1170, 773], [1170, 773], [960, 540]]);
  assert.deepEqual(value.characters.slice(1).map(character => character.isDefeated), [true, true, false]);
});

test('active HP failure uses exactly two white-word attempts with300ms retry', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.activeHp') return { index: null }; if (op === 'tcg.activeWord') return { index: null }; } });
  const value = duel(host); await assert.rejects(value.control.activeCharacter(value), /出战角色/);
  assert.equal(host.counts.get('tcg.activeWord'), 2); assert.deepEqual(host.calls.filter(call => call.op === 'sleep').map(call => call.ms), [300]);
});

test('reroll uses8dice and4plus4layout, selects only nonheld and source36failure bound', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.rollDice') return { total: 8, upper: 4, lower: 4, matches: [
    { element: 'hydro', x: 100, y: 200, width: 60, height: 60 }, { element: 'pyro', x: 300, y: 600, width: 60, height: 60 }] }; } });
  await new TcgControl(host, config).reroll(['Hydro', 'Omni']);
  assert.deepEqual(host.inputs[0].args, [330, 630]);
  const bad = fixture({ observe(op) { if (op === 'tcg.rollDice') return { total: 8, upper: 5, lower: 3, matches: [] }; } });
  await assert.rejects(new TcgControl(bad, config).reroll(['Omni']), /超时/);
  assert.equal(bad.counts.get('tcg.rollDice'), 36); assert.equal(bad.images.size, 0);
});

test('observed exit button and exhausted future strategy have distinct terminal evidence', async () => {
  const host = fixture({ observe(op, args) {
    if (op === 'tcg.rollDice') return { total: 0, upper: 0, lower: 0, matches: [] };
    if (op === 'tcg.ui' && args.names[0] === 'ExitDuelButton') return { ExitDuelButton: button };
  } });
  const result = await runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') });
  assert.equal(result.completion, 'exitDuelButtonObserved'); assert.deepEqual(result.terminalObservation, button); clean(host);
  const value = duel(fixture()); value.queue.length = 0;
  await assert.rejects(value.control.whenDefeated(value), error => error.completion === 'noFutureStrategyCharacter');
});

test('round loop adds2cards, clears temporary status and preserves next queued command', async () => {
  let rolls = 0;
  const host = fixture({ observe(op, args) {
    if (op === 'tcg.rollDice') return ++rolls === 1 ? { total: 8, upper: 4, lower: 4, matches: [] } : { total: 0 };
    if (op === 'tcg.activeHp') return { index: 1, hp: 10, energy: 0, statuses: ['Frozen'] };
    if (op === 'tcg.ui' && args.names[0] === 'InOpponentAction') return { InOpponentAction: null };
    if (op === 'tcg.ui' && args.names[0] === 'RoundEndButton' && (host.counts.get('tcg.activeHp') ?? 0) > 0) return { RoundEndButton: null };
    if (op === 'tcg.ui' && args.names[0] === 'ExitDuelButton') return { ExitDuelButton: rolls > 1 ? button : null };
  } });
  const result = await runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') });
  assert.equal(result.roundNum, 2); assert.equal(result.roundsStarted, 2); assert.equal(result.cardCount, 7); assert.equal(result.remainingCommands, 1); clean(host);
});

test('config case-insensitive delay, rectangle fallback and original retry intervals', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.characterRects') return { rects: [] }; } });
  const result = await runAutoGeniusInvokation(host, { config: { autogeniusinvokationconfig: { sleepdelay: 17, activecharactercardspace: 44 } }, taskConfig: { strategycontent: content('莫娜 使用 技能2') } });
  assert.equal(result.characterRects.method, 'configuredFallback');
  const delays = host.calls.filter(call => call.op === 'sleep').map(call => call.ms);
  assert.deepEqual(delays.slice(0, 10), [1000, 17, 3000, 17, 1500, 17, 1500, 1500, 200, 5000]);
  assert.equal(host.calls.find(call => call.op === 'tcg.activeHp').args.activeCharacterCardSpace, 44); clean(host);
});

test('invalid resolution, missing characters, empty queue and missing skills fail before gameplay', async () => {
  for (const options of [{ width: 1280, height: 720 }, { text: prefix }, { text: content('莫娜 使用 技能0') },
    { text: '角色定义:\n角色3=迪卢克|火{技能2=3火}\n策略定义:\n迪卢克 使用 技能2' }]) {
    const host = fixture(options);
    await assert.rejects(runAutoGeniusInvokation(host, { strategyContent: options.text ?? content('莫娜 使用 技能2') }));
    assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); clean(host);
  }
});

test('cancel during capture allocation owns screenshot before abort check', async () => {
  const host = fixture({ onCapture(host) { host.controller.abort(); } });
  await assert.rejects(runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') }), { name: 'AbortError' }); clean(host);
});

test('cancel during tuning drag releases button with null signal before final releaseAll', async () => {
  const host = fixture({ observe(op) { if (op === 'tcg.actionDice') return dice(8, 'pyro'); },
    onInput(host, method) { if (method === 'moveMouseTo') host.controller.abort(); } });
  await assert.rejects(runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') }), { name: 'AbortError' });
  const up = host.inputs.find(call => call.method === 'leftButtonUp'); assert.ok(up); assert.equal(up.signal, null); clean(host);
});

test('inflight vision joins before disposal and canceled observation cannot issue late skill click', async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const host = fixture({ async observe(op) { if (op === 'tcg.activeHp') { entered(); await gate; return { index: 1, hp: 10, energy: 0, statuses: [] }; } } });
  const running = runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') });
  await started; host.controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.images.size, 1); assert.equal(host.inputs.some(call => call.method === 'releaseAll'), false);
  unblock(); await assert.rejects(running, { name: 'AbortError' });
  assert.equal(host.inputs.some(call => call.args?.[0] === 1720), false); clean(host);
});

test('observation failure preserves primary against disposal and release failures', async () => {
  const failure = new Error('original OCR error');
  const host = fixture({ observe(op) { if (op === 'tcg.activeHp') throw failure; },
    onDispose(host) { if (host.counts.get('tcg.activeHp')) throw new Error('dispose error'); },
    onInput(_host, method) { if (method === 'releaseAll') throw new Error('release error'); } });
  await assert.rejects(runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') }), error => error === failure && error.evidence.completed === false);
  assert.ok(host.logs.some(line => line.text.includes('dispose error'))); assert.ok(host.logs.some(line => line.text.includes('release error'))); clean(host);
});

test('release failure after strategy exhaustion prevents a false clean success', async () => {
  const failure = new Error('release transport error'), host = fixture({ onInput(_host, method) { if (method === 'releaseAll') throw failure; } });
  await assert.rejects(runAutoGeniusInvokation(host, { strategyContent: content('莫娜 使用 技能2') }), error => error === failure); clean(host);
});

test('original bundled strategy and card metadata run through existing parser unchanged', async () => {
  const text = await readFile(sourceRoot + '/BetterGenshinImpact/User/AutoGeniusInvokation/1.莫娜砂糖琴.txt', 'utf8');
  const parsed = parseTcgScript(text, { cards, aliases });
  const first = parsed.actionCommandQueue[0], host = fixture();
  const short = text.slice(0, text.indexOf('策略定义:')) + '策略定义:\n' + first.character.name + ' 使用 技能' + first.targetIndex;
  const result = await runAutoGeniusInvokation(host, { strategyContent: short });
  assert.equal(result.completion, 'strategyExhausted'); assert.equal(result.actions[0].targetIndex, first.targetIndex); clean(host);
});
