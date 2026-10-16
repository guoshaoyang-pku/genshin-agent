// SPDX-License-Identifier: GPL-3.0-or-later
// CsTrees core1.0.5 lifecycle/composites and BetterGI AutoCombo nodes.
import { executeCombatCommand } from './native.mjs';

export const Status = Object.freeze({ Invalid: 'Invalid', Running: 'Running', Success: 'Success', Failure: 'Failure' });
const { Invalid, Running, Success, Failure } = Status;
const now = host => host.now?.() ?? performance.now();
const check = host => host.signal?.throwIfAborted();
const burstActiveContext = {};

export class ComboNode {
  constructor(name, update, { initialize, terminate, children = [] } = {}) {
    this.name = name; this.status = Invalid; this.children = children;
    this.update = update; this.initialize = initialize; this.terminate = terminate; this.current = null;
  }
  stop(status) {
    if (status === Invalid) {
      for (const child of this.children) if (child.status !== Invalid) child.stop(Invalid);
      this.current = null;
    }
    this.terminate?.(status); this.status = status;
  }
  async tick(visited) {
    if (this.status !== Running) await this.initialize?.();
    const status = await this.update();
    if (status !== Running) this.stop(status); else this.status = status;
    visited?.add(this); return this.status;
  }
  async handoff(visited) {
    if (this.status === Running) { this.status = Invalid; visited?.add(this); }
    return this.status;
  }
  snapshot(visited) {
    return { name: this.name, type: this.type ?? this.constructor.name, status: this.status, ...(this.feedback ? { feedback: this.feedback } : {}), ...(visited ? { visited: visited.has(this) } : {}), ...(this.children.length ? { children: this.children.map(child => child.snapshot(visited)) } : {}) };
  }
}

export class ComboComposite extends ComboNode {
  constructor(type, name, children, { memory = true } = {}) { super(name, null, { children }); this.type = type; this.memory = memory; }
  stop(status) {
    if (this.type.startsWith('Parallel')) for (const child of this.children) if (child.status === Running) child.stop(Invalid);
    super.stop(status);
  }
  resetChildren() { for (const child of this.children) if (child.status !== Invalid) child.stop(Invalid); }
  async tick(visited) {
    if (this.type.startsWith('Parallel')) return this.parallel(visited);
    const sequence = this.type === 'Sequence';
    let index = 0;
    if (this.status !== Running) {
      this.current = this.children[0] ?? null;
      if (sequence) this.resetChildren();
    } else if (this.memory) index = this.children.indexOf(this.current);
    else if (sequence) this.current = this.children[0] ?? null;
    if (!this.children.length) { this.stop(sequence ? Success : Failure); visited?.add(this); return this.status; }
    if (index < 0) throw new Error(this.type + ' reached an invalid current child');
    if (!sequence && this.memory) for (let i = 0; i < index; i++) if (this.children[i].status !== Invalid) this.children[i].stop(Invalid);
    const previous = this.current;
    for (let i = index; i < this.children.length; i++) {
      const child = this.children[i], status = await child.tick(visited);
      if (sequence ? status !== Success : status === Running || status === Success) {
        if (sequence && !this.memory) for (let j = i + 1; j < this.children.length; j++) if (this.children[j].status !== Invalid) this.children[j].stop(Invalid);
        if (!sequence) {
          this.current = child;
          if (previous !== child) for (let j = i + 1; j < this.children.length; j++) if (this.children[j].status !== Invalid) this.children[j].stop(Invalid);
        }
        if (status === Running) this.status = Running; else this.stop(status);
        visited?.add(this); return this.status;
      }
      if (sequence && i + 1 < this.children.length) this.current = this.children[i + 1];
    }
    this.stop(sequence ? Success : Failure);
    if (!sequence) this.current = this.children.at(-1);
    visited?.add(this); return this.status;
  }
  async parallel(visited) {
    const all = this.type === 'ParallelAll';
    if (this.status !== Running) { this.resetChildren(); this.current = null; }
    for (const child of this.children) {
      if (all && child.status === Success) continue;
      await child.tick(visited);
    }
    const failure = this.children.find(child => child.status === Failure);
    const success = all ? this.children.every(child => child.status === Success) : !this.children.length || this.children.some(child => child.status === Success);
    const status = failure ? Failure : success ? Success : Running;
    this.current = failure ?? (!all && success ? this.children.findLast(child => child.status === Success) : this.children.at(-1)) ?? null;
    if (status === Running) this.status = Running;
    else this.stop(status);
    visited?.add(this); return this.status;
  }
  async handoff(visited) {
    if (this.status !== Running) return this.status;
    const runners = this.type.startsWith('Parallel') ? this.children.filter(child => child.status === Running) : this.current?.status === Running ? [this.current] : [];
    for (const child of runners) await child.handoff(visited);
    if (!runners.some(child => child.status === Running)) this.status = Invalid;
    visited?.add(this); return this.status;
  }
}

