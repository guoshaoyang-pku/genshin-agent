import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartyTasks, PartySetupFailedError, PartyRecoveryRetry, cleanPartyName, partyConfig, defaultConditionConfig, filterPartyName, buildConditionalPartyConfig } from './party.mjs';
import { characterTarget, parseCharacterTargets, operablePhysicalSlots, mapCharacterTargets, desiredTeamRoles, firstMismatchSlot } from './party-character.mjs';
import { loadAvatarCatalog } from './native.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source');
const empty = { x: 0, y: 0, width: 0, height: 0 };
const rect = (text = '', x = 100, y = 200, width = 100, height = 20) => ({ text, x, y, width, height, globalX: x, globalY: y });
const catalog = await loadAvatarCatalog(sourceRoot);

function hostFor({ width = 1920, height = 1080, controller, recognize, ocr, vision, onInput, onSleep, combat, genshin, onCapture } = {}) {
  let clock = 0, sequence = 0;
  const calls = [], visionCalls = [], frames = new Map(), owned = new Set(), disposed = new Set(), held = new Set(), files = new Map();
  const host = {
    sourceRoot, calls, visionCalls, frames, owned, disposed, held, signal: controller?.signal,
    now: () => clock, utcNow: () => Date.UTC(2026, 9, 16, 5),
    async sleep(ms) { clock += ms; await onSleep?.(ms, host); },
    async input(method, args = []) {
      calls.push({ at: clock, method, args });
      if (method.endsWith('Down')) held.add(method);
      if (method.endsWith('Up')) held.delete(method.replace(/Up$/, 'Down'));
      if (method === 'releaseAll') held.clear();
      await onInput?.(method, args, host);
    },
    async capture() {
      const frame = { handle: 'frame-' + ++sequence, width, height, number: sequence };
      frames.set(frame.handle, frame); owned.add(frame.handle); await onCapture?.(frame, host); return frame;
    },
    async combat(operation, args = {}) { calls.push({ at: clock, method: 'combat.' + operation, args }); return combat?.(operation, args, host); },
    async genshin(operation, args) { calls.push({ at: clock, method: 'genshin.' + operation, args }); return genshin?.(operation, args, host); },
    async clearTeamCache() { calls.push({ at: clock, method: 'clearTeamCache', args: [] }); },
    async vision(op, args) {
      visionCalls.push({ op, args });
      if (op === 'recognition.load') {
        if (!files.has(args.path)) files.set(args.path, JSON.parse(await readFile(args.path, 'utf8')));
        assert.ok(files.get(args.path).objects[args.objectName], args.objectName + ' missing original recognition');
        return { original: args.objectName };
      }
      if (op === 'image.dispose') { assert.ok(owned.has(args.handle)); assert.ok(!disposed.has(args.handle), 'double dispose'); disposed.add(args.handle); return; }
      if (args.handle) assert.ok(!disposed.has(args.handle), 'use after dispose');
      if (op === 'image.ocr') return await ocr?.(args.recognition.roi, frames.get(args.handle), host) ?? [];
      if (op === 'image.find' || op === 'image.findMulti') return await recognize?.(args.recognition.original, args, host) ?? (op === 'image.findMulti' ? [] : empty);
      const result = await vision?.(op, args, host);
      if (result !== undefined) return result;
      throw new Error('Unexpected vision operation ' + op);
    },
  };
  return host;
}
function done(host) {
  assert.equal(host.calls.at(-1)?.method, 'releaseAll');
  assert.equal(host.held.size, 0);
  assert.deepEqual(host.owned, host.disposed);
}
function partyHost({ phase: initial = 'party', currentName = '跑图队', selectedName = '采集队', target = true, finalName, failOpen = false, failMenu = false, failConfirm = false, controller, cancelHeld = false } = {}) {
  let phase = initial, selected = false, listReads = 0;
  const host = hostFor({ controller,
    recognize(name, args) {
      if (name === 'PaimonMenu' && phase === 'main') return rect();
      if (name === 'PartyBtnChooseView' && phase === 'party') return rect('', 100, 50, 30, 20);
      if (name === 'PartyBtnDelete' && phase === 'menu') return rect('', 900, 950, 50, 30);
      if (name === 'BtnWhiteConfirm' && phase === 'menu' && selected && !failConfirm && args.recognition.roi[0] === 0) return rect('', 100, 950, 100, 30);
      return undefined;
    },
    ocr(roi) {
      if (roi?.[2] === 350) return [rect(phase === 'party' && selected ? finalName ?? selectedName : currentName)];
      if (phase === 'menu' && roi?.[1] === 80) { listReads++; return [rect(target ? selectedName : '其他队伍', 50, 800)]; }
      return [];
    },
    onInput(method, args) {
      if (method === 'keyPress' && args[0] === 'L' && !failOpen) phase = 'party';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = 'main';
      if (method === 'click' && args[0] === 115 && args[1] === 60 && !failMenu) phase = 'menu';
      if (method === 'click' && args[0] === 250 && args[1] === 820) selected = true;
      if (method === 'click' && args[0] === 150 && args[1] === 965) phase = 'party';
    },
    onSleep(ms) { if (cancelHeld && ms === 450) controller.abort(new Error('cancel held')); },
  });
  host.listReads = () => listReads;
  return host;
}

