import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ArtifactAffix, ArtifactAffixType, ArtifactStat, DEFAULT_SALVAGE_JAVASCRIPT,
  RecognitionFailurePolicy, isMatchJavaScript, isMatchRegularExpression, salvageParameters } from './salvage.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(process.env.BETTERGI_SOURCE_ROOT ?? path.join(project, 'third_party/bettergi/source'), 'BetterGenshinImpact/GameTask/AutoArtifactSalvage');
const affix = (type, value = 10, inactive = false) => new ArtifactAffix(type, value, inactive);
const artifact = (types = ['ATK', 'DEF']) => new ArtifactStat('测试圣遗物', affix('HP', 4780), types.map(type => affix(type)), 0);

test('configuration and enums agree with retained original source', async () => {
  const config = await readFile(path.join(source, 'AutoArtifactSalvageConfig.cs'), 'utf8');
  assert.equal(config.match(/_javaScript = @"([\s\S]*?)";/)[1], DEFAULT_SALVAGE_JAVASCRIPT);
  assert.deepEqual(salvageParameters({}), { star: 4, javaScript: DEFAULT_SALVAGE_JAVASCRIPT, artifactSetFilter: '', maxNumToCheck: 100, recognitionFailurePolicy: 0, culture: 'zh-Hans', mode: 1 });
  const enums = await readFile(path.join(source, 'ArtifactAffix.cs'), 'utf8');
  assert.deepEqual(Object.keys(ArtifactAffixType), [...enums.matchAll(/\{ ArtifactAffixType\.(\w+),/g)].map(match => match[1]));
  assert.deepEqual(RecognitionFailurePolicy, { Skip: 0, Abort: 1 });
});
test('parameters preserve null and case-insensitive source fields', () => {
  const value = salvageParameters({ star: 2, JAVASCRIPT: null, MaxNumToCheck: null, recognitionFailurePolicy: null }, { AutoArtifactSalvageConfig: { JavaScript: 'Output = true;' } });
  assert.equal(value.javaScript, null); assert.equal(value.maxNumToCheck, null); assert.equal(value.recognitionFailurePolicy, null); assert.equal(value.star, 2);
  assert.equal(salvageParameters({ RecognitionFailurePolicy: 'aBORT' }).recognitionFailurePolicy, 1);
  assert.equal(salvageParameters({ Culture: null }, { OtherConfig: { GameCultureInfoName: 'en-US' } }).culture, 'en-US');
  for (const Star of [0, 5, '4', 1.2, Infinity]) assert.throws(() => salvageParameters({ Star }));
});
test('ArtifactStat preserves float32, original structured text and enum constructor', () => {
  const value = new ArtifactStat('测试', affix(5, 46.6), [affix('ATK', 19), affix('DEF', 23, true)], 20);
  assert.equal(value.MainAffix.Value, Math.fround(46.6));
  assert.equal(value.ToStructuredString(), 'Properties\n├─Name: 测试\n├─MainAffix: HPPercent, 46.6\n├─MinorAffixes: \n│\t├─[0]: ATK, 19\n│\t└─[1]: DEF, 23, Unactivated\n└─Level: 20');
});
test('default JS evaluates flat affixes with a fresh engine per item', async () => {
  assert.equal(await isMatchJavaScript(artifact(['ATK', 'DEF']), DEFAULT_SALVAGE_JAVASCRIPT), true);
  assert.equal(await isMatchJavaScript(artifact(['HP', 'DEF']), DEFAULT_SALVAGE_JAVASCRIPT), true);
  assert.equal(await isMatchJavaScript(artifact(['ATKPercent', 'DEF']), DEFAULT_SALVAGE_JAVASCRIPT), false);
  assert.equal(await isMatchJavaScript(artifact(), 'var hidden = 1; Output = true;'), true);
  assert.equal(await isMatchJavaScript(artifact(), 'Output = typeof hidden === "undefined";'), true);
});
test('JS supports case-insensitive members, Array.from, enum ToString and private setters', async () => {
  const value = artifact();
  assert.equal(await isMatchJavaScript(value, 'ArtifactStat.level = 20; Output = ArtifactStat.LEVEL === 0 && ArtifactStat.minoraffixes.Length === 2 && Array.from(ArtifactStat.minoraffixes)[0].type.ToString() === "ATK" && ArtifactStat.tostructuredstring().includes("测试");'), true);
  assert.equal(value.Level, 0);
  assert.equal(await isMatchJavaScript(value, 'Output = typeof process === "undefined" && typeof require === "undefined" && typeof ARTIFACT_JSON === "undefined";'), true);
});
test('Output must be an enumerable global boolean without coercion', async () => {
  for (const script of ['let Output = true;', 'const Output = true;', 'Object.defineProperty(globalThis,"Output",{value:true});']) await assert.rejects(isMatchJavaScript(artifact(), script), /没有设置Output/);
  for (const script of ['Output = 1;', 'Output = "true";', 'Output = new Boolean(true);', 'Output = null;']) await assert.rejects(isMatchJavaScript(artifact(), script), /不是布尔类型/);
  await assert.rejects(isMatchJavaScript(artifact(), 'throw new Error("broken");'), /JavaScript execution error: broken/);
  await assert.rejects(isMatchJavaScript(artifact(), 'throw null;'), /JavaScript execution error: null/);
});
test('original three-second interruption catches infinite filters', async () => {
  const start = performance.now();
  await assert.rejects(isMatchJavaScript(artifact(), 'while (true) {}'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
  assert.ok(performance.now() - start >= 2900);
  assert.ok(performance.now() - start < 8000);
});
test('regex helper messages distinguish empty and nonempty matches', () => {
  assert.deepEqual(isMatchRegularExpression('攻击力+19\n防御力+23\n', '(?=攻击力)'), { success: true, message: '匹配成功！' });
  assert.deepEqual(isMatchRegularExpression('攻击力+19', '攻击力'), { success: true, message: '匹配成功：攻击力' });
  assert.deepEqual(isMatchRegularExpression('攻击力', '生命'), { success: false, message: '匹配失败！' });
});
