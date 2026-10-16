import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTaskParamTypes, defaultAutoFightConfig, defaultLeyLineFightConfig, GridScreenName, ItemIconRecognitionMode } from './task-params.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(root, 'third_party/bettergi/source/BetterGenshinImpact');
const scriptsRoot = path.join(root, 'third_party/bettergi/scripts/repo/js');
const combatRoot = path.join(root, 'third_party/bettergi/scripts/repo/combat');
const automatic = '根据队伍自动选择', combo = '自动连招（实验）';
const plain = value => JSON.parse(JSON.stringify(value));

function caseObject(object) {
  return new Proxy(object, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver);
      if (key === 'then' || key === 'toJSON') return undefined;
      for (let candidate = target; candidate; candidate = Object.getPrototypeOf(candidate)) {
        const found = Object.getOwnPropertyNames(candidate).find(name => name.toLowerCase() === key.toLowerCase());
        if (found) return Reflect.get(target, found, receiver);
      }
    },
    set(target, key, value, receiver) {
      const found = typeof key === 'string' && Object.keys(target).find(name => name.toLowerCase() === key.toLowerCase());
      return Reflect.set(target, found || key, value, receiver);
    },
  });
}

function list(items = []) {
  Object.defineProperties(items, {
    Count: { get: () => items.length },
    Add: { value: value => items.push(value) },
    Clear: { value: () => { items.length = 0; } },
    Contains: { value: value => items.includes(value) },
  });
  return caseObject(items);
}

function types(config = {}, options = {}) {
  return createTaskParamTypes({ caseObject, list, combatRoot, getConfig: () => config, ...options });
}

test('task constructors expose original public properties as RPC data', () => {
  const api = types();
  const files = {
    AutoDomainParam: 'GameTask/AutoDomain/AutoDomainParam.cs',
    AutoBossParam: 'GameTask/AutoBoss/AutoBossParam.cs',
    AutoFightParam: 'GameTask/AutoFight/AutoFightParam.cs',
    AutoLeyLineOutcropParam: 'GameTask/AutoLeyLineOutcrop/AutoLeyLineOutcropParam.cs',
    AutoStygianOnslaughtParam: 'GameTask/AutoStygianOnslaught/AutoStygianOnslaughtParam.cs',
    CountInventoryItemParam: 'GameTask/Common/Job/CountInventoryItemParam.cs',
  };
  for (const [name, filename] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(sourceRoot, filename), 'utf8');
    const fields = [...source.matchAll(/^    public (?:static )?[\w<>?]+ (\w+)\s*(?:\{|=|;)/gm)]
      .map(match => match[1]).filter(field => field !== 'FightFinishDetectConfig');
    assert.ok(fields.length > 3, filename);
    const data = plain(new api[name]());
    for (const field of fields) assert.ok(Object.hasOwn(data, field), name + '.' + field);
    assert.equal(Object.hasOwn(data, '__bgiType'), false);
    assert.equal(Object.hasOwn(data, 'args'), false);
  }
});

test('numeric grid/item enum values match original enum order and accept case-insensitive access', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'GameTask/Model/GameUI/GridScreenName.cs'), 'utf8');
  const names = [...source.matchAll(/^        (\w+),?\s*$/gm)].map(match => match[1]);
  assert.deepEqual(GridScreenName, Object.fromEntries(names.map((name, index) => [name, index])));
  assert.deepEqual(ItemIconRecognitionMode, { GridIcon: 0, Item: 1 });
  assert.equal(types().GridScreenName.materials, 4);
  assert.equal(types().ItemIconRecognitionMode.item, 1);
});

test('Domain preserves zero-as-unlimited, explicit paths, return-only strategy method and combo sentinel', () => {
  const { AutoDomainParam } = types({ autoFightConfig: { strategyName: 'global' } });
  const zero = new AutoDomainParam();
  assert.equal(zero.domainRoundNum, 9999);
  assert.equal(new AutoDomainParam(0).DomainRoundNum, 9999);
  assert.equal(new AutoDomainParam(-2).DomainRoundNum, -2);
  assert.equal(zero.CombatStrategyPath, path.join(combatRoot, 'global.txt'));
  assert.equal(zero.setCombatStrategyPath('sub\\one'), path.join(combatRoot, 'sub/one.txt'));
  assert.equal(zero.CombatStrategyPath, path.join(combatRoot, 'global.txt'));
  assert.equal(zero.SetCombatStrategyPath(combo), combo);
  assert.equal(zero.SetCombatStrategyPath(automatic), combatRoot);
  assert.equal(new AutoDomainParam(2, '/explicit').CombatStrategyPath, '/explicit');
});