test('source config defaults, old recovery migration and distance constraints remain compatible', () => {
  const defaults = partyConfig();
  assert.equal(defaults.Enabled, true); assert.equal(defaults.AutoFightEnabled, true); assert.equal(defaults.TravelMode, '精准靠近');
  assert.equal(defaults.RecoverTiming, 0); assert.equal(partyConfig({ onlyInTeleportRecover: true }).RecoverTiming, 1);
  assert.equal(partyConfig({ recoverTiming: 'Never' }).recoverTiming, undefined);
  assert.equal(partyConfig({ OnlyInTeleportRecover: true, RecoverTiming: 'Never' }).RecoverTiming, 2);
  assert.equal(partyConfig({}, { RecoverTiming: 'OnlyTeleport', AutoEatEnabled: true, UseGadgetIntervalMs: 1500 }, true).RecoverTiming, 1);
  assert.equal(partyConfig({}, undefined, true).AutoFightEnabled, false);
  assert.equal(partyConfig({ Distance: 10, ApproachStopDistance: 20, MwkJumpFlyDistance: 4 }).ApproachStopDistance, 10);
  assert.equal(partyConfig({ Distance: 10, MwkJumpFlyDistance: 4 }).MwkJumpFlyDistance, 11);
  assert.deepEqual(partyConfig({ AutoEatConfig: { Enabled: true } }).AutoEatConfig, { Enabled: true });
  assert.throws(() => partyConfig({ RecoverTiming: 'invalid' }), RangeError);
});
test('original condition priority is action, material, all; guardian uses first rule then first team member', () => {
  const conditions = { ...defaultConditionConfig(), PartyConditions: [
    { Subject: '采集物', Object: ['全部'], Result: '默认队' },
    { Subject: '采集物', Object: ['甜甜花'], Result: '花队' },
    { Subject: '动作', Object: ['水元素采集'], Result: '水队' },
  ] };
  assert.equal(filterPartyName({ Positions: [{ Action: 'unknown' }, { Action: 'hydro_collect' }] }, conditions, '甜甜花'), '水队');
  assert.equal(filterPartyName({ Positions: [] }, conditions, '甜甜花'), '花队');
  assert.equal(filterPartyName({ Positions: [] }, conditions), '默认队');
  const config = buildConditionalPartyConfig([{ name: '钟离', index: 1, skillHoldCD: 12 }, { name: '芭芭拉', index: 2, skillCD: 32 }, { name: '迪希雅', index: 4 }]);
  assert.equal(config.GuardianAvatarIndex, '2'); assert.equal(config.GuardianElementalSkillSecondInterval, '32'); assert.equal(config.GuardianElementalSkillLongPress, false); assert.equal(config.MainAvatarIndex, '4');
  assert.equal(buildConditionalPartyConfig([{ name: '钟离', index: 3, skillHoldCD: 12 }]).GuardianElementalSkillSecondInterval, '12');
});
test('party names keep source quote/CR cleanup and first-line matching', () => {
  assert.equal(cleanPartyName(' "采集队"\r\n第二行 '), '采集队第二行');
  assert.equal(cleanPartyName('采集队\n第二行'), '采集队');
});
test('same-party shortcut requires current OCR, keeps original boolean and releases input', async () => {
  const host = partyHost({ currentName: '"采集队"\r' }), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchParty('^采集队$'), true);
  assert.equal(state.lastSwitch.changed, false); assert.equal(state.lastSwitch.verified, true);
  assert.equal(host.calls.filter(call => call.method === 'click').length, 0); done(host);
});
test('full party switch confirms selection and freshly observes current name before cache invalidation', async () => {
  const host = partyHost({ phase: 'main' }), state = { team: ['old'] };
  assert.equal(await new PartyTasks(host, {}, state).switchParty('^采集队$'), true);
  assert.equal(state.lastSwitch.observedName, '采集队'); assert.equal(state.lastSwitch.page, 1); assert.equal(state.team, null);
  assert.equal(host.calls.filter(call => call.method === 'clearTeamCache').length, 1);
  assert.equal(host.calls.filter(call => call.method === 'leftButtonDown').length, 1); done(host);
});
test('switchParty bounds opening at two times seven source observations and menu at four clicks', async () => {
  const closed = partyHost({ phase: 'main', failOpen: true });
  await assert.rejects(new PartyTasks(closed).switchParty('采集'), PartySetupFailedError);
  assert.equal(closed.calls.filter(call => call.method === 'keyPress' && call.args[0] === 'L').length, 2);
  assert.equal(closed.now(), 8400); done(closed);
  const noMenu = partyHost({ failMenu: true });
  await assert.rejects(new PartyTasks(noMenu).switchParty('采集'), PartySetupFailedError);
  assert.equal(noMenu.calls.filter(call => call.method === 'click').length, 4); done(noMenu);
});
test('switchParty missing target scans at most sixteen pages, returns false and exits to observed main UI', async () => {
  const host = partyHost({ target: false }), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchParty('采集'), false);
  assert.equal(host.listReads(), 16); assert.equal(state.lastSwitch.verified, false); done(host);
});
test('confirmation timeout and wrong final OCR cannot produce switch receipts', async () => {
  const timeout = partyHost({ failConfirm: true });
  await assert.rejects(new PartyTasks(timeout).switchParty('采集'), /等待队伍切换超时/); done(timeout);
  const wrong = partyHost({ finalName: '未变队伍' }), state = {};
  await assert.rejects(new PartyTasks(wrong, {}, state).switchParty('采集'), /未观察到匹配/);
  assert.equal(state.lastSwitch, undefined); assert.equal(wrong.calls.some(call => call.method === 'clearTeamCache'), true); done(wrong);
});
test('cancel during source hold releases mouse and preserves cancellation', async () => {
  const controller = new AbortController(), host = partyHost({ controller, cancelHeld: true });
  await assert.rejects(new PartyTasks(host).switchParty('采集'), /cancel held/);
  assert.equal(host.calls.filter(call => call.method === 'leftButtonUp').length, 1); done(host);
});

