// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI task parameter/config constructors at c9db8b8291fe4ac25a600aee1582298005919eb2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const automatic = '根据队伍自动选择', combo = '自动连招（实验）';
const resinDefaults = () => ['浓缩树脂', '原粹树脂'];
const field = (object, name, fallback) => { const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name.toLowerCase()); return key === undefined ? fallback : object[key]; };
const values = (defaults, config) => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, field(config, key, fallback)]));
const copy = (target, source, names) => { for (const name of names) target[name] = source[name]; };
const empty = text => text == null || text === '';
const blank = text => text == null || text.trim() === '';
const integer = value => { if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new TypeError('参数必须是 Int32'); return value; };
const text = value => { if (value != null && typeof value !== 'string') throw new TypeError('参数必须是字符串'); return value; };
const object = value => { if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('参数必须是配置对象'); return value; };
const overload = (name, count, allowed) => { if (!allowed.includes(count)) throw new TypeError(name + ' 不支持此构造参数数量'); };

export const GridScreenName = Object.freeze(Object.fromEntries(['Weapons', 'Artifacts', 'CharacterDevelopmentItems', 'Food', 'Materials', 'Gadget', 'Quest', 'PreciousItems', 'Furnishings', 'ArtifactSalvage', 'ArtifactSetFilter', 'Crafting', 'PartySetupCharacters'].map((name, index) => [name, index])));
export const ItemIconRecognitionMode = Object.freeze({ GridIcon: 0, Item: 1 });

export function defaultAutoFightConfig() {
  return { StrategyName: automatic, TeamNames: '', FightFinishDetectEnabled: true, ActionSchedulerByCd: '', OnlyPickEliteDropsMode: 'Closed',
    FinishDetectConfig: { FastCheckEnabled: false, RotateFindEnemyEnabled: false, FastCheckParams: '', CheckAfterSwitchAvatar: false, CheckEndDelay: '0.4;钟离,1.4;', BeforeDetectDelay: '0.4', RotaryFactor: 12, IsFirstCheck: false, CheckBeforeBurst: false, SkipFightEndCheckWhenEnemyVisible: false, BlockCheckBeforeBattleSeconds: 0, PaimonEndCheckEnabled: false, PaimonEndCheckDelay: 0.2 },
    PickDropsAfterFightEnabled: true, PickDropsAfterFightSeconds: 15, BattleThresholdForLoot: null, KazuhaPickupEnabled: true, QinDoublePickUp: false,
    GuardianAvatar: '', GuardianCombatSkip: false, GuardianAvatarHold: false, BurstEnabled: false, KazuhaPartyName: '', SwimmingEnabled: true, ExpBasedPickupEnabled: false,
    Timeout: 120, EnableCombatTargeting: false, LockLostWaitTime: 0.5, TargetingDetectionInterval: 50, DamageNumberRecognitionMode: 2, DrawRecognitionResults: true };
}

export function defaultLeyLineFightConfig() {
  return { StrategyName: '', TeamNames: '', FightFinishDetectEnabled: true, ActionSchedulerByCd: '',
    FinishDetectConfig: { FastCheckEnabled: false, RotateFindEnemyEnabled: false, FastCheckParams: '', CheckAfterSwitchAvatar: false, CheckEndDelay: '', BeforeDetectDelay: '', RotaryFactor: 10, IsFirstCheck: false, CheckBeforeBurst: false, SkipFightEndCheckWhenEnemyVisible: false, BlockCheckBeforeBattleSeconds: 0, PaimonEndCheckEnabled: false, PaimonEndCheckDelay: 0.1 },
    GuardianAvatar: '', GuardianCombatSkip: false, GuardianAvatarHold: false, BurstEnabled: false, SwimmingEnabled: false, KazuhaPickupEnabled: true, QinDoublePickUp: false,
    Timeout: 120, SeekEnemyEnabled: false, SeekEnemyIntervalSeconds: 3, SeekEnemyRotaryFactor: 6 };
}