test('Domain reloads config dynamically without overriding count or explicit path', () => {
  let config = { AutoDomainConfig: { PartyName: 'old' }, AutoArtifactSalvageConfig: { MaxArtifactStar: '3' } };
  const { AutoDomainParam } = types({}, { getConfig: () => config });
  const param = new AutoDomainParam(5, '/custom');
  config = { autoDomainConfig: { partyName: 'new', originalResin40UseCount: 4, rewardRecognitionEnabled: true }, autoArtifactSalvageConfig: { maxArtifactStar: '2' } };
  param.setDefault();
  assert.equal(param.PartyName, 'new');
  assert.equal(param.OriginalResin40UseCount, 4);
  assert.equal(param.RewardRecognitionEnabled, true);
  assert.equal(param.MaxArtifactStar, '2');
  assert.equal(param.DomainRoundNum, 5);
  assert.equal(param.CombatStrategyPath, '/custom');
});

test('Domain retains the original shared resin list and .NET list operations after reassignment', () => {
  const resin = ['原粹树脂'];
  const { AutoDomainParam } = types({ AutoDomainConfig: { ResinPriorityList: resin } });
  const first = new AutoDomainParam(), second = new AutoDomainParam();
  assert.equal(first.ResinPriorityList, second.ResinPriorityList);
  first.ResinPriorityList.add('浓缩树脂');
  assert.equal(second.ResinPriorityList.count, 2);
  first.setResinPriorityList('');
  assert.deepEqual(resin, ['']);
  first.SetResinPriorityList(['须臾树脂', '原粹树脂']);
  assert.equal(second.ResinPriorityList.Contains('须臾树脂'), true);
  first.SetResinPriorityList();
  assert.equal(second.ResinPriorityList.Count, 0);
  first.resinPriorityList = ['脆弱树脂'];
  first.ResinPriorityList.Add('原粹树脂');
  assert.equal(first.ResinPriorityList.Count, 2);
  assert.equal(second.ResinPriorityList.Count, 0);
});

test('Boss customized path survives strategy changes and default reload; reset method clears override', () => {
  const config = { AutoBossConfig: { StrategyName: 'global', BossName: '无相之雷' } };
  const { AutoBossParam } = types(config);
  const param = new AutoBossParam('/custom');
  param.strategyName = 'changed';
  assert.equal(param.CombatStrategyPath, '/custom');
  param.SetDefault();
  assert.equal(param.StrategyName, 'global');
  assert.equal(param.CombatStrategyPath, '/custom');
  assert.equal(param.setCombatStrategyPath('next'), undefined);
  assert.equal(param.CombatStrategyPath, path.join(combatRoot, 'next.txt'));
  param.StrategyName = 'again';
  assert.equal(param.CombatStrategyPath, path.join(combatRoot, 'again.txt'));
  param.StrategyName = ' \t';
  assert.equal(param.StrategyName, automatic);
  assert.equal(param.CombatStrategyPath, combatRoot);
  param.SetCombatStrategyPath(' ');
  assert.equal(param.StrategyName, 'global');
  param.SetCombatStrategyPath(combo);
  assert.equal(param.CombatStrategyPath, path.join(combatRoot, combo + '.txt'));
});

test('Boss copies task values without inventing UI bounds and transports accessor properties', () => {
  const { AutoBossParam } = types({ AutoBossConfig: { RunCount: -2, ReviveRetryCount: -4, Timeout: 0 } });
  const param = new AutoBossParam();
  assert.equal(param.RunCount, -2);
  assert.equal(param.ReviveRetryCount, -4);
  assert.equal(param.Timeout, 0);
  param.SetAutoBossConfig({ strategyName: 'copied', runCount: 7 });
  assert.equal(plain(param).StrategyName, 'copied');
  assert.equal(plain(param).CombatStrategyPath, path.join(combatRoot, 'copied.txt'));
  assert.equal(param.RunCount, 7);
});

