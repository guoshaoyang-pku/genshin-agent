import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_AVATAR, NativeTasks, UnsupportedNativeOperation, executeCombatScript,
  loadAvatarCatalog, loadMapCoordinates, loadRodNet, loadTcgCatalog, parseCombatScript, parseTcgScript,
  parseKeyMouseScript, playKeyMouseScript, targetOrientation, waypointDistance,
} from './native.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const resourceRoot = process.env.BETTERGI_SCRIPT_ROOT ?? path.join(project, 'third_party/bettergi/scripts');
const { aliases } = await loadAvatarCatalog(sourceRoot);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}
function fakeHost({ latency = 0, controller, onInput, onSleep } = {}) {
  let clock = 0;
  const calls = [], keys = new Set(), buttons = new Set(), combats = [];
  return {
    sourceRoot, calls, keys, buttons, combats, signal: controller?.signal,
    now: () => clock,
    async sleep(ms) { clock += ms; await onSleep?.(ms); },
    async input(method, args) {
      calls.push({ at: clock, method, args });
      const lower = method.toLowerCase();
      if (lower === 'keydown') keys.add(args[0]);
      if (lower === 'keyup') keys.delete(args[0]);
      const button = /^(left|right|middle)button(down|up)$/.exec(lower);
      if (button?.[2] === 'down') buttons.add(button[1]);
      if (button?.[2] === 'up') buttons.delete(button[1]);
      if (lower === 'releaseall') { keys.clear(); buttons.clear(); }
      clock += latency;
      await onInput?.(method, args);
    },
    async combat(method, args) {
      combats.push({ at: clock, method, args });
      if (method === 'currentAvatar') return '钟离';
      if (method === 'check') return false;
      if (method === 'isSkillReady') return true;
      if (method === 'initializeTeam') return [{ name: '钟离', index: 1 }];
    },
  };
}
function assertReleased(host) {
  assert.equal(host.calls.at(-1)?.method, 'releaseAll');
  assert.equal(host.keys.size, 0);
  assert.equal(host.buttons.size, 0);
}

test('all original combat strategies parse and dispatch through the original operations', async t => {
  const strategies = (await files(path.join(resourceRoot, 'repo/combat'))).filter(filename => filename.endsWith('.txt'));
  assert.equal(strategies.length, 20);
  let commands = 0, diagnostics = 0;
  for (const filename of strategies) {
    const script = parseCombatScript(await readFile(filename, 'utf8'), { aliases });
    const team = script.avatarNames.map((name, index) => ({ name, index: index + 1 }));
    const host = fakeHost();
    const result = await executeCombatScript(script, host, { team });
    assert.equal(result.executed + result.skipped, script.commands.length, filename);
    assertReleased(host);
    commands += script.commands.length; diagnostics += script.diagnostics.length;
  }
  assert.equal(commands, 4517);
  assert.equal(diagnostics, 1);
  t.diagnostic(strategies.length + ' original strategies, ' + commands + ' commands; visual combat adapters are recorded test doubles');
});

test('all original key/mouse recordings replay on a virtual clock', async t => {
  let count = 0, events = 0, duration = 0;
  for (const filename of (await files(path.join(resourceRoot, 'repo'))).filter(filename => filename.endsWith('.json'))) {
    const source = await readFile(filename, 'utf8');
    if (!source.includes('macroEvents')) continue;
    const script = parseKeyMouseScript(source);
    const host = fakeHost();
    const result = await playKeyMouseScript(script, host);
    assert.equal(result.events, script.events.length, filename);
    assert.equal(result.durationMs, Math.max(0, ...script.events.map(event => event.time)), filename);
    assertReleased(host);
    count++; events += result.events; duration += result.durationMs;
  }
  assert.equal(count, 90);
  assert.equal(events, 4624);
  t.diagnostic(count + ' original recordings, ' + events + ' events, ' + duration.toFixed(4) + 'ms virtual duration; no game input sent');
});

