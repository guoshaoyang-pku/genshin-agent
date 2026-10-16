// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoComboBuildTask, ComboTreeSession and AutoComboRunTask.
import { CombatTasks } from './combat.mjs';
import { AutoFightTask } from './fight.mjs';
import { comboPrompt, loadComboResources } from './combo-resources.mjs';
import { createComboBuilder, generateComboTree, resolveComboProvider } from './combo-build.mjs';
import { ComboComposite, ComboNode, Status } from './combo-tree.mjs';

export { createComboBuilder, fetchComboModels } from './combo-build.mjs';
export { loadComboResources } from './combo-resources.mjs';

const field = (value, key, fallback) => value?.[Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase())] ?? fallback;
const now = host => host.now?.() ?? performance.now();
const exists = region => region?.width > 0 && region?.height > 0;
let lastFightCheckAt = -Infinity;
const observedTeams = new WeakSet();

export class ComboTreeSession {
  constructor({ builder, fallbackBuilder, avatars, blackboard = new Map(), builtAt = new Date().toISOString() }) {
    this.builder = builder; this.fallbackBuilder = fallbackBuilder; this.avatars = avatars; this.blackboard = blackboard; this.builtAt = builtAt;
  }
  async bindAndBuild(combat) {
    const observed = await combat.initializeTeam({ force: true, requireObserved: true });
    const names = new Set(observed.map(avatar => avatar.name)), retained = new Set(this.avatars.map(avatar => avatar.name));
    if ([...names].some(name => !retained.has(name)) || [...retained].some(name => !names.has(name))) throw new Error('给定队伍成员与当前游戏内队伍不一致');
    for (const avatar of this.avatars) {
      avatar.indexRect = observed.find(item => item.name === avatar.name).indexRect;
      avatar.isBurstReady = false; avatar.lastSkillAt = avatar.ocrReadyAt = -Infinity; avatar.enableESkillClassify = true;
    }
    combat.state.team = this.avatars;
    this.blackboard.clear();
    return { comboTree: this.builder.build(combat, this.blackboard), fallbackTree: this.fallbackBuilder.build(combat, this.blackboard) };
  }
}

export async function observeComboParty(host, { combat = new CombatTasks(host, { EnableESkillClassify: true }) } = {}) {
  const inDomain = () => combat.captured(async frame => exists(await combat.find(frame, 'Common/Element', 'InDomain')));
  host.signal?.throwIfAborted();
  if (!await inDomain()) await combat.returnMainUi();
  const validUi = await combat.captured(async frame => await combat.isInMainUi(frame) || exists(await combat.find(frame, 'Common/Element', 'InDomain')));
  if (!validUi) throw new Error('未能返回主界面或识别到秘境界面，无法识别队伍角色');
  const avatars = await combat.initializeTeam({ force: true, requireObserved: true });
  host.signal?.throwIfAborted();
  const observation = { avatars }; observedTeams.add(observation); return observation;
}

export async function buildComboSession(host, config = {}, { combat = new CombatTasks(host, { EnableESkillClassify: true }), observedTeam, fetch, onPreview, resources } = {}) {
  host.signal?.throwIfAborted();
  observedTeam ??= await observeComboParty(host, { combat });
  if (!observedTeams.has(observedTeam)) throw new TypeError('Combo build requires an observed party receipt');
  const avatars = observedTeam.avatars, blackboard = new Map();
  for (const avatar of avatars) avatar.enableESkillClassify = true;
  resources ??= await loadComboResources(host.sourceRoot);
  const builder = createComboBuilder(avatars, { blackboard, resources });
  const options = { fetch, signal: host.signal, onPreview };
  try {
    const settings = resolveComboProvider(config);
    await generateComboTree(builder, comboPrompt(resources, avatars.map(avatar => avatar.name), config, { log: host.log }), settings, options);
    let fallbackBuilder = createComboBuilder(avatars, { blackboard, resources, fallback: true });
    try {
      await generateComboTree(fallbackBuilder, comboPrompt(resources, avatars.map(avatar => avatar.name), config, { fallback: true, log: host.log }), settings, options);
    } catch (error) {
      host.signal?.throwIfAborted();
      if (error.name === 'AbortError') throw error;
      host.log?.('warn', '兜底建树失败，降级为队伍首位普攻');
      fallbackBuilder = createComboBuilder(avatars, { blackboard, resources, fallback: true });
      fallbackBuilder.invoke('Attack', { name: '降级普攻', avatarName: avatars[0].name });
      fallbackBuilder.invoke('BuildTree');
      await onPreview?.({ fallback: true, tree: fallbackBuilder.preview(), complete: true, degraded: true });
    }
    return new ComboTreeSession({ builder, fallbackBuilder, avatars, blackboard });
  } catch (error) {
    await onPreview?.({ fallback: false, tree: builder.preview(), failed: true });
    throw error;
  }
}