test('Fight applies original config defaults, flattened finish settings and shared static swimming', () => {
  const { AutoFightParam } = types();
  const param = new AutoFightParam();
  assert.equal(param.FightFinishDetectEnabled, true);
  assert.equal(param.FinishDetectConfig.CheckEndDelay, '0.4;钟离,1.4;');
  assert.equal(param.FinishDetectConfig.BeforeDetectDelay, '0.4');
  assert.equal(param.FinishDetectConfig.PaimonEndCheckEnabled, false);
  assert.equal(param.RotaryFactor, 12);
  assert.equal(param.IsFirstCheck, false);
  assert.equal(param.BattleThresholdForLoot, -1);
  assert.equal(param.DamageNumberRecognitionMode, 2);
  assert.equal(param.SwimmingEnabled, true);
  const nested = new AutoFightParam.FightFinishDetectConfig();
  assert.equal(nested.PaimonEndCheckEnabled, true);
  assert.equal(nested.PaimonEndCheckDelay, 0.075);
  const configured = new AutoFightParam('/explicit', { timeout: 9, swimmingEnabled: false, finishDetectConfig: { checkBeforeBurst: true, rotaryFactor: 4 } });
  assert.equal(configured.CombatStrategyPath, '/explicit');
  assert.equal(configured.Timeout, 9);
  assert.equal(configured.CheckBeforeBurst, true);
  assert.equal(configured.RotaryFactor, 4);
  assert.equal(param.SwimmingEnabled, false);
  AutoFightParam.swimmingEnabled = true;
  assert.equal(plain(param).SwimmingEnabled, true);
  assert.equal(AutoFightParam.comboStrategyName, combo);
});

test('Fight default reload preserves threshold for null and preserves explicit strategy path', () => {
  const config = { AutoFightConfig: { BattleThresholdForLoot: 5 } };
  const { AutoFightParam } = types(config);
  const param = new AutoFightParam('first');
  config.AutoFightConfig = { BattleThresholdForLoot: null, Timeout: 71 };
  param.SetDefault();
  assert.equal(param.BattleThresholdForLoot, 5);
  assert.equal(param.Timeout, 71);
  assert.equal(param.CombatStrategyPath, path.join(combatRoot, 'first.txt'));
  assert.equal(param.setCombatStrategyPath(combo), undefined);
  assert.equal(param.CombatStrategyPath, combo);
  config.AutoFightConfig.BattleThresholdForLoot = 0;
  param.SetDefault();
  assert.equal(param.BattleThresholdForLoot, 0);
});

test('Fight ResolveStrategyPath checks real JSON before TXT and preserves tuple fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bgi-task-params-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'team.json'), '{}');
  fs.writeFileSync(path.join(directory, 'team.txt'), '');
  const { AutoFightParam } = types({}, { combatRoot: directory });
  assert.deepEqual(plain(AutoFightParam.resolveStrategyPath('team')), { Item1: path.join(directory, 'team.json'), Item2: 'json' });
  assert.deepEqual(plain(AutoFightParam.ResolveStrategyPath('missing')), { Item1: path.join(directory, 'missing.txt'), Item2: 'txt' });
  assert.deepEqual(plain(AutoFightParam.ResolveStrategyPath(automatic)), { Item1: directory, Item2: 'txt' });
  assert.deepEqual(plain(AutoFightParam.ResolveStrategyPath(combo)), { Item1: combo, Item2: 'combo' });
});

