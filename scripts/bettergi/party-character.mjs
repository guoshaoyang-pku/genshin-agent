// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI Common/Job/SwitchCharacterStateMachineTask.cs, pinned c9db8b8.
import { loadAvatarCatalog } from './native.mjs';

const exists = region => !!region && region.width > 0 && region.height > 0;
const matches = (role, name) => role.candidateNames.includes(name);
const ordered = values => [...values].sort((a, b) => a.slot - b.slot);
const roundEven = value => { const floor = Math.floor(value); return value - floor === 0.5 ? floor + floor % 2 : Math.round(value); };

export function characterTarget(slot, name, catalog) {
  const canonical = catalog.avatars.some(avatar => avatar.name === name) ? name : catalog.aliases.get(name);
  if (!canonical) throw new TypeError('角色名称校验失败：' + name);
  if (['旅行者', '空', '荧'].includes(canonical)) return {
    slot, name: canonical, candidateNames: canonical === '旅行者' ? ['空', '荧'] : [canonical], conflictNames: ['空', '荧'],
    skipElementFilter: true, forcedWeaponType: '单手剑', useFriendshipSort: true,
  };
  const special = canonical.startsWith('奇偶');
  return { slot, name: canonical, candidateNames: [canonical], conflictNames: [canonical], skipElementFilter: special, forcedWeaponType: special ? '单手剑' : null, useFriendshipSort: special };
}

export function parseCharacterTargets(slots, catalog) {
  if (!Array.isArray(slots) || slots.length > 4 || !slots.length || slots.some(name => typeof name !== 'string')) throw new TypeError('Character slots must be one to four strings');
  const roles = slots.flatMap((name, index) => name.trim() ? [characterTarget(index + 1, name.trim(), catalog)] : []);
  if (!roles.length) throw new TypeError('切换角色：至少需要指定一个角色');
  for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) if (roles[i].conflictNames.some(name => roles[j].conflictNames.includes(name))) throw new TypeError('切换角色：目标槽位存在同一实际角色冲突');
  return roles;
}

export function operablePhysicalSlots(playerCount, playerIndex) {
  if (!Number.isInteger(playerCount) || !Number.isInteger(playerIndex) || playerCount < 1 || playerCount > 4 || playerIndex < 1 || playerIndex > playerCount) throw new RangeError('Invalid multiplayer identity');
  if (playerCount === 1) return [1, 2, 3, 4];
  if (playerCount === 2) return playerIndex === 1 ? [1, 2] : [3, 4];
  if (playerCount === 3) return playerIndex === 1 ? [1, 2] : [playerIndex + 1];
  return [playerIndex];
}

export function mapCharacterTargets(roles, physicalSlots, usePhysicalSlots) {
  return ordered(roles.flatMap(role => {
    const logical = usePhysicalSlots ? physicalSlots.indexOf(role.slot) + 1 : role.slot <= physicalSlots.length ? role.slot : 0;
    return logical ? [{ ...role, slot: logical }] : [];
  }));
}

export function desiredTeamRoles(requested, current, catalog) {
  const desired = new Array(current.length), remaining = current.map(slot => ({ ...slot }));
  if (!current.length || current.some(slot => !slot.name)) throw new TypeError('切换角色：队伍识别为空');
  for (const role of ordered(requested)) {
    if (role.slot > current.length) throw new RangeError('目标槽位超出可控角色数量');
    desired[role.slot - 1] = role;
    const index = remaining.findIndex(slot => matches(role, slot.name));
    if (index >= 0) remaining.splice(index, 1);
  }
  for (let index = 0; index < desired.length; index++) {
    if (desired[index]) continue;
    const original = remaining.findIndex(slot => slot.slot === index + 1);
    if (original < 0) continue;
    desired[index] = characterTarget(index + 1, remaining[original].name, catalog); remaining.splice(original, 1);
  }
  for (let index = 0; index < desired.length; index++) if (!desired[index]) {
    if (!remaining.length) throw new TypeError('切换角色：无法为未指定槽位生成补位角色');
    desired[index] = characterTarget(index + 1, remaining.shift().name, catalog);
  }
  return desired;
}

export function firstMismatchSlot(roles, current) { return ordered(roles).find(role => !matches(role, current[role.slot - 1]?.name))?.slot ?? null; }