test('macro JSON options preserve strings, scale absolute coordinates and round relative DPI to even', () => {
  const source = '{ /* comment */ "info": {"x":100,"y":50,"width":1920,"height":1080,"recordDpi":2,"description":"https://example.test/*x*/,}",},"macroEvents":[{"type":2,"time":0,"mouseX":300,"mouseY":250},{"type":"MouseMoveBy","time":2,"mouseX":5,"mouseY":-5},{"type":3,"time":3,"mouseX":7,"mouseY":-7},],}';
  const script = parseKeyMouseScript(source, { width: 960, height: 540, x: 10, y: 20, dpi: 1 });
  assert.equal(script.info.description, 'https://example.test/*x*/,}');
  assert.deepEqual(script.events.map(event => [event.mouseX, event.mouseY]), [[110, 120], [2, -2], [4, -4]]);
  assert.throws(() => parseKeyMouseScript({ macroEvents: [{ type: 'Mystery', time: 0 }] }), /Unknown macro/);
  assert.throws(() => parseKeyMouseScript({ macroEvents: [{ type: 0, time: -1, keyCode: 65 }] }), /Negative/);
});

test('macro timing uses absolute event timestamps rather than adding input latency', async () => {
  const host = fakeHost({ latency: 40 });
  await playKeyMouseScript(parseKeyMouseScript({ macroEvents: [
    { type: 0, time: 0, keyCode: 87 }, { type: 1, time: 100, keyCode: 87 },
    { type: 6, time: 110, mouseY: -250 }, { type: 6, time: 200, mouseY: 119 },
  ] }), host);
  assert.deepEqual(host.calls.map(call => [call.at, call.method, call.args]), [
    [0, 'KeyDown', [87]], [100, 'KeyUp', [87]], [140, 'verticalScroll', [-2]], [200, 'releaseAll', []],
  ]);
});

test('macro errors and cancellation release remotely held inputs', async () => {
  const controller = new AbortController();
  const host = fakeHost({ controller, onSleep: () => controller.abort(new Error('cancel replay')) });
  await assert.rejects(playKeyMouseScript(parseKeyMouseScript({ macroEvents: [
    { type: 'KeyDown', time: 0, keyCode: 87 }, { type: 'KeyUp', time: 1000, keyCode: 87 },
  ] }), host), /cancel replay/);
  assertReleased(host);
  const failed = fakeHost({ onInput: method => { if (method === 'moveMouseBy') throw new Error('transport failed'); } });
  await assert.rejects(playKeyMouseScript(parseKeyMouseScript({ macroEvents: [{ type: 3, time: 0, mouseX: 1, mouseY: 2 }] }), failed), /transport failed/);
  assertReleased(failed);
});

test('recorded camera correction wraps angles and disposes captured images', async () => {
  const host = fakeHost(), calls = [];
  host.capture = async () => ({ handle: 'frame' });
  host.vision = async (op, args) => { calls.push([op, args]); return 359; };
  await playKeyMouseScript(parseKeyMouseScript({ macroEvents: [{ type: 3, time: 0, mouseX: 10, mouseY: 3, cameraOrientation: 1 }] }), host);
  assert.deepEqual(host.calls[0].args, [12, 3]);
  assert.deepEqual(calls.map(([op]) => op), ['map.cameraOrientation', 'image.dispose']);
  host.vision = async op => { if (op === 'map.cameraOrientation') throw new Error('unsupported orientation'); };
  await assert.rejects(playKeyMouseScript(parseKeyMouseScript({ macroEvents: [{ type: 3, time: 0, cameraOrientation: 1 }] }), host), /unsupported orientation/);
  assertReleased(host);
});