test('Leyline preserves constructor overrides and independent original fight defaults', () => {
  const { AutoLeyLineOutcropParam } = types();
  const defaults = new AutoLeyLineOutcropParam();
  assert.equal(defaults.Count, 6);
  assert.equal(defaults.Country, '蒙德');
  assert.equal(defaults.LeyLineOutcropType, '启示之花');
  assert.equal(defaults.Timeout, 120);
  assert.equal(defaults.ScanDropsAfterRewardSeconds, 12);
  assert.equal(defaults.FightConfig.SeekEnemyIntervalSeconds, 3);
  assert.equal(defaults.FightConfig.FinishDetectConfig.RotaryFactor, 10);
  const param = new AutoLeyLineOutcropParam(0, '璃月', '藏金之花');
  assert.equal(param.Count, 0);
  assert.equal(param.Country, '璃月');
  assert.equal(param.LeyLineOutcropType, '藏金之花');
  param.SetAutoLeyLineOutcropConfig({ fightConfig: null, count: 2 });
  assert.equal(param.Count, 2);
  assert.equal(param.FightConfig.Timeout, 120);
});

test('Leyline shares its original fight object, normalizes lowercase once and preserves copy/conversion semantics', () => {
  const nested = { checkEndDelay: '0.8' };
  const fight = { timeout: 17, finishDetectConfig: nested, seekEnemyEnabled: true };
  const { AutoLeyLineOutcropParam } = types({ AutoLeyLineOutcropConfig: { FightConfig: fight } });
  const first = new AutoLeyLineOutcropParam(), second = new AutoLeyLineOutcropParam();
  assert.equal(first.FightConfig, second.FightConfig);
  first.FightConfig.timeout = 19;
  assert.equal(second.FightConfig.timeout, 19);
  assert.equal(fight.Timeout, 19);
  first.FightConfig.FinishDetectConfig.checkEndDelay = '1.3';
  assert.equal(nested.CheckEndDelay, '1.3');
  first.FightConfig.copyFromAutoFightConfig({ Timeout: 42, KazuhaPickupEnabled: true, QinDoublePickUp: true, FinishDetectConfig: { RotaryFactor: 9 } });
  assert.equal(first.FightConfig.Timeout, 42);
  assert.equal(first.FightConfig.SeekEnemyEnabled, true);
  const converted = first.FightConfig.toAutoFightConfig();
  assert.equal(converted.Timeout, 42);
  assert.equal(converted.FinishDetectConfig.RotaryFactor, 9);
  assert.equal(converted.PickDropsAfterFightEnabled, false);
  assert.equal(converted.PickDropsAfterFightSeconds, 0);
  assert.equal(converted.KazuhaPickupEnabled, false);
  assert.equal(converted.QinDoublePickUp, false);
  assert.equal(converted.OnlyPickEliteDropsMode, 'DisableAutoPickupForNonElite');
  assert.equal(converted.BattleThresholdForLoot, null);
  converted.FinishDetectConfig.RotaryFactor = 99;
  assert.equal(first.FightConfig.FinishDetectConfig.RotaryFactor, 9);
});

test('Stygian clones resin priorities, uses AutoFight fallback and treats combo as a file', () => {
  const resin = ['脆弱树脂'];
  const config = { AutoFightConfig: { StrategyName: 'fight' }, AutoStygianOnslaughtConfig: { ResinPriorityList: resin, BossNum: 3 } };
  const { AutoStygianOnslaughtParam } = types(config);
  const first = new AutoStygianOnslaughtParam(), second = new AutoStygianOnslaughtParam();
  assert.equal(first.BossNum, 3);
  assert.equal(first.CombatScriptBagPath, path.join(combatRoot, 'fight.txt'));
  first.SetResinPriorityList('原粹树脂', '');
  assert.deepEqual(resin, ['脆弱树脂']);
  assert.deepEqual(plain(second.ResinPriorityList), ['脆弱树脂']);
  first.SetAutoStygianOnslaughtConfig({ ResinPriorityList: null, StrategyName: combo });
  assert.deepEqual(plain(first.ResinPriorityList), ['浓缩树脂', '原粹树脂']);
  assert.equal(first.CombatScriptBagPath, path.join(combatRoot, combo + '.txt'));
  first.setCombatStrategyPath(' \t');
  assert.equal(first.CombatScriptBagPath, combatRoot);
  assert.equal(new AutoStygianOnslaughtParam('/custom').CombatScriptBagPath, '/custom');
});