test('character aliases and traveler variants reuse catalog and enforce actual-role conflicts', () => {
  assert.equal(characterTarget(1, '岩王帝君', catalog).name, '钟离');
  assert.deepEqual(characterTarget(2, '主角', catalog).candidateNames, ['空', '荧']);
  assert.equal(characterTarget(2, '荧', catalog).forcedWeaponType, '单手剑');
  assert.equal(characterTarget(2, '空', catalog).skipElementFilter, true);
  for (const values of [[], ['', ' '], ['旅行者', '荧'], ['空', '荧'], ['钟离', '岩王帝君'], ['不存在'], ['钟离', 1]]) assert.throws(() => parseCharacterTargets(values, catalog));
});
test('all original cooperative physical-to-logical slot mappings remain exact', () => {
  const cases = [[1, 1, [1, 2, 3, 4]], [2, 1, [1, 2]], [2, 2, [3, 4]], [3, 1, [1, 2]], [3, 2, [3]], [3, 3, [4]], [4, 1, [1]], [4, 2, [2]], [4, 3, [3]], [4, 4, [4]]];
  for (const [count, player, slots] of cases) assert.deepEqual(operablePhysicalSlots(count, player), slots);
  assert.throws(() => operablePhysicalSlots(3, 4), RangeError);
  const targets = parseCharacterTargets(['钟离', '', '纳西妲', '芭芭拉'], catalog);
  assert.deepEqual(mapCharacterTargets(targets, [3, 4], true).map(role => [role.slot, role.name]), [[1, '纳西妲'], [2, '芭芭拉']]);
  assert.deepEqual(mapCharacterTargets(targets, [3, 4], false).map(role => [role.slot, role.name]), [[1, '钟离']]);
});
test('desired team retains unspecified original slots then fills displaced characters in source order', () => {
  const current = ['钟离', '纳西妲', '芭芭拉', '迪希雅'].map((name, index) => ({ slot: index + 1, name }));
  const desired = desiredTeamRoles(parseCharacterTargets(['纳西妲'], catalog), current, catalog);
  assert.deepEqual(desired.map(role => role.name), ['纳西妲', '钟离', '芭芭拉', '迪希雅']);
  assert.equal(firstMismatchSlot(desired, current), 1);
  assert.equal(firstMismatchSlot(desired, desired), null);
});