test('combat DSL keeps original aliases, round segments and no-prefix policy', () => {
  const script = parseCombatScript('钟离 round(1,3-5),e(hold),行走(s, 0.2)|round(2),普攻(0.2);钟离 跳跃', { aliases });
  assert.deepEqual(script.commands.map(command => command.method), ['skill', 'walk', 'attack', 'jump']);
  assert.deepEqual(script.commands[1].activatingRound, [1, 3, 4, 5]);
  assert.deepEqual(script.commands[2].activatingRound, [2]);
  assert.deepEqual(parseCombatScript('walk(s, 0.2)', { aliases, validate: false }).avatarNames, [CURRENT_AVATAR]);
  assert.deepEqual(parseCombatScript('attack', { aliases, defaultAvatarName: '钟离' }).avatarNames, ['钟离']);
  assert.throws(() => parseCombatScript('attack', { aliases }), /空格/);
  for (const source of ['钟离 aim', '钟离 walk(w)', '钟离 walk(w,0)', '钟离 round(3-1),attack', '钟离 scroll(0.5)', '钟离 keypress(not-a-key)', '钟离 walk(w,0.2']) {
    assert.throws(() => parseCombatScript(source, { aliases }), undefined, source);
  }
  const compatibility = parseCombatScript('流浪者 wait(0.2)charge(0.2)', { aliases });
  assert.equal(compatibility.commands.length, 1);
  assert.equal(compatibility.commands[0].method, 'wait');
  assert.equal(compatibility.diagnostics[0].ignoredSuffix, 'charge(0.2)');
});

test('combat timing, rounds, role skipping, skill tracking and raw mouse virtual keys', async () => {
  const host = fakeHost();
  const script = parseCombatScript('钟离 attack(0),attack(0.2),walk(s,0.1),dash,jump,charge(0.1),keypress(VK_LBUTTON),keypress(e)|round(2),attack;行秋 attack', { aliases });
  const result = await executeCombatScript(script, host, { team: [{ name: '钟离', index: 1 }] });
  assert.deepEqual(result, { executed: 8, skipped: 2, ended: false });
  assert.equal(host.calls.filter(call => call.method === 'leftButtonClick').length, 3);
  assert.equal(host.combats.filter(call => call.method === 'afterUseSkill').length, 1);
  assert.deepEqual(host.calls.filter(call => call.method === 'keyDown' || call.method === 'keyUp').map(call => call.args), [['s'], ['s']]);
  assert.equal(host.now(), 1000);
  assertReleased(host);
});

test('combat special charges retain original mouse trajectories and require complex adapters', async () => {
  const neuv = fakeHost();
  await executeCombatScript(parseCombatScript('那维莱特 charge(0.1)', { aliases }), neuv, { team: [{ name: '那维莱特', index: 1 }], dpi: 1.5 });
  assert.deepEqual(neuv.calls.filter(call => call.method === 'moveMouseBy').map(call => call.args), [[1500, 0], [1500, 0], [1500, 0]]);
  const chasca = fakeHost();
  await executeCombatScript(parseCombatScript('恰斯卡 charge(0.2)', { aliases }), chasca, { team: [{ name: '恰斯卡', index: 1 }] });
  assert.deepEqual(chasca.calls.filter(call => call.method === 'moveMouseBy').map(call => call.args), [...Array.from({ length: 7 }, () => [2500, 575]), [24, 0], [24, 0]]);
  const missing = fakeHost(); delete missing.combat;
  await assert.rejects(executeCombatScript(parseCombatScript('钟离 e', { aliases }), missing, { team: [{ name: '钟离', index: 1 }] }), UnsupportedNativeOperation);
  assertReleased(missing);
  assert.equal(missing.calls.length, 1);
});

test('combat cancellation during a held action still sends key-up before releaseAll', async () => {
  const controller = new AbortController();
  const host = fakeHost({ controller, onSleep: () => controller.abort(new Error('cancel combat')) });
  await assert.rejects(executeCombatScript(parseCombatScript('钟离 walk(w,5)', { aliases }), host, { team: [{ name: '钟离', index: 1 }] }), /cancel combat/);
  assert.deepEqual(host.calls.map(call => call.method), ['keyDown', 'keyUp', 'releaseAll']);
  assertReleased(host);
});