export function recordedSkillState(avatar, time) {
  if (avatar.manualSkillCd > 0) return time - avatar.lastSkillAt >= avatar.manualSkillCd * 1000 ? 'Ready' : 'Cooldown';
  if (avatar.ocrReadyAt > avatar.lastSkillAt) return time > avatar.ocrReadyAt ? 'Ready' : 'Cooldown';
  return avatar.lastSkillAt === -Infinity ? 'Ready' : 'Unknown';
}

export async function skillState(combat, avatar, onlyCode01Ready = true) {
  const host = combat.host; check(host);
  if (avatar.manualSkillCd > 0) return recordedSkillState(avatar, now(host));
  const observed = await combat.captured(async frame => {
    if (await combat.active(frame, {}) !== avatar.index) return null;
    return host.vision('party.skill', { handle: frame.handle, nameEn: avatar.nameEn, maxSkillCd: avatar.skillCD, enableClassifier: true, onlyCode01Ready });
  });
  if (observed) {
    if (observed.state === 'Ready' && String(observed.code).toLowerCase() === '01') avatar.ocrReadyAt = now(host);
    if (observed.cd > 0) { avatar.ocrReadyAt = now(host) + observed.cd * 1000; combat.record?.(avatar.name, observed.cd); }
    if (observed.state !== 'Unknown') return observed.state;
  }
  return recordedSkillState(avatar, now(host));
}

export async function burstReady(combat, avatar) {
  return combat.captured(async frame => {
    const active = await combat.active(frame, burstActiveContext) === avatar.index;
    const cached = !active && !!avatar.isBurstReady;
    const ready = cached || (active ? (await combat.host.vision('party.burst', { handle: frame.handle })).state === 'Ready' : (await combat.host.vision('combo.burstSidebar', { handle: frame.handle, index: avatar.index })).ready);
    if (ready && !cached) avatar.isBurstReady = true;
    return !!ready;
  });
}

async function checkSkill(combat, avatar, onlyCode01Ready) {
  let state = await skillState(combat, avatar, onlyCode01Ready);
  if (state === 'Unknown') { await combat.switchAvatar({ name: avatar.name }); state = await skillState(combat, avatar, onlyCode01Ready); }
  return state === 'Ready';
}

async function cast(combat, avatar, skill, hold, conditional, onlyCode01Ready = true) {
  if (conditional && !(skill === 'E' ? await checkSkill(combat, avatar, onlyCode01Ready) : await burstReady(combat, avatar))) return false;
  if (skill === 'Q') avatar.isBurstReady = false;
  await combat.switchAvatar({ name: avatar.name });
  if (skill === 'E') await combat.useSkill({ name: avatar.name, hold }); else await combat.useBurst({ name: avatar.name });
  return true;
}