export function createTaskParamTypes({ caseObject = value => value, list = value => value, getConfig = () => ({}), combatRoot = fileURLToPath(new URL('../../third_party/bettergi/scripts/repo/combat', import.meta.url)), existsSync = fs.existsSync } = {}) {
  combatRoot = path.resolve(combatRoot);
  const defaults = {
    AutoFightConfig: defaultAutoFightConfig(),
    AutoDomainConfig: { PartyName: '', DomainName: '', SundaySelectedValue: '', AutoArtifactSalvage: false, SpecifyResinUse: false, ResinPriorityList: resinDefaults(), OriginalResinUseCount: 0, OriginalResin20UseCount: 0, OriginalResin40UseCount: 0, CondensedResinUseCount: 0, TransientResinUseCount: 0, FragileResinUseCount: 0, RewardRecognitionEnabled: false },
    AutoBossConfig: { BossName: '', StrategyName: automatic, TeamName: '', SpecifyRunCount: false, RunCount: 1, UseTransientResin: false, UseFragileResin: false, ReviveRetryCount: 3, ReturnToStatueAfterEachRound: false, RewardRecognitionEnabled: false, Timeout: 240 },
    AutoLeyLineOutcropConfig: { Count: 6, Country: '蒙德', LeyLineOutcropType: '启示之花', OpenModeCountMin: false, IsResinExhaustionMode: false, FriendshipTeam: '', Team: '', Timeout: 120, FightConfig: defaultLeyLineFightConfig(), IsGoToSynthesizer: false, UseFragileResin: false, UseTransientResin: false, ScanDropsAfterRewardEnabled: false, ScanDropsAfterRewardSeconds: 12 },
    AutoStygianOnslaughtConfig: { StrategyName: '', BossNum: 1, AutoArtifactSalvage: false, SpecifyResinUse: false, ResinPriorityList: resinDefaults(), OriginalResinUseCount: 0, CondensedResinUseCount: 0, TransientResinUseCount: 0, FragileResinUseCount: 0, FightTeamName: '' },
    AutoArtifactSalvageConfig: { MaxArtifactStar: '4' }, OtherConfig: { ItemIconRecognitionMode: 1 },
  };
  const section = name => values(defaults[name], field(getConfig(), name, {}));
  const lists = new WeakMap();
  const asList = items => {
    if (items == null) return null;
    if (!Array.isArray(items)) throw new TypeError('列表参数必须是数组');
    if (!lists.has(items)) { const wrapped = list(items); lists.set(items, wrapped); lists.set(wrapped, wrapped); }
    return lists.get(items);
  };
  const listProperty = (target, name, initial) => {
    let items = asList(initial);
    Object.defineProperty(target, name, { enumerable: true, get: () => items, set: value => { items = asList(value); } });
  };
  const priorities = (target, args) => {
    const names = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    for (const name of names) text(name);
    if (target.ResinPriorityList == null) throw new TypeError('ResinPriorityList 不能为 null');
    target.ResinPriorityList.splice(0, target.ResinPriorityList.length, ...names);
  };
  const strategyFile = (name, extension) => path.resolve(combatRoot + path.sep + String(name ?? '').replaceAll('\\', '/') + extension);
  const strategyPath = (name, allowCombo = false) => name === automatic ? combatRoot : allowCombo && name === combo ? combo : strategyFile(name, '.txt');
  const fightConfig = supplied => {
    const config = values(defaults.AutoFightConfig, supplied);
    config.FinishDetectConfig = values(defaults.AutoFightConfig.FinishDetectConfig, config.FinishDetectConfig);
    return config;
  };
  const leyFightObjects = new WeakMap();
  const normalizeInPlace = (target, fallback) => {
    const normalized = values(fallback, object(target));
    for (const key of Object.keys(target)) {
      if (!Object.hasOwn(normalized, key) && Object.keys(normalized).some(name => name.toLowerCase() === key.toLowerCase())) delete target[key];
    }
    return Object.assign(target, normalized);
  };
  const leyFightConfig = supplied => {
    const config = supplied ?? defaultLeyLineFightConfig();
    if (leyFightObjects.has(config)) return leyFightObjects.get(config);
    const fallback = defaultLeyLineFightConfig();
    normalizeInPlace(config, fallback);
    config.FinishDetectConfig = caseObject(normalizeInPlace(config.FinishDetectConfig ?? {}, fallback.FinishDetectConfig), 'LeyLineFightFinishDetectConfig', false);
    Object.defineProperties(config, {
      CopyFromAutoFightConfig: { value: source => {
        source = fightConfig(object(source));
        copy(config, source, ['StrategyName', 'TeamNames', 'FightFinishDetectEnabled', 'ActionSchedulerByCd', 'GuardianAvatar', 'GuardianCombatSkip', 'GuardianAvatarHold', 'BurstEnabled', 'SwimmingEnabled', 'KazuhaPickupEnabled', 'QinDoublePickUp', 'Timeout']);
        copy(config.FinishDetectConfig, source.FinishDetectConfig, Object.keys(fallback.FinishDetectConfig));
      } },
      ToAutoFightConfig: { value: () => {
        const result = defaultAutoFightConfig();
        copy(result, config, ['StrategyName', 'TeamNames', 'FightFinishDetectEnabled', 'ActionSchedulerByCd', 'GuardianAvatar', 'GuardianCombatSkip', 'GuardianAvatarHold', 'BurstEnabled', 'SwimmingEnabled', 'Timeout']);
        Object.assign(result, { PickDropsAfterFightEnabled: false, PickDropsAfterFightSeconds: 0, KazuhaPickupEnabled: false, QinDoublePickUp: false, OnlyPickEliteDropsMode: 'DisableAutoPickupForNonElite', KazuhaPartyName: '', BattleThresholdForLoot: null });
        result.FinishDetectConfig = caseObject({ ...config.FinishDetectConfig }, 'AutoFightFinishDetectConfig', false);
        return caseObject(result, 'AutoFightConfig', false);
      } },
    });
    const wrapped = caseObject(config, 'AutoLeyLineOutcropFightConfig', false);
    leyFightObjects.set(config, wrapped); leyFightObjects.set(wrapped, wrapped);
    return wrapped;
  };

  class AutoDomainParam {
    constructor(...args) {
      overload('AutoDomainParam', args.length, [0, 1, 2]);
      listProperty(this, 'ResinPriorityList', []);
      this.DomainRoundNum = integer(args[0] ?? 0) || 9999;
      this.CombatStrategyPath = args.length === 2 ? text(args[1]) : this.SetCombatStrategyPath();
      this.SetDefault(); return caseObject(this, 'AutoDomainParam', false);
    }
    SetDefault() {
      const config = section('AutoDomainConfig');
      copy(this, config, Object.keys(defaults.AutoDomainConfig));
      this.ResinPriorityList = asList(config.ResinPriorityList);
      this.MaxArtifactStar = section('AutoArtifactSalvageConfig').MaxArtifactStar;
    }
    SetCombatStrategyPath(strategyName = null) {
      text(strategyName);
      if (empty(strategyName)) strategyName = section('AutoFightConfig').StrategyName;
      return strategyPath(strategyName, true);
    }
    SetResinPriorityList(...names) { priorities(this, names); }
  }

  class AutoBossParam {
    constructor(...args) {
      overload('AutoBossParam', args.length, [0, 1]);
      let strategyName = automatic, combatStrategyPath = strategyPath(automatic), customized = false;
      Object.defineProperties(this, {
        StrategyName: { enumerable: true, get: () => strategyName, set: value => { text(value); strategyName = blank(value) ? automatic : value; if (!customized) combatStrategyPath = strategyPath(strategyName); } },
        CombatStrategyPath: { enumerable: true, get: () => combatStrategyPath, set: value => { text(value); combatStrategyPath = value; customized = !blank(value); } },
      });
      Object.defineProperty(this, 'SetCombatStrategyPath', { value: (name = null) => {
        text(name); if (blank(name)) name = section('AutoBossConfig').StrategyName;
        strategyName = blank(name) ? automatic : name; combatStrategyPath = strategyPath(strategyName); customized = false;
      } });
      this.SetDefault();
      if (args.length) this.CombatStrategyPath = text(args[0]);
      return caseObject(this, 'AutoBossParam', false);
    }
    SetDefault() { this.SetAutoBossConfig(section('AutoBossConfig')); }
    SetAutoBossConfig(config) { copy(this, values(defaults.AutoBossConfig, object(config)), Object.keys(defaults.AutoBossConfig)); }
  }

  class FightFinishDetectConfig {
    constructor() {
      Object.assign(this, { FastCheckEnabled: false, FastCheckParams: '', CheckAfterSwitchAvatar: false, CheckEndDelay: '', BeforeDetectDelay: '', RotateFindEnemyEnabled: false, SkipFightEndCheckWhenEnemyVisible: false, BlockCheckBeforeBattleSeconds: 0, PaimonEndCheckEnabled: true, PaimonEndCheckDelay: 0.075 });
      return caseObject(this, 'FightFinishDetectConfig', false);
    }
  }
  const applyFightConfig = (target, config) => {
    copy(target, config, ['Timeout', 'FightFinishDetectEnabled', 'PickDropsAfterFightEnabled', 'PickDropsAfterFightSeconds', 'KazuhaPickupEnabled', 'ActionSchedulerByCd', 'KazuhaPartyName', 'OnlyPickEliteDropsMode', 'GuardianAvatar', 'GuardianCombatSkip', 'GuardianAvatarHold', 'BurstEnabled', 'QinDoublePickUp', 'EnableCombatTargeting', 'TargetingDetectionInterval', 'DrawRecognitionResults', 'LockLostWaitTime', 'DamageNumberRecognitionMode', 'ExpBasedPickupEnabled']);
    copy(target.FinishDetectConfig, config.FinishDetectConfig, Object.keys(new FightFinishDetectConfig()));
    copy(target, config.FinishDetectConfig, ['CheckBeforeBurst', 'IsFirstCheck', 'RotaryFactor']);
    target.BattleThresholdForLoot = config.BattleThresholdForLoot ?? target.BattleThresholdForLoot;
    AutoFightParam.SwimmingEnabled = config.SwimmingEnabled;
  };
  class AutoFightParam {
    static ComboStrategyName = combo;
    static SwimmingEnabled = false;
    static FightFinishDetectConfig = FightFinishDetectConfig;
    constructor(...args) {
      overload('AutoFightParam', args.length, [0, 1, 2]);
      this.FinishDetectConfig = new FightFinishDetectConfig();
      this.BattleThresholdForLoot = -1;
      // The enumerable accessor carries the original shared static value across the worker RPC.
      Object.defineProperty(this, 'SwimmingEnabled', { enumerable: true, get: () => AutoFightParam.SwimmingEnabled, set: value => { AutoFightParam.SwimmingEnabled = value; } });
      if (args.length === 2) { this.CombatStrategyPath = text(args[0]); applyFightConfig(this, fightConfig(object(args[1]))); }
      else { this.SetCombatStrategyPath(args[0]); this.SetDefault(); }
      return caseObject(this, 'AutoFightParam', false);
    }
    SetCombatStrategyPath(strategyName = null) {
      text(strategyName); if (empty(strategyName)) strategyName = section('AutoFightConfig').StrategyName;
      this.CombatStrategyPath = strategyPath(strategyName, true);
    }
    static ResolveStrategyPath(strategyName) {
      text(strategyName);
      if (strategyName === automatic || strategyName === combo) return caseObject({ Item1: strategyPath(strategyName, true), Item2: strategyName === combo ? 'combo' : 'txt' }, 'ValueTuple', false);
      const json = strategyFile(strategyName, '.json'), found = existsSync(json);
      return caseObject({ Item1: found ? json : strategyPath(strategyName), Item2: found ? 'json' : 'txt' }, 'ValueTuple', false);
    }
    SetDefault() { applyFightConfig(this, fightConfig(section('AutoFightConfig'))); }
  }

  class AutoLeyLineOutcropParam {
    constructor(...args) {
      overload('AutoLeyLineOutcropParam', args.length, [0, 3]); this.SetDefault();
      if (args.length) { this.Count = integer(args[0]); this.Country = text(args[1]); this.LeyLineOutcropType = text(args[2]); }
      return caseObject(this, 'AutoLeyLineOutcropParam', false);
    }
    SetDefault() { this.SetAutoLeyLineOutcropConfig(section('AutoLeyLineOutcropConfig')); }
    SetAutoLeyLineOutcropConfig(config) {
      const normalized = values(defaults.AutoLeyLineOutcropConfig, object(config));
      copy(this, normalized, Object.keys(defaults.AutoLeyLineOutcropConfig));
      this.FightConfig = leyFightConfig(normalized.FightConfig);
    }
  }

  class AutoStygianOnslaughtParam {
    constructor(...args) {
      overload('AutoStygianOnslaughtParam', args.length, [0, 1]); listProperty(this, 'ResinPriorityList', []); this.SetDefault();
      if (args.length) this.CombatScriptBagPath = text(args[0]);
      return caseObject(this, 'AutoStygianOnslaughtParam', false);
    }
    SetDefault() { this.SetAutoStygianOnslaughtConfig(section('AutoStygianOnslaughtConfig')); }
    SetAutoStygianOnslaughtConfig(config) {
      const normalized = values(defaults.AutoStygianOnslaughtConfig, object(config));
      copy(this, normalized, Object.keys(defaults.AutoStygianOnslaughtConfig).filter(key => key !== 'StrategyName'));
      this.ResinPriorityList = asList([...(normalized.ResinPriorityList ?? resinDefaults())]);
      this.SetCombatStrategyPath(normalized.StrategyName);
    }
    SetCombatStrategyPath(strategyName = null) {
      text(strategyName); if (empty(strategyName)) strategyName = section('AutoFightConfig').StrategyName;
      this.CombatScriptBagPath = blank(strategyName) ? combatRoot : strategyPath(strategyName);
    }
    SetResinPriorityList(...names) { priorities(this, names); }
  }

  class CountInventoryItemParam {
    constructor(...args) {
      overload('CountInventoryItemParam', args.length, [0]);
      this.GridScreenName = null; listProperty(this, 'ItemNames', []);
      this.IconRecognitionMode = section('OtherConfig').ItemIconRecognitionMode; this.StopByItemSort = false;
      return caseObject(this, 'CountInventoryItemParam', false);
    }
    Validate() {
      this.ItemNames ??= asList([]);
      if (!Array.isArray(this.ItemNames)) throw new TypeError('参数ItemNames必须是列表');
      if (!this.ItemNames.length) throw new TypeError('参数ItemNames不能为空');
      if (this.ItemNames.some(name => typeof name !== 'string' || blank(name))) throw new TypeError('参数ItemNames不能包含空名称');
    }
  }
  return Object.fromEntries(Object.entries({ AutoDomainParam, AutoBossParam, AutoFightParam, AutoLeyLineOutcropParam, AutoStygianOnslaughtParam, CountInventoryItemParam, GridScreenName: { ...GridScreenName }, ItemIconRecognitionMode: { ...ItemIconRecognitionMode } }).map(([name, type]) => [name, caseObject(type, name, false)]));
}