const empty = { x: 0, y: 0, width: 0, height: 0 };
const region = (x = 10, y = 20) => ({ x, y, width: 20, height: 10, globalX: x + 100, globalY: y + 200 });
function visualHost(recognize, onInput) {
  const host = fakeHost({ onInput });
  let id = 0; const captures = new Set(), disposed = new Set(), recognitions = [];
  host.capture = async () => { const handle = 'frame-' + (++id); captures.add(handle); return { handle, width: 1920, height: 1080 }; };
  host.vision = async (op, args) => {
    if (op === 'recognition.load') {
      await readFile(args.path); recognitions.push(args.objectName);
      return { original: args.objectName };
    }
    if (op === 'image.dispose') { disposed.add(args.handle); return; }
    return recognize(op, args.recognition?.original, args);
  };
  return Object.assign(host, { captures, disposed, recognitions });
}
test('returnMainUi follows exit-door handling and confirms the final UI', async () => {
  let phase = 'door';
  const host = visualHost((op, name) => {
    if (name === 'PaimonMenu' && phase === 'main') return region();
    if (name === 'BtnExitDoor' && phase === 'door') return region();
    return empty;
  }, method => { if (method === 'click') phase = 'main'; });
  const result = await new NativeTasks(host).returnMainUi();
  assert.deepEqual(result, { verified: true, attempts: 1 });
  assert.deepEqual(host.calls.map(call => call.method), ['keyPress', 'click']);
  assert.equal(host.now(), 5900);
  assert.deepEqual(host.captures, host.disposed);
});
test('returnMainUi refuses to report success after its original retry/fallback budget', async () => {
  const host = visualHost(() => empty);
  await assert.rejects(new NativeTasks(host).returnMainUi(), /exhausted/);
  assert.equal(host.calls.filter(call => call.method === 'keyPress').length, 10);
  assert.deepEqual(host.captures, host.disposed);
});
test('revival dialog prevents false main-UI recognition', async () => {
  const host = visualHost((op, name, args) => {
    if (op === 'image.ocr') { assert.deepEqual(args.recognition.roi, [0, 0, 1920, 540]); return [{ text: '角色复苏' }]; }
    if (name === 'PaimonMenu' || name === 'Confirm') return region();
    return empty;
  });
  assert.equal(await new NativeTasks(host).isInMainUi(), false);
  assert.deepEqual(host.captures, host.disposed);
});
test('mail task uses unchanged recognition objects and returns click evidence', async () => {
  let phase = 'main', clicks = 0;
  const host = visualHost((op, name) => {
    if (name === 'PaimonMenu' && phase === 'main') return region();
    if (name === 'EscMailReward' && phase === 'menu') return region(30, 40);
    if (name === 'Collect' && phase === 'mail') return region(50, 60);
    return empty;
  }, (method, args) => {
    if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = phase === 'main' ? 'menu' : 'main';
    if (method === 'click') { clicks++; phase = 'mail'; }
  });
  assert.deepEqual(await new NativeTasks(host).claimMailRewards(), { rewardIconFound: true, collectClicked: true, mainUiVerified: true });
  assert.equal(clicks, 2);
  assert.deepEqual(host.captures, host.disposed);
  assertReleased(host);
});
test('reward click ordering and caps follow the source state machine', async () => {
  let clicked = false;
  const host = visualHost((op, name) => {
    if (name === 'ClaimText') return clicked ? [] : [region(50, 100), region(50, 20)];
    if (name === 'ClaimGift') return clicked ? [] : [region(10, 20)];
    if (name === 'ClickBlankContinue') return region();
    throw new Error('Unexpected recognition ' + name);
  }, method => { if (method === 'click') clicked = true; });
  assert.deepEqual(await new NativeTasks(host).claimRewards(), { clicked: 1, limitReached: false });
  assert.deepEqual(host.calls.find(call => call.method === 'click').args, [120, 225]);
  assert.deepEqual(host.captures, host.disposed);
  assertReleased(host);
  const capped = visualHost((op, name) => name === 'ClaimText' ? [region()] : name === 'ClaimGift' ? [] : empty);
  assert.deepEqual(await new NativeTasks(capped).claimRewards({ maxClicks: 2 }), { clicked: 2, limitReached: true });
  assert.equal(capped.calls.filter(call => call.method === 'click').length, 2);
});
test('continuous reward claims preserve ten-tick scroll chunks and cancel cleanly', async () => {
  const controller = new AbortController();
  const host = visualHost(() => []);
  host.signal = controller.signal;
  const originalSleep = host.sleep;
  host.sleep = async ms => { await originalSleep(ms); controller.abort(new Error('released claim hotkey')); };
  await assert.rejects(new NativeTasks(host).claimRewards({ mode: 'hold', scrollDownEnabled: true, scrollDownAmount: -23 }), /released claim hotkey/);
  assert.deepEqual(host.calls.filter(call => call.method === 'verticalScroll').map(call => call.args), [[-10], [-10], [-3]]);
  assertReleased(host);
});