function characterHost({ team: initial = ['钟离', '纳西妲', '芭芭拉', '迪希雅'], score = 0.9, truncate, noMutation = false, identity, unavailable = false, controller, cancelSubmit = false, available = [], friendshipInitially = false } = {}) {
  let phase = 'main', team = [...initial], slot = 1, filtered = false, selected, gridCalls = 0, submits = 0, removes = 0;
  let friendship = friendshipInitially;
  const roster = [...new Set([...initial, '白术', '钟离', '纳西妲', '芭芭拉', '迪希雅', ...available])];
  const cards = names => names.map((name, index) => ({ name, elementType: '草', score, cardRect: rect('', 30 + 145 * index, 100, 132, 161) }));
  const host = hostFor({ controller,
    recognize(name) {
      if (name === 'PaimonMenu' && phase === 'main') return rect();
      if (name === 'StandAloneIcon' && !identity) return rect();
      if (identity && name === identity.playerIndex + 'PTopLeft') return [rect()];
      if (name === 'SortButton') return rect('', 700, 40);
      return undefined;
    },
    ocr(roi) {
      if (phase === 'party' && roi?.[0] === 119) return [rect('队伍配置')];
      if (phase === 'unavailable' && roi?.[0] === 806) return [rect('当前状态不可进行队伍配置')];
      if (phase === 'list' && roi?.[0] === 1655) return [rect('元素共鸣')];
      if (phase === 'filter' && roi?.[0] === 360) return [rect('确认筛选', 360, 999, 128, 40)];
      if (phase === 'filter' && roi?.[1] === 150) return ['草', '岩', '火', '水'].map((name, index) => rect(name, 100 + index * 100, 200));
      if (phase === 'filter' && roi?.[1] === 560) return [rect('法器', 100, 600), rect('长柄武器', 220, 600), rect('双手剑', 340, 600), rect('单手剑', 460, 600)];
      if (phase === 'list' && roi?.[0] === 382) return [rect(selected ? slot > team.length ? '加入' : '更换' : '换下', 382, 994, 87, 51)];
      if (phase === 'list' && roi?.[0] === 116) return [rect(friendship ? '好感' : '顺序', 116, 29)];
      if (phase === 'sort' && roi?.[0] === 111) return [rect('好感', 111, 100)];
      return [];
    },
    vision(op) {
      if (op === 'party.layout') return { multiGameStatus: identity ? { isInMultiGame: true, ...identity } : { isInMultiGame: false } };
      if (op === 'party.gridMetadata') return { characters: roster.map(name => ({ name, elementType: name === '钟离' ? '岩' : name === '芭芭拉' ? '水' : name === '迪希雅' ? '火' : '草', weaponType: name === '钟离' ? '长柄武器' : name === '迪希雅' ? '双手剑' : '法器' })) };
      if (op === 'party.grid') { gridCalls++; return { cards: cards(filtered ? roster : truncate ? team.slice(0, truncate) : team) }; }
      return undefined;
    },
    genshin() { phase = 'main'; },
    onInput(method, args) {
      if (method === 'keyPress' && args[0] === 'L') phase = unavailable ? 'unavailable' : 'party';
      if (method === 'keyPress' && args[0] === 'VK_ESCAPE') phase = phase === 'list' ? 'party' : 'main';
      if (method !== 'click') return;
      if (phase === 'party' && args[1] === 550) {
        const physical = [470, 800, 1130, 1460].indexOf(args[0]) + 1;
        slot = identity ? operablePhysicalSlots(identity.playerCount, identity.playerIndex).indexOf(physical) + 1 : physical;
        phase = 'list'; filtered = false; selected = null; return;
      }
      if (phase === 'list' && args[0] === 66 && args[1] === 46) { phase = 'filter'; return; }
      if (phase === 'list' && args[0] === 166 && args[1] === 39) { phase = 'sort'; return; }
      if (phase === 'sort' && args[0] === 161 && args[1] === 110) { friendship = true; phase = 'list'; return; }
      if (phase === 'filter' && args[0] === 424 && args[1] === 1019) { phase = 'list'; filtered = true; return; }
      if (phase === 'list' && filtered && args[1] === 180.5) { selected = roster[Math.round((args[0] - 96) / 145)]; return; }
      if (phase === 'list' && args[0] === 425.5 && args[1] === 1019.5) {
        if (selected) { submits++; if (!noMutation) team[slot - 1] = selected; if (cancelSubmit) controller.abort(new Error('cancel submitted')); }
        else { removes++; team.splice(slot - 1, 1); }
        phase = 'party';
      }
    },
  });
  host.characterState = () => ({ team, gridCalls, submits, removes }); return host;
}
test('character same-team path recognizes the original model grid and observes main UI before true', async () => {
  const host = characterHost(), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['钟离']), true);
  assert.deepEqual(state.lastCharacterSwitch.team.map(avatar => avatar.name), host.characterState().team);
  assert.equal(state.lastCharacterSwitch.changed, false); assert.equal(host.characterState().gridCalls, 1); done(host);
});
test('cooperative physical slot requests only mutate the local player controllable grid', async () => {
  const host = characterHost({ team: ['钟离', '纳西妲'], identity: { playerCount: 2, playerIndex: 2 } }), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['', '', '白术'], true), true);
  assert.deepEqual(host.characterState().team, ['白术', '纳西妲']);
  assert.deepEqual(state.lastCharacterSwitch.physicalSlots, [3, 4]);
  assert.equal(host.calls.find(call => call.method === 'click' && call.args[1] === 550).args[0], 1130); done(host);
});
test('inaccessible cooperative targets return observed main UI without claiming a team mutation', async () => {
  const host = characterHost({ team: ['钟离'], identity: { playerCount: 4, playerIndex: 3 } }), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['白术']), true);
  assert.equal(state.lastCharacterSwitch.reason, 'noOperableTargets'); assert.equal(state.lastCharacterSwitch.changed, false);
  assert.equal(host.characterState().gridCalls, 0); done(host);
});
test('traveler skips element filtering, applies source sword and friendship sort, and accepts actual girl candidate', async () => {
  const host = characterHost({ available: ['荧'] }), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['旅行者']), true);
  assert.equal(host.characterState().team[0], '荧'); assert.equal(state.lastCharacterSwitch.team[0].name, '荧');
  assert.equal(host.visionCalls.some(call => call.op === 'image.ocr' && call.args.recognition.roi?.[1] === 150), false);
  assert.ok(host.calls.some(call => call.method === 'click' && call.args[0] === 750 && call.args[1] === 50)); done(host);
});
test('new character selection uses model metadata and full card click, then final actual team verification', async () => {
  const host = characterHost(), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['白术']), true);
  assert.deepEqual(host.characterState().team, ['白术', '纳西妲', '芭芭拉', '迪希雅']);
  assert.equal(host.characterState().gridCalls, 3); assert.equal(state.lastCharacterSwitch.verified, true);
  assert.equal(host.calls.filter(call => call.method === 'clearTeamCache').length, 1); done(host);
});
test('wrong-position character removal rebuilds the suffix and preserves all unspecified roles', async () => {
  const host = characterHost(), state = {};
  assert.equal(await new PartyTasks(host, {}, state).switchCharacter(['纳西妲']), true);
  assert.deepEqual(host.characterState().team, ['纳西妲', '钟离', '芭芭拉', '迪希雅']);
  assert.equal(host.characterState().removes, 3); assert.equal(host.characterState().submits, 4); done(host);
});
test('grid confidence includes 0.7 exactly and rejects anything below the source threshold', async () => {
  const exact = characterHost({ score: 0.7 });
  assert.equal(await new PartyTasks(exact).switchCharacter(['钟离']), true); done(exact);
  const low = characterHost({ score: 0.699999 });
  await assert.rejects(new PartyTasks(low).switchCharacter(['钟离']), /识别不完整/); done(low);
});
test('incomplete party grid has exactly three observations and no mutation', async () => {
  const host = characterHost({ truncate: 3 });
  await assert.rejects(new PartyTasks(host).switchCharacter(['钟离']), /期望 4 个/);
  assert.equal(host.characterState().gridCalls, 3); assert.equal(host.characterState().submits, 0); done(host);
});
test('character grid failure survives a second error while closing the character list', async () => {
  const host = characterHost(), failure = new Error('original grid failure');
  const vision = host.vision, input = host.input;
  host.vision = async (operation, args) => { if (operation === 'party.grid') throw failure; return vision(operation, args); };
  host.input = async (method, args) => { await input(method, args); if (method === 'keyPress' && args[0] === 'VK_ESCAPE') throw new Error('list cleanup failed'); };
  await assert.rejects(new PartyTasks(host).switchCharacter(['钟离']), error => error === failure);
  done(host);
});
test('a click that fails to change team is detected by final recognition and bounded to three submissions', async () => {
  const host = characterHost({ noMutation: true }), state = {};
  await assert.rejects(new PartyTasks(host, {}, state).switchCharacter(['白术']), /连续 3 次/);
  assert.equal(host.characterState().submits, 3); assert.equal(state.lastCharacterSwitch, undefined);
  assert.equal(host.calls.filter(call => call.method === 'clearTeamCache').length, 1); done(host);
});
test('mutation cancellation invalidates team cache and releases input while preserving the original abort', async () => {
  const controller = new AbortController(), host = characterHost({ controller, cancelSubmit: true }), state = { team: ['stale'] };
  await assert.rejects(new PartyTasks(host, {}, state).switchCharacter(['白术']), /cancel submitted/);
  assert.equal(state.team, null); assert.equal(host.calls.filter(call => call.method === 'clearTeamCache').length, 1); done(host);
});
test('unavailable party page retries original statue recovery at most twice', async () => {
  const host = characterHost({ unavailable: true });
  await assert.rejects(new PartyTasks(host).switchCharacter(['钟离']), /七天神像重试后仍无法/);
  assert.equal(host.calls.filter(call => call.method === 'genshin.tpToStatueOfTheSeven').length, 2); done(host);
});