class ActionWindow extends ComboNode {
  constructor(spec, avatar, combat, blackboard, children) {
    super(spec.name, null, { children });
    this.type = spec.type; this.spec = spec; this.avatar = avatar; this.combat = combat; this.blackboard = blackboard;
    this.terminate = () => blackboard.delete('LeadCastingAvatar');
  }
  async tick(visited) {
    const host = this.combat.host; check(host);
    const resuming = this.status === Running && this.current?.status === Running;
    if (this.status !== Running) {
      for (const child of this.children) if (child.status !== Invalid) child.stop(Invalid);
      this.leadDone = false; this.index = 0; this.loops = 0; this.startAt = now(host);
      this.blackboard.set('LeadCastingAvatar', this.avatar);
    }
    if (!resuming) {
      if (!this.leadDone) {
        if (!await cast(this.combat, this.avatar, this.type.startsWith('UseSkill') ? 'E' : 'Q', this.spec.hold, true)) { this.stop(Failure); visited?.add(this); return this.status; }
        this.leadDone = true;
      }
      if (this.spec.times > 0) this.feedback = '第 ' + Math.min(this.loops + 1, this.spec.times) + '/' + this.spec.times + ' 轮';
      else {
        if (now(host) - this.startAt > this.spec.seconds * 1000) { this.stop(Success); visited?.add(this); return this.status; }
        this.feedback = '剩余 ' + Math.max(0, this.spec.seconds - (now(host) - this.startAt) / 1000).toFixed(1) + 's';
      }
    }
    this.current = this.children[this.index];
    if (await this.current.tick(visited) !== Running) {
      this.index = (this.index + 1) % this.children.length;
      if (this.spec.times > 0 && this.index === 0 && ++this.loops >= this.spec.times) { this.stop(Success); visited?.add(this); return this.status; }
    }
    this.status = Running; visited?.add(this); return this.status;
  }
  async handoff(visited) {
    if (this.status !== Running) return this.status;
    if (this.current?.status === Running) await this.current.handoff(visited);
    if (this.current?.status !== Running) this.status = Invalid;
    visited?.add(this); return this.status;
  }
}

export function createComboNode(spec, combat, blackboard = new Map()) {
  const children = (spec.children ?? []).map(child => createComboNode(child, combat, blackboard));
  if (['Sequence', 'Selector', 'ParallelAll', 'ParallelOne'].includes(spec.type)) return new ComboComposite(spec.type, spec.name, children, { memory: spec.memory ?? true });
  const avatar = combat.state.team.find(avatar => avatar.name === spec.avatarName);
  if (!avatar) throw new Error('角色不在当前队伍中: ' + spec.avatarName);
  if (spec.type.includes('ThenDoActions')) return new ActionWindow(spec, avatar, combat, blackboard, children);
  const host = combat.host;
  let startAt = null, lastClickAt = -Infinity;
  const node = new ComboNode(spec.name, async () => {
    check(host);
    const onlyCode01Ready = blackboard.get('LeadCastingAvatar') !== avatar;
    if (spec.type === 'IsSkillReady') return await checkSkill(combat, avatar, onlyCode01Ready) ? Success : Failure;
    if (spec.type === 'IsBurstReady') return await burstReady(combat, avatar) ? Success : Failure;
    if (['UseSkill', 'UseSkillIfReady', 'UseBurst', 'UseBurstIfReady'].includes(spec.type)) return await cast(combat, avatar, spec.type.startsWith('UseSkill') ? 'E' : 'Q', spec.hold, spec.type.endsWith('IfReady'), onlyCode01Ready) ? Success : Failure;
    if (spec.type === 'Attack') {
      const time = now(host);
      if (startAt === null) { await combat.switchAvatar({ name: avatar.name }); startAt = time; }
      if (time - startAt >= 1000) return Success;
      if (time - lastClickAt >= 200) { check(host); await host.input('leftButtonClick', []); lastClickAt = time; }
      return Running;
    }
    const method = spec.type.toLowerCase(), args = spec.type === 'Charge' ? ['1'] : spec.type === 'Walk' ? [spec.direction, String(spec.seconds)] : spec.type === 'Dash' ? [String(spec.seconds)] : [];
    const command = { name: avatar.name, method, args };
    const commandHost = Object.assign(Object.create(host), { combat: (operation, args) => combat.call(operation, args) });
    await executeCombatCommand(command, commandHost, { team: combat.state.team, checkFight: false });
    return Success;
  }, { initialize: spec.type === 'Attack' ? () => { startAt = null; } : undefined });
  node.type = spec.type; return node;
}