test('RodNet uses original parameters and the upstream float fixture matches an independent decimal reference', async () => {
  const net = await loadRodNet(sourceRoot);
  const fixture = await readFile(path.join(sourceRoot, 'Test/BetterGenshinImpact.UnitTest/GameTaskTests/AutoFishingTests/RodNetTests.cs'), 'utf8');
  const values = fixture.match(/InlineData\(([^)]+)\)/)[1].split(',').map(value => Math.fround(Number(value.trim().replace(/F$/, ''))));
  const fields = ['rod_x1', 'rod_x2', 'rod_y1', 'rod_y2', 'fish_x1', 'fish_x2', 'fish_y1', 'fish_y2', 'fish_label'];
  const input = Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  // Python decimal, precision 60, original float32 fixture and source parameters.
  const expected = [
    [-0.7999997139995928, 9.181951392505747e-21, 0.9999997139995928],
    [-0.3999999999999976, 1.0776153186935137e-23, 0.9999999999999976],
    [-0.34021860279367083, 0.0003206251881233529, 0.9898979776055474],
    [-0.34984457723721096, 3.4694561844196825e-10, 0.9998445768902654],
    [-0.59999987401908, 3.3344365024120568e-21, 0.99999987401908],
    [-0.2981493520990983, 3.378858230339846e-7, 0.9981490142132753],
    [-0.29644133158570496, 2.850675085083027e-7, 0.9964410465181964],
    [-0.7999902797999441, 4.551511038905356e-53, 0.999990279799944],
    [-0.7999915555043063, 4.580371019538147e-13, 0.9999915555038483],
    [-0.7999914394048973, 1.7018305910672552e-15, 0.9999914394048955],
    [-0.7993747891395233, 1.1721983746108487e-8, 0.9993747774175396],
  ];
  for (let label = 0; label < expected.length; label++) {
    const actual = net.computeScores({ ...input, fish_label: label });
    for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[label][i]) < 2e-12, label + '/' + i + ': ' + actual[i]);
    assert.equal(net.getRodState({ ...input, fish_label: label }), 2);
  }
  assert.deepEqual(net.computeScores(Object.fromEntries(Object.entries(input).map(([name, value]) => [name, String(value)]))), net.computeScores(input));
  assert.throws(() => net.computeScores({ ...input, fish_label: 11 }), /outside/);
  assert.throws(() => net.computeScores({ ...input, fish_x1: Infinity }), /Invalid fish_x1/);
  assert.throws(() => net.computeScores({ ...input, rod_x1: 0, rod_x2: 0, rod_y1: 0, rod_y2: 0 }), /non-finite/);
});