function lifecycleHost({ team = [{ name: '白术', index: 1 }, { name: '钟离', index: 2 }], observed = team, lowHp = [false], revive = false, onSwitch, controller, onSleep } = {}) {
  let lowIndex = 0, reviveShown = revive;
  return hostFor({ controller, onSleep,
    recognize: name => name === 'PaimonMenu' ? rect() : undefined,
    ocr: roi => reviveShown && roi?.[1] === 810 ? [rect('复苏', 900, 900)] : [],
    onInput(method) { if (method === 'click') reviveShown = false; },
    vision(op) {
      if (op === 'party.recognize') return { avatars: observed };
      if (op === 'party.lowHp') return lowHp[Math.min(lowIndex++, lowHp.length - 1)];
      return undefined;
    },
    combat(operation, args) {
      if (operation === 'initializeTeam') { assert.equal(args.force, true); assert.equal(args.requireObserved, true); return team; }
      if (operation === 'trySwitchAvatar') return onSwitch?.(args) ?? true;
      if (operation === 'clearTeam') return;
      throw new Error(operation);
    },
  });
}
test('route preparation requires a fresh team matching observed cache and returns exact condition config', async () => {
  const host = lifecycleHost(), state = {};
  const result = await new PartyTasks(host, {}, state).prepareRoute({ task: { Positions: [] } });
  assert.equal(result.ready, true); assert.equal(result.verified, true); assert.equal(result.mainUiVerified, true);
  assert.equal(result.partyConfig.Enabled, false); assert.equal(result.partyConfig.GuardianAvatarIndex, '2'); done(host);
  const mismatched = lifecycleHost({ observed: [{ name: '纳西妲', index: 1 }] });
  await assert.rejects(new PartyTasks(mismatched).prepareRoute({ task: { Positions: [] } }), /缓存与当前画面/); done(mismatched);
});
test('material inference reuses original condition definitions and skips the first route directory', async () => {
  const tasks = new PartyTasks(lifecycleHost(), { pathJsonRoot: '/routes' });
  assert.equal(await tasks.materialName({ FullPath: '/routes/蒙德/甜甜花/路线.json' }, {}), '甜甜花');
  assert.equal(await tasks.materialName({ FullPath: '/routes/甜甜花/路线.json' }, {}), null);
  assert.equal(await tasks.materialName({ FullPath: '/routes/蒙德/不在原版目录/路线.json' }, {}), null);
});
test('route party setup retries only the original setup exception through statue and preserves original errors', async () => {
  const host = lifecycleHost(), tasks = new PartyTasks(host); let attempts = 0;
  tasks.switchPartyTask = async () => { if (++attempts === 1) throw new PartySetupFailedError('not ready'); return true; };
  assert.equal((await tasks.prepareRoute({ task: { Positions: [] }, options: { partyConfig: { PartyName: '采集队' } } })).ready, true);
  assert.equal(attempts, 2); assert.equal(host.calls.filter(call => call.method.startsWith('genshin.')).length, 1); done(host);
  const failed = lifecycleHost(), failingTasks = new PartyTasks(failed);
  failingTasks.switchPartyTask = async () => { throw new Error('transport failed'); };
  await assert.rejects(failingTasks.prepareRoute({ task: { Positions: [] }, options: { partyConfig: { PartyName: '采集队' } } }), /transport failed/);
  assert.equal(failed.calls.filter(call => call.method.startsWith('genshin.')).length, 0); done(failed);
});
test('multiplayer and SkipPartySwitch suppress source party selection without bypassing team recognition', async () => {
  const multi = lifecycleHost(), originalVision = multi.vision;
  multi.vision = async (op, args) => op === 'image.findMulti' && args.recognition.original === 'P' ? [rect()] : originalVision(op, args);
  const tasks = new PartyTasks(multi); tasks.switchPartyTask = async () => { throw new Error('must not switch'); };
  const result = await tasks.prepareRoute({ task: { Positions: [] }, options: { partyConfig: { PartyName: '采集队' } } });
  assert.equal(result.multiplayer, true); assert.equal(result.ready, true); done(multi);
  const skipped = lifecycleHost(), skipTasks = new PartyTasks(skipped); skipTasks.switchPartyTask = tasks.switchPartyTask;
  assert.equal((await skipTasks.prepareRoute({ task: { Positions: [] }, options: { partyConfig: { PartyName: '采集队', SkipPartySwitch: true } } })).ready, true);
  assert.ok(skipped.calls.some(call => call.method === 'combat.initializeTeam')); done(skipped);
});
test('route special actions require actual original configured characters', async () => {
  const nahida = lifecycleHost();
  await assert.rejects(new PartyTasks(nahida).prepareRoute({ task: { Positions: [{ Action: 'nahida_collect' }] } }), /没有纳西妲/); done(nahida);
  const wrongElement = lifecycleHost();
  await assert.rejects(new PartyTasks(wrongElement).prepareRoute({ task: { Positions: [{ Action: 'hydro_collect' }] } }), /原版配置支持/); done(wrongElement);
  const hydro = lifecycleHost({ team: [{ name: '芭芭拉', index: 1 }] });
  assert.equal((await new PartyTasks(hydro).prepareRoute({ task: { Positions: [{ Action: 'hydro_collect' }] } })).ready, true); done(hydro);
});
test('lowHP recovery re-captures after source healer sequence and only reports observed HP cleared', async () => {
  const host = lifecycleHost({ lowHp: [true, false] }), state = { team: [{ name: '白术', index: 1 }, { name: '钟离', index: 2 }] };
  const result = await new PartyTasks(host, {}, state).recoverWhenLowHp({ options: { partyConfig: { MainAvatarIndex: '2' } } });
  assert.equal(result.verified, true); assert.equal(result.healer, '白术'); assert.equal(result.lowHpCleared, true);
  assert.deepEqual(host.calls.filter(call => call.method === 'keyPress').map(call => [call.at, call.args[0]]), [[0, 'E'], [800, 'E']]);
  assert.equal(host.now(), 5700); assert.equal(host.calls.some(call => call.method.startsWith('genshin.')), false); done(host);
});
test('failed healer is followed by verified statue recovery and PATH_RETRY; stale HP cannot succeed', async () => {
  const host = lifecycleHost({ lowHp: [true, true, false] }), state = { team: [{ name: '白术', index: 1 }] };
  await assert.rejects(new PartyTasks(host, {}, state).recoverWhenLowHp(), error => error instanceof PartyRecoveryRetry && error.code === 'PATH_RETRY' && error.receipt.lowHpCleared === true);
  assert.equal(host.calls.filter(call => call.method === 'genshin.tpToStatueOfTheSeven').length, 1);
  assert.equal(new Set(host.visionCalls.filter(call => call.op === 'party.lowHp').map(call => call.args.handle)).size, 3); done(host);
  const failed = lifecycleHost({ lowHp: [true, true, true] });
  await assert.rejects(new PartyTasks(failed).recoverWhenLowHp(), /仍观察到低血量/); done(failed);
});
test('healer failure ordering, Never and teleport-only policies preserve original behavior', async () => {
  const host = lifecycleHost({ lowHp: [true, true, false], onSwitch: () => false }), state = { team: [{ name: '白术', index: 1 }, { name: '希格雯', index: 2 }] };
  await assert.rejects(new PartyTasks(host, {}, state).recoverWhenLowHp(), PartyRecoveryRetry);
  assert.equal(host.calls.filter(call => call.method === 'combat.trySwitchAvatar').length, 1); done(host);
  for (const config of [{ RecoverTiming: 'Never' }, { RecoverTiming: 'OnlyTeleport' }]) {
    const skipped = lifecycleHost();
    assert.equal((await new PartyTasks(skipped).recoverWhenLowHp({ waypoint: { Type: 'path' }, options: { partyConfig: config } })).reason, 'recoverTiming');
    assert.equal(skipped.owned.size, 0); done(skipped);
  }
});
test('Sigewinne and Kokomi retain their original distinct heal timing and burst sequence', async () => {
  for (const [name, duration, expectedKeys] of [['希格雯', 11000, [[0, 'E']]], ['珊瑚宫心海', 5500, [[0, 'E'], [500, 'Q']]]]) {
    const host = lifecycleHost({ lowHp: [true, false] }), state = { team: [{ name, index: 1 }] };
    assert.equal((await new PartyTasks(host, {}, state).recoverWhenLowHp()).healer, name);
    assert.equal(host.now(), duration); assert.deepEqual(host.calls.filter(call => call.method === 'keyPress').map(call => [call.at, call.args[0]]), expectedKeys); done(host);
  }
});
test('revive modal waits for observed main UI then teleports and retries', async () => {
  const host = lifecycleHost({ revive: true, lowHp: [false, false] });
  await assert.rejects(new PartyTasks(host).recoverWhenLowHp(), error => error instanceof PartyRecoveryRetry && error.receipt.revived);
  assert.equal(host.now(), 10000); done(host);
});
test('big map anomaly exits without Escape and does not dispose a borrowed frame', async () => {
  const host = hostFor({ recognize: name => ['Cook', 'MapScaleButton'].includes(name) ? rect() : undefined });
  const borrowed = await host.capture();
  const result = await new PartyTasks(host).resolveAnomalies({ frame: borrowed });
  assert.equal(result.bigMap, true); assert.equal(result.acted, false); assert.equal(host.disposed.has(borrowed.handle), false);
  assert.equal(host.calls.some(call => call.method === 'keyPress'), false);
  await host.vision('image.dispose', { handle: borrowed.handle }); done(host);
});
test('anomaly AutoSkip uses original last-option setting and eleven consecutive absent frames', async () => {
  let dialogueChecks = 0;
  const host = hostFor({ recognize(name) {
    if (name === 'DisabledUiButton') { dialogueChecks++; return dialogueChecks <= 3 ? rect() : empty; }
    if (name === 'OptionIcon') return [rect('', 900, 400), rect('', 900, 600)];
    return undefined;
  } });
  const result = await new PartyTasks(host).resolveAnomalies();
  assert.equal(result.autoSkip.iterations, 12); assert.equal(result.autoSkip.completion, 'elevenConsecutiveAbsentFrames');
  assert.ok(host.calls.some(call => call.method === 'click' && call.args[1] === 610));
  assert.ok(host.calls.some(call => call.method === 'keyPress' && call.args[0] === 'SPACE')); done(host);
});
test('AutoSkip cancellation closes isolated dispatcher, releases input and preserves abort', async () => {
  const controller = new AbortController();
  const host = hostFor({ controller, recognize: name => name === 'DisabledUiButton' ? rect() : undefined, onSleep(ms) { if (ms === 210) controller.abort(new Error('cancel dialogue')); } });
  await assert.rejects(new PartyTasks(host).resolveAnomalies(), /cancel dialogue/);
  assert.ok(host.calls.filter(call => call.method === 'releaseAll').length >= 2); done(host);
});
test('AutoSkip cancellation survives dispatcher and outer release failures', async () => {
  const controller = new AbortController(), failure = new Error('original dialogue abort');
  const host = hostFor({ controller, recognize: name => name === 'DisabledUiButton' ? rect() : undefined,
    onSleep(ms) { if (ms === 210) controller.abort(failure); },
    onInput(method) { if (method === 'releaseAll' && controller.signal.aborted) throw new Error('release failed'); },
  });
  await assert.rejects(new PartyTasks(host).resolveAnomalies(), error => error === failure);
  assert.ok(host.calls.filter(call => call.method === 'releaseAll').length >= 2); done(host);
});