export function comboSkillCooldowns(avatars, time) {
  return avatars.map(avatar => ({
    name: avatar.name, index: avatar.index,
    seconds: avatar.manualSkillCd > 0 ? Math.max(0, avatar.manualSkillCd - (time - avatar.lastSkillAt) / 1000) : avatar.ocrReadyAt > avatar.lastSkillAt ? Math.max(0, (avatar.ocrReadyAt - time) / 1000) : avatar.lastSkillAt === -Infinity ? 0 : null,
  }));
}

export class AutoComboTask extends AutoFightTask {
  constructor(host, { config = {}, taskConfig = {}, session, onSnapshot, ...fightOptions } = {}, state = {}) {
    const enabled = field(taskConfig, 'FightFinishDetectEnabled', true);
    super(host, { ...fightOptions, config: { ...config, FightFinishDetectEnabled: enabled, EnableESkillClassify: true }, strategies: [] }, state);
    this.session = session; this.onSnapshot = onSnapshot; this.finishEnabled = enabled;
  }
  start() { return this.run(this.session); }
  async run(session = this.session) {
    if (!session) throw new Error('尚未构建行为树，请先运行一次自动连招任务完成建树');
    let targeting, overlay, root, ticks = 0, ended = false, paused = false;
    this.state.fightStartAt = now(this.host); this.state.fightActive = true; this.state.skipCheckCounter = 0;
    try {
      this.host.signal?.throwIfAborted();
      const { comboTree, fallbackTree } = await session.bindAndBuild(this);
      root = new ComboComposite('Selector', '-', [comboTree, fallbackTree], { memory: false });
      if (this.finishEnabled) {
        const finish = new ComboNode('战斗结束检测', async () => {
          if (now(this.host) - lastFightCheckAt >= this.finish.checkTime * 1000) {
            lastFightCheckAt = now(this.host);
            if (await this.checkFight({ delayTime: this.finish.delayTime, detectDelayTime: this.finish.detectDelayTime })) { ended = true; return Status.Failure; }
          }
          return Status.Success;
        });
        root = new ComboComposite('Sequence', '-', [finish, root], { memory: true });
      }
      if (this.options.EnableCombatTargeting) {
        await this.host.vision('party.resetTargetTracker', {});
        targeting = this.background(worker => worker.targetTick(), this.options.TargetingDetectionInterval, { cleanup: true });
      }
      if (this.onSnapshot) overlay = this.background(async () => this.onSnapshot({ kind: 'cooldowns', at: now(this.host), cooldowns: comboSkillCooldowns(session.avatars, now(this.host)) }), 100);
      while (!ended) {
        this.host.signal?.throwIfAborted();
        const visited = new Set();
        await root.tick(visited); ticks++;
        await this.onSnapshot?.({ kind: 'tree', ticks, comboTree: comboTree.snapshot(visited), fallbackTree: fallbackTree.snapshot(visited) });
        if (!ended) { await this.host.sleep(35); this.host.signal?.throwIfAborted(); }
      }
    } catch (error) {
      if (this.host.signal?.aborted || error.name === 'AbortError') paused = true; else throw error;
    } finally {
      this.state.fightActive = false;
      try {
        try { await targeting?.stop(); } finally { await overlay?.stop(); }
      } finally {
        root?.stop(Status.Invalid); session.blackboard.clear();
        const clearHost = Object.assign(Object.create(this.host), { signal: null });
        await this.seeker.stopMovements();
        await clearHost.input('releaseAll', []);
        if (session.avatars.some(avatar => avatar.name === '玛薇卡')) {
          const cleanupCombat = new CombatTasks(clearHost, this.options, this.state);
          for (const avatar of session.avatars) if (avatar.name !== '玛薇卡') await cleanupCombat.switchAvatar({ name: avatar.name });
        }
      }
    }
    return { paused, ended, ticks, team: session.avatars.map(avatar => avatar.name), builtAt: session.builtAt };
  }
}