test('all seven source map coordinate systems retain origin, null sentinels and rectangle rounding', async () => {
  const teyvat = await loadMapCoordinates(sourceRoot);
  assert.deepEqual(teyvat.origin, { x: 32768, y: 24576 });
  assert.deepEqual(teyvat.imageToGame({ x: 30768, y: 20576 }), { x: 1000, y: 2000 });
  assert.deepEqual(teyvat.gameToImage({ x: 1000, y: 2000 }), { x: 30768, y: 20576 });
  assert.equal(teyvat.imageToGame({ x: 0, y: 0 }), null);
  assert.deepEqual(teyvat.gameToImage(null), { x: 0, y: 0 });
  assert.deepEqual(teyvat.imageRectToGame({ x: 30760, y: 20560, width: 16, height: 32 }), { x: 996, y: 1992, width: 8, height: 16 });
  assert.deepEqual(teyvat.gameRectToImage({ x: 996, y: 1992, width: 8, height: 16 }), { x: 30760, y: 20560, width: 16, height: 32 });
  for (const name of ['Teyvat', 'Enkanomiya', 'TheChasm', 'AncientSacredMountain', 'SeaOfBygoneEras', 'MoonCanon', 'TempleOfSpace']) {
    const map = await loadMapCoordinates(sourceRoot, name);
    const game = { x: -123.5, y: 987.25 };
    assert.deepEqual(map.imageToGame(map.gameToImage(game)), game, name);
    assert.equal(map.imageRectToGame({ x: 0, y: 0, width: 0, height: 0 }), null);
    assert.deepEqual(map.gameRectToImage(null), { x: 0, y: 0, width: 0, height: 0 });
  }
});
test('navigation angle quadrants and Euclidean distance match known geometry', () => {
  const origin = { x: 0, y: 0 };
  for (const [x, y, angle] of [[1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270], [1, 1, 45], [1, -1, 315], [0, 0, 0]]) assert.equal(targetOrientation({ x, y }, origin), angle);
  assert.equal(waypointDistance({ x: 3, y: 4 }, origin), 5);
});

test('all original TCG strategies preserve card skill order, costs and action commands', async t => {
  const cards = await loadTcgCatalog(sourceRoot);
  const strategies = (await files(path.join(resourceRoot, 'repo/tcg'))).filter(filename => filename.endsWith('.txt'));
  let actions = 0;
  for (const filename of strategies) {
    const duel = parseTcgScript(await readFile(filename, 'utf8'), { cards, aliases });
    assert.ok(duel.characters[1] && duel.characters[2] && duel.characters[3], filename);
    for (const action of duel.actionCommandQueue) {
      assert.equal(action.action, 'UseSkill');
      assert.ok(action.character.skills[action.targetIndex], filename);
      const skill = action.character.skills[action.targetIndex];
      assert.equal(skill.allCost, skill.specificElementCost + skill.anyElementCost);
    }
    actions += duel.actionCommandQueue.length;
  }
  assert.equal(strategies.length, 62);
  assert.equal(actions, 666);
  t.diagnostic(strategies.length + ' original TCG strategies, ' + actions + ' actions parsed; duel visual execution is not implemented');
});
test('TCG custom cards, dice deltas and original error line numbers', async () => {
  const cards = await loadTcgCatalog(sourceRoot);
  const source = '角色定义:\n角色1=自定义|冰{技能1消耗=3冰骰子,技能2消耗=1冰骰子+2任意}\n角色2=雷神\n角色3=刻晴\n策略定义:\n自定义 使用 技能1 骰子增加2\n自定义 使用 技能2 骰子减少1';
  const duel = parseTcgScript(source, { cards, aliases });
  assert.equal(duel.characters[1].element, 'Cryo');
  assert.equal(duel.characters[1].hp, -2);
  assert.equal(duel.characters[1].skills[2].anyElementCost, 2);
  assert.deepEqual(duel.actionCommandQueue.map(action => action.diceDelta), [2, -1]);
  assert.throws(() => parseTcgScript(source + '\n自定义 使用 技能5', { cards, aliases }), /行号：8.*技能编号/);
  assert.throws(() => parseTcgScript(source.replace('骰子增加2', '增加骰子2'), { cards, aliases }), /行号：6.*骰子增减/);
});
