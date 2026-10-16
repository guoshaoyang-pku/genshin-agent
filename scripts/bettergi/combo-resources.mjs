// SPDX-License-Identifier: GPL-3.0-or-later
// Original AutoCombo profiles, prompts and tool descriptions stay in the pinned source.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadAvatarCatalog } from './native.mjs';

const quoted = /"(?:[^"\\]|\\.)*"/g;
const decode = text => JSON.parse(text);
const field = (value, key, fallback) => value?.[Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase())] ?? fallback;

function catalogTools(source) {
  const tools = [];
  const methods = /\[Description\(("(?:[^"\\]|\\.)*")\)\]\s*public (?:virtual )?[\w<>]+\s+(\w+)\(([\s\S]*?)\)\s*(?:=>|\{)/g;
  for (const match of source.matchAll(methods)) {
    const properties = {}, required = [];
    const parameters = /(?:\[Description\(("(?:[^"\\]|\\.)*")\)\]\s*)?(string|bool|double|int)\s+(\w+)/g;
    for (const parameter of match[3].matchAll(parameters)) {
      properties[parameter[3]] = { type: ({ string: 'string', bool: 'boolean', double: 'number', int: 'integer' })[parameter[2]], ...(parameter[1] ? { description: decode(parameter[1]) } : {}) };
      required.push(parameter[3]);
    }
    tools.push({ name: match[2], description: decode(match[1]), parameters: { type: 'object', properties, required, additionalProperties: false } });
  }
  return tools;
}

export async function loadComboResources(sourceRoot) {
  const root = path.join(sourceRoot, 'BetterGenshinImpact/GameTask/AutoCombo/ComboBuild');
  const filenames = ['AvatarProfiles.cs', 'AutoComboBuildPrompts.cs', 'AutoComboBuildCatalog.cs', 'AutoComboBuildFallbackCatalog.cs', 'ClassicCompositesCatalog.cs', 'AutoComboBuildTools.cs'];
  const sources = await Promise.all(filenames.map(name => readFile(path.join(root, name), 'utf8')));
  const base = await readFile(path.resolve(sourceRoot, '../dependencies/CsTrees/meai-1.0.2/src/CsTrees.MEAI/BuildToolsBase.cs'), 'utf8');
  const [profileSource, promptSource, mainSource, fallbackSource, compositeSource, configSource] = sources;
  const profiles = new Map(), tagPairs = new Map();
  const profilePattern = /new\(("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"),\s*\[([^\]]*)\]\)/g;
  const validTags = new Set(['火元素', '水元素', '风元素', '雷元素', '草元素', '冰元素', '岩元素', '月兆', '星之楔']);
  const known = new Set((await loadAvatarCatalog(sourceRoot)).avatars.map(avatar => avatar.name));
  for (const match of profileSource.matchAll(profilePattern)) {
    const name = decode(match[1]), description = decode(match[2]), tags = [...match[3].matchAll(quoted)].map(item => decode(item[0]));
    if (!known.has(name) || tags.some(tag => !validTags.has(tag)) || tags.filter(tag => tag.endsWith('元素')).length !== 1 || profiles.has(name)) throw new Error('原版 AutoCombo 角色档案校验失败: ' + name);
    profiles.set(name, { name, description, tags });
  }
  const pairPattern = /new\(("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\)/g;
  for (const match of profileSource.matchAll(pairPattern)) {
    const a = decode(match[1]), b = decode(match[2]), description = decode(match[3]), key = [a, b].sort().join('|');
    if (!validTags.has(a) || !validTags.has(b) || tagPairs.has(key)) throw new Error('原版 AutoCombo 元素反应校验失败: ' + key);
    tagPairs.set(key, description);
  }
  const prompts = {};
  for (const match of promptSource.matchAll(/internal const string (Default\w+Body) = """\r?\n([\s\S]*?)\r?\n( *)""";/g)) {
    prompts[match[1]] = match[2].split(/\r?\n/).map(line => line.startsWith(match[3]) ? line.slice(match[3].length) : line).join('\n');
  }
  const baseTools = catalogTools(base).filter(tool => ['End', 'BuildTree', 'ResetTree', 'Undo'].includes(tool.name));
  const mainTools = [...catalogTools(mainSource), ...catalogTools(compositeSource), ...catalogTools(configSource), ...baseTools];
  const fallbackTools = [...catalogTools(fallbackSource), ...baseTools];
  if (!profiles.size || tagPairs.size !== 17 || !prompts.DefaultMainBody || !prompts.DefaultFallbackBody || mainTools.length !== 24 || fallbackTools.length !== 9) throw new Error('原版 AutoCombo 资源结构变化，拒绝使用不完整资源');
  return { profiles, tagPairs, prompts, mainTools, fallbackTools, filenames: filenames.map(name => path.join(root, name)) };
}

export function comboPrompt(resources, avatarNames, config = {}, { fallback = false, log } = {}) {
  const overrides = field(config, 'AvatarDescriptionOverrides', []);
  const team = avatarNames.map(name => {
    const builtIn = resources.profiles.get(name);
    const override = overrides.find(item => field(item, 'Name') === name);
    const description = field(override, 'Description', builtIn?.description);
    if (description == null) { log?.('warn', '角色 ' + name + ' 无内置战术描述，提示词中将只列出名字'); return '- ' + name; }
    const tags = builtIn?.tags ?? [];
    const first = description.indexOf('；'), sentence = description.slice(0, first);
    const adapted = first >= 0 && ['基础攻击', '重击', '蓄力'].every(text => sentence.includes(text)) ? '基础攻击普攻与下落为物理伤害，弓箭手角色重击暂无法适配，禁止使用' + description.slice(first) : description;
    return '- ' + name + '：' + tags.map(tag => tag + '角色').join('、') + '，' + adapted;
  }).join('\n');
  const custom = field(config, fallback ? 'FallbackPrompt' : 'MainPrompt', '');
  const body = custom.trim() ? custom : resources.prompts[fallback ? 'DefaultFallbackBody' : 'DefaultMainBody'];
  const sections = ['## 当前队伍\n' + team];
  if (!fallback) {
    const tags = [...new Set(avatarNames.flatMap(name => resources.profiles.get(name)?.tags ?? []))], pairs = [];
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
      const description = resources.tagPairs.get([tags[i], tags[j]].sort().join('|'));
      if (description) pairs.push('- ' + tags[i].replace('元素', '') + ' × ' + tags[j].replace('元素', '') + '：' + description);
    }
    if (pairs.length) sections.push('## 元素反应\n' + pairs.join('\n'));
    const extra = field(config, 'ExtraPrompt', '').trim();
    if (extra) sections.push('## 用户自定义要求\n' + extra);
  }
  return body + '\n\n' + sections.join('\n\n');
}