test('Inventory defers validation, resets null and preserves list APIs after assignment', () => {
  const { CountInventoryItemParam } = types({ OtherConfig: { ItemIconRecognitionMode: 0 } });
  const param = new CountInventoryItemParam();
  assert.equal(param.GridScreenName, null);
  assert.equal(param.IconRecognitionMode, 0);
  assert.equal(param.StopByItemSort, false);
  assert.throws(() => param.validate(), /不能为空/);
  param.itemNames.add('松木');
  assert.equal(param.itemNames.count, 1);
  assert.doesNotThrow(() => param.Validate());
  param.ItemNames = ['桦木'];
  param.ItemNames.Add('杉木');
  assert.deepEqual(plain(param.ItemNames), ['桦木', '杉木']);
  param.ItemNames = ['  '];
  assert.throws(() => param.Validate(), /空名称/);
  param.ItemNames = null;
  assert.throws(() => param.Validate(), /不能为空/);
  assert.equal(param.ItemNames.Count, 0);
});

test('constructors reject unsupported overloads and invalid CLR argument types', () => {
  const api = types();
  for (const args of [['3'], [1.5], [2147483648], [1, '/path', 'extra']]) assert.throws(() => new api.AutoDomainParam(...args), TypeError);
  assert.throws(() => new api.AutoBossParam(4), TypeError);
  assert.throws(() => new api.AutoFightParam('one', 'two'), TypeError);
  assert.throws(() => new api.AutoLeyLineOutcropParam(1), TypeError);
  assert.throws(() => new api.AutoLeyLineOutcropParam(1, 2, '花'), TypeError);
  assert.throws(() => new api.AutoStygianOnslaughtParam(4), TypeError);
  assert.throws(() => new api.CountInventoryItemParam([]), TypeError);
});

test('unchanged original Boss helper runs with real Fight parameters', async () => {
  const source = fs.readFileSync(path.join(scriptsRoot, '批量讨伐角色养成材料BOSS/src/auto-fight.js'), 'utf8');
  let received;
  const context = vm.createContext({ ...types(), dispatcher: { runAutoFightTask: async param => { received = plain(param); } } });
  vm.runInContext(source.replace('export async function', 'async function'), context);
  await context.runAutoFight({ strategyName: '雷神', timeout: 23 });
  assert.equal(received.CombatStrategyPath, path.join(combatRoot, '雷神.txt'));
  assert.equal(received.Timeout, 23);
  assert.equal(received.FightFinishDetectEnabled, true);
  assert.equal(received.FinishDetectConfig.FastCheckEnabled, false);
  assert.equal(received.PickDropsAfterFightEnabled, false);
  assert.equal(received.KazuhaPickupEnabled, false);
  assert.equal(received.OnlyPickEliteDropsMode, 'Close');
});

test('unchanged original wood inventory parameter block uses enums and List.Add', async () => {
  const source = fs.readFileSync(path.join(scriptsRoot, 'AutoWoodcutting-Pathing/main.js'), 'utf8');
  const block = source.match(/const param = new CountInventoryItemParam\(\);[\s\S]*?const resultDict = await dispatcher\.runCountInventoryItemTask\(param\);/);
  assert.ok(block);
  let received;
  const context = vm.createContext({ ...types(), woodsArray: ['松木', '桦木'], woodType: ['杉木'], dispatcher: { runCountInventoryItemTask: async param => { received = plain(param); return {}; } } });
  await vm.runInContext('(async () => {\n' + block[0] + '\n})()', context);
  assert.equal(received.GridScreenName, GridScreenName.Materials);
  assert.equal(received.IconRecognitionMode, ItemIconRecognitionMode.Item);
  assert.deepEqual(received.ItemNames, ['松木', '桦木']);
});

test('default config helpers allocate independent nested objects', () => {
  const first = defaultAutoFightConfig(), second = defaultAutoFightConfig();
  first.FinishDetectConfig.RotaryFactor = 91;
  assert.equal(second.FinishDetectConfig.RotaryFactor, 12);
  const leyline = defaultLeyLineFightConfig();
  leyline.FinishDetectConfig.RotaryFactor = 92;
  assert.equal(defaultLeyLineFightConfig().FinishDetectConfig.RotaryFactor, 10);
});