class SwitchCharacterFlow {
  constructor(task, catalog) { this.task = task; this.catalog = catalog; this.host = task.host; this.attempts = new Map(); this.changed = false; }
  fail(message) { this.task.setupFail(message); }
  rect(frame, ...values) { const scale = this.task.scale(frame); return values.map(value => roundEven(value * scale)); }
  async contains(frame, text, roi1080) { return (await this.task.ocr(frame, this.rect(frame, ...roi1080))).some(region => region.text.includes(text)); }
  async partyPage(frame) { return this.contains(frame, '队伍配置', [119, 30, 108, 37]); }
  async characterList(frame) { return this.contains(frame, '元素共鸣', [1655, 32, 106, 30]); }
  async filterPanel(frame) { return this.contains(frame, '确认筛选', [360, 999, 128, 40]); }
  async text(texts, roi1080, click = true) {
    return this.task.captured(async frame => {
      const regions = await this.task.ocr(frame, this.rect(frame, ...roi1080));
      for (const text of Array.isArray(texts) ? texts : [texts]) {
        const match = regions.filter(region => region.text.includes(text)).sort((a, b) => a.y - b.y || a.x - b.x)[0];
        if (match) { if (click) await this.task.click(match); return true; }
      }
      return false;
    });
  }
  async retry(action, timeout, interval = 300) {
    const end = (this.host.now?.() ?? performance.now()) + timeout;
    do {
      this.task.check();
      if (await action()) return true;
      await this.task.sleep(interval);
    } while ((this.host.now?.() ?? performance.now()) < end);
    return false;
  }
  async detectPlayer() {
    let identity, lastError;
    const success = await this.retry(() => this.task.captured(async frame => {
      if (exists(await this.task.find(frame, 'Common/Job/SwitchCharacter', 'StandAloneIcon'))) { identity = { playerCount: 1, playerIndex: 1 }; return true; }
      let layout;
      try { layout = await this.host.vision('party.layout', { handle: frame.handle }); }
      catch (error) { this.task.check(); lastError = error; return false; }
      const status = layout.multiGameStatus;
      if (!status?.isInMultiGame) return false;
      const count = Math.max(1, status.playerCount);
      if (count === 1) { identity = { playerCount: 1, playerIndex: 1 }; return true; }
      if (!Number.isInteger(count) || count > 4) return false;
      const players = [];
      for (let index = 1; index <= 4; index++) if ((await this.task.find(frame, 'Common/Job/SwitchCharacter', index + 'PTopLeft', true)).length) players.push(index);
      if (players.length !== 1 || players[0] > count) return false;
      identity = { playerCount: count, playerIndex: players[0] }; return true;
    }), 5000);
    if (!success) this.fail('切换角色：等待单机图标、联机状态及唯一玩家标记超时' + (lastError ? ': ' + lastError.message : ''));
    this.identity = identity; this.physicalSlots = operablePhysicalSlots(identity.playerCount, identity.playerIndex);
  }
  async openParty() {
    await this.task.returnMainUi(); await this.detectPlayer();
    let unavailableCount = 0;
    const opened = await this.retry(async () => {
      await this.task.input('keyPress', ['L']); await this.task.sleep(2000);
      const state = await this.task.captured(async frame => ({ party: await this.partyPage(frame), unavailable: await this.contains(frame, '当前状态不可进行队伍配置', [806, 198, 314, 37]) }));
      if (state.party) return true;
      if (state.unavailable) {
        if (++unavailableCount > 2) this.fail('切换角色：七天神像重试后仍无法进行队伍配置');
        await this.task.statue({ pauseAfter: false });
      }
      return false;
    }, 15000, 500);
    if (!opened) this.fail('切换角色：队伍配置页面打开超时');
  }
  async clickSlot(slot) {
    const physical = this.physicalSlots[slot - 1];
    if (!physical) this.fail('切换角色：当前玩家不可操作槽位 ' + slot);
    await this.task.fixed('click', [470, 800, 1130, 1460][physical - 1], 550);
  }
  async grid(expectedCount) {
    let cards;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.task.captured(frame => this.host.vision('party.grid', { handle: frame.handle, roi: this.rect(frame, 24, 86, 766, 743), layout: 'PartySetupCharacters' }));
      if (!Array.isArray(result?.cards)) this.fail('切换角色：原版头像网格识别未返回卡片');
      cards = result.cards;
      if (cards.length >= expectedCount || attempt === 2) break;
      await this.task.sleep(200);
    }
    if (!cards.length) this.fail('切换角色：连续 3 次未检测到合法角色卡片');
    return [...cards].sort((a, b) => a.cardRect.y - b.cardRect.y || a.cardRect.x - b.cardRect.x);
  }
  async recognizeTeam(expectedCount) {
    await this.clickSlot(1);
    if (!await this.task.waitFor(frame => this.characterList(frame), 10, 300)) this.fail('切换角色：点击队伍槽位后未打开角色列表');
    let cards, failure;
    try { cards = await this.grid(expectedCount); }
    catch (error) { failure = error; throw error; }
    finally {
      try { await this.host.input('keyPress', ['VK_ESCAPE']); }
      catch (error) { if (!failure) throw error; this.host.log?.('error', 'Party character-list close failed: ' + error.message); }
    }
    if (!await this.task.waitFor(frame => this.partyPage(frame), 10, 300)) this.fail('切换角色：角色列表关闭后未返回队伍配置页');
    const names = cards.slice(0, expectedCount).map(card => card.score >= 0.7 ? card.name : null);
    if (names.length !== expectedCount || names.some(name => !name)) this.fail('切换角色：角色列表队伍识别不完整，期望 ' + expectedCount + ' 个');
    return names.map((name, index) => ({ slot: index + 1, name }));
  }
  async remove(slot) {
    await this.clickSlot(slot); await this.task.sleep(500);
    this.changed = true;
    if (!await this.text('换下', [382, 994, 87, 51])) this.fail('切换角色：未找到 ' + slot + ' 号位的换下按钮');
    let missing = 0;
    if (!await this.retry(() => this.task.captured(async frame => {
      missing = await this.partyPage(frame) && !await this.contains(frame, '换下', [382, 994, 87, 51]) ? missing + 1 : 0;
      return missing >= 2;
    }), 3000, 150)) this.fail('切换角色：换下操作未得到连续两帧确认');
    this.expectedCount--; this.dirty = true; this.changed = true;
  }
  async filter(role) {
    const metadata = this.metadata.get(role.candidateNames[0]);
    const weapon = role.forcedWeaponType ?? metadata?.weaponType, element = role.skipElementFilter ? null : metadata?.elementType;
    if (!weapon || !role.skipElementFilter && !element) this.fail('切换角色：原版头像模型缺少元素或武器元数据: ' + role.name);
    if (!await this.retry(async () => {
      await this.task.fixed('click', 66, 46);
      return this.task.waitFor(frame => this.filterPanel(frame), 13, 300);
    }, 9000)) this.fail('切换角色：筛选面板打开超时');
    for (const [text, roi] of [[element, [35, 150, 745, 360]], [weapon, [35, 560, 745, 280]]]) {
      if (!text) continue;
      let first = true;
      if (!await this.retry(async () => {
        if (await this.text(text, roi)) return true;
        if (first) { first = false; await this.task.fixed('click', 796, 125); }
        return false;
      }, 12000)) this.fail('切换角色：未找到筛选项 ' + text);
    }
    if (!await this.retry(() => this.text('确认筛选', [360, 999, 128, 40]), 12000)) this.fail('切换角色：未找到确认筛选按钮');
    if (!await this.task.waitFor(frame => this.characterList(frame), 20, 300)) this.fail('切换角色：筛选后未返回角色列表');
  }
  async friendship() {
    if (await this.text('好感', [116, 29, 245, 38], false)) return;
    for (const [text, roi, click] of [['顺序', [116, 29, 245, 38], true], ['好感', [111, 80, 241, 372], true], ['好感', [116, 29, 245, 38], false]]) if (!await this.retry(() => this.text(text, roi, click), 2000, 200)) this.fail('切换角色：设置好感排序失败，未找到 ' + text);
  }
  async findAvatar(role) {
    const cards = await this.grid(1), card = cards.find(card => card.score >= 0.7 && matches(role, card.name));
    if (!card) return false;
    await this.task.click(card.cardRect); await this.task.sleep(300); return true;
  }
  async submit(role) {
    const attempts = this.attempts.get(role.slot) ?? 0;
    if (attempts >= 3) this.fail('切换角色：' + role.slot + ' 号位连续 3 次未能切换为 ' + role.name);
    await this.clickSlot(role.slot); await this.filter(role);
    let found = false;
    if (role.useFriendshipSort) {
      await this.friendship();
      for (let attempt = 0; attempt < 3 && !found; attempt++) {
        await this.task.captured(async frame => { const button = await this.task.find(frame, 'Common/Job/SwitchCharacter', 'SortButton'); if (exists(button)) await this.task.click(button); });
        found = await this.findAvatar(role);
      }
    } else found = await this.findAvatar(role);
    if (!found) this.fail('切换角色：未找到目标角色 ' + role.name);
    this.changed = true;
    if (!await this.retry(() => this.text(['更换', '加入'], [382, 994, 87, 51]), 12000)) this.fail('切换角色：未找到更换或加入按钮');
    const append = role.slot > this.current.length;
    if (append) { this.current.push({ slot: role.slot, name: role.candidateNames[0] }); this.expectedCount++; }
    else this.current = this.current.map(slot => slot.slot === role.slot ? { ...slot, name: role.candidateNames[0] } : slot);
    this.attempts.set(role.slot, attempts + 1); this.needsVerification = true; this.changed = true;
    if (!await this.task.waitFor(frame => this.partyPage(frame), 10, 300)) this.fail('切换角色：提交角色后未返回队伍配置页');
  }
  startRebuild(slot) { this.rebuild = { slot, clearing: true, roles: ordered(this.desired.filter(role => role.slot >= slot)) }; }
  async run(requested, usePhysicalSlots) {
    await this.openParty();
    requested = mapCharacterTargets(requested, this.physicalSlots, usePhysicalSlots);
    if (!requested.length) {
      await this.task.returnMainUi();
      this.task.state.lastCharacterSwitch = { changed: false, verified: true, reason: 'noOperableTargets', ...this.identity, physicalSlots: this.physicalSlots };
      return true;
    }
    const metadata = await this.host.vision('party.gridMetadata', {});
    const characters = Array.isArray(metadata) ? metadata : metadata?.characters;
    if (!Array.isArray(characters) || !characters.length) this.fail('切换角色：原版头像模型元数据不可用');
    this.metadata = new Map(characters.map(character => [character.name, character]));
    this.current = await this.recognizeTeam(this.physicalSlots.length); this.expectedCount = this.current.length;
    this.desired = desiredTeamRoles(requested, this.current, this.catalog);
    while (true) {
      this.task.check();
      if (this.dirty) { this.current = await this.recognizeTeam(this.expectedCount); this.dirty = false; this.needsVerification = false; }
      if (this.rebuildAfterRemoval) {
        const mismatch = firstMismatchSlot(this.desired, this.current);
        if (mismatch == null) this.fail('切换角色：换下错位角色后无法确定补回槽位');
        this.startRebuild(mismatch); this.rebuildAfterRemoval = false;
      }
      if (this.rebuild) {
        if (this.rebuild.clearing && this.current.length > Math.max(1, this.rebuild.slot - 1)) { await this.remove(this.rebuild.slot); continue; }
        this.rebuild.clearing = false;
        if (this.rebuild.roles.length) { await this.submit(this.rebuild.roles.shift()); if (!this.rebuild.roles.length) this.rebuild = null; continue; }
        this.rebuild = null;
      }
      const role = ordered(requested).find(role => !matches(role, this.current[role.slot - 1]?.name)) ?? ordered(this.desired).find(role => !matches(role, this.current[role.slot - 1]?.name));
      if (!role) {
        if (this.needsVerification) { this.dirty = true; continue; }
        await this.task.returnMainUi();
        this.task.state.lastCharacterSwitch = { changed: this.changed, verified: true, team: this.current, ...this.identity, physicalSlots: this.physicalSlots };
        return true;
      }
      const misplaced = this.current.find(slot => slot.slot !== role.slot && matches(role, slot.name));
      if (misplaced) {
        if (this.current.length === 1) { this.startRebuild(1); continue; }
        await this.remove(misplaced.slot); this.rebuildAfterRemoval = true; continue;
      }
      await this.submit(role);
    }
  }
}

export async function runSwitchCharacter(task, slots, usePhysicalSlots = true) {
  if (typeof usePhysicalSlots !== 'boolean') throw new TypeError('usePhysicalSlots must be boolean');
  const catalog = await loadAvatarCatalog(task.host.sourceRoot), requested = parseCharacterTargets(slots, catalog);
  const flow = new SwitchCharacterFlow(task, catalog);
  let failure;
  try { return await flow.run(requested, usePhysicalSlots); }
  catch (error) { failure = error; throw error; }
  finally {
    if (flow.changed) {
      try { await task.clearCache(); }
      catch (error) { if (!failure) throw error; task.host.log?.('error', 'Party cache clear failed: ' + error.message); }
    }
  }
}
