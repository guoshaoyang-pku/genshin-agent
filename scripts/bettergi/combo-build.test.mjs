import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { comboPrompt, loadComboResources } from './combo-resources.mjs';
import { createComboBuilder, fetchComboModels, generateComboTree, parseXmlToolCalls, resolveComboProvider } from './combo-build.mjs';

const sourceRoot = fileURLToPath(new URL('../../third_party/bettergi/source', import.meta.url));
const resources = await loadComboResources(sourceRoot);
const avatars = () => ['钟离', '行秋', '纳西妲', '玛薇卡'].map((name, i) => ({ name, index: i + 1, manualSkillCd: 0 }));
const builder = (options = {}) => createComboBuilder(avatars(), { resources, ...options });
const settings = resolveComboProvider({ PlanningLlmEndpoint: 'http://localhost:8000/v1', ModelName: 'fixture-model' });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const call = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const chat = (tool_calls, extra = {}) => response({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', ...(tool_calls ? { tool_calls } : {}), ...extra } }] });

test('pinned C# profiles, prompts and exact tool descriptions are reused with complete schemas', async () => {
  assert.equal(resources.profiles.size, 120); assert.equal(resources.tagPairs.size, 17);
  assert.equal(resources.mainTools.length, 24); assert.equal(resources.fallbackTools.length, 9);
  assert.equal(new Set(resources.mainTools.map(tool => tool.name)).size, 24);
  const source = await readFile(resources.filenames.find(name => name.endsWith('AutoComboBuildPrompts.cs')), 'utf8');
  assert.ok(source.includes(resources.prompts.DefaultMainBody.split('\n')[0]));
  const tool = resources.mainTools.find(tool => tool.name === 'UseSkillIfReadyThenDoActionsByCount');
  assert.deepEqual(tool.parameters.required, ['name', 'avatarName', 'hold', 'times']);
  assert.equal(tool.parameters.properties.times.type, 'integer');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(!resources.fallbackTools.some(tool => tool.name === 'Sequence' || tool.name === 'UseSkill'));
  assert.ok(resources.mainTools.every(tool => !['RunTree', 'ShowTreeStatus'].includes(tool.name)));
});

test('prompt sections preserve original bow adaptation, overrides and tag pair order', () => {
  const main = comboPrompt(resources, ['甘雨', '行秋', 'unknown'], { MainPrompt: '自定义正文', ExtraPrompt: '  手动要求  ', AvatarDescriptionOverrides: [{ Name: '行秋', Description: '覆盖说明', Tags: ['火元素'] }] });
  assert.ok(main.startsWith('自定义正文\n\n'));
  assert.match(main, /弓箭手角色重击暂无法适配，禁止使用/);
  assert.match(main, /行秋：水元素角色，覆盖说明/);
  assert.match(main, /- unknown\n/);
  assert.match(main, /冰 × 水：冻结/);
  assert.ok(main.endsWith('## 用户自定义要求\n手动要求'));
  const fallback = comboPrompt(resources, ['甘雨', '行秋'], { FallbackPrompt: '兜底正文', ExtraPrompt: '忽略' }, { fallback: true });
  assert.ok(fallback.startsWith('兜底正文')); assert.doesNotMatch(fallback, /## 元素反应|用户自定义要求|忽略/);
});

test('builder guards root leaves and empty End without mutating checkpoint', () => {
  const b = builder();
  assert.match(b.invoke('Attack', { name: 'a', avatarName: '钟离' }).message, /^错误: .*root level/);
  assert.equal(b.isAtInitialCheckpoint, true);
  assert.ok(!b.tools().some(tool => ['ResetTree', 'Undo'].includes(tool.name)));
  b.invoke('Selector', { name: 'root' }); const before = b.operations.length;
  assert.match(b.invoke('End').message, /^错误: .*at least one child/);
  assert.equal(b.operations.length, before); assert.equal(b.frames.length, 2);
  b.invoke('Attack', { name: 'a', avatarName: '钟离' });
  assert.ok(b.tools().some(tool => tool.name === 'Undo'));
  b.invoke('End');
  assert.equal(b.spec().name, 'root'); assert.equal(b.frames.length, 1);
});

test('one operation Undo/Reset preserves manual cooldown and restores initial fallback scope', () => {
  const b = builder({ fallback: true });
  assert.equal(b.isAtInitialCheckpoint, true);
  assert.match(b.invoke('UseSkill', {}).message, /不提供工具/);
  b.invoke('Attack', { name: 'a', avatarName: '钟离' }); b.invoke('End');
  b.invoke('Undo'); assert.equal(b.frames.length, 2);
  b.invoke('Undo'); assert.equal(b.isAtInitialCheckpoint, true);
  assert.match(b.invoke('Undo').message, /没有可撤销/);
  const main = builder();
  main.invoke('SetManualSkillCd', { avatarName: '钟离', seconds: 15 });
  assert.equal(main.isAtInitialCheckpoint, true);
  main.invoke('Selector', { name: 's' }); main.invoke('Attack', { name: 'a', avatarName: '钟离' });
  assert.match(main.invoke('BuildTree').message, /构建成功/);
  assert.equal(main.frames.length, 0);
  assert.match(main.invoke('Undo').message, /树已构建/);
  assert.match(main.invoke('Attack', { name: 'b', avatarName: '钟离' }).message, /不能再修改/);
  assert.match(main.invoke('BuildTree').message, /树已构建/);
  main.invoke('ResetTree'); assert.equal(main.isAtInitialCheckpoint, true); assert.equal(main.avatars[0].manualSkillCd, 15);
  assert.equal(main.frames.length, 1); assert.equal(main.root, null);
});

test('preview is read-only construction marker and clears blackboard like CsTrees', () => {
  const bb = new Map([['LeadCastingAvatar', 1]]), b = builder({ blackboard: bb });
  b.invoke('Sequence', { name: 'outer' }); b.invoke('Selector', { name: 'inner' });
  bb.set('x', 2); const frameCount = b.frames.length, opCount = b.operations.length;
  assert.match(b.preview(), /inner \[Selector\]\n.*--> \.\.\./);
  assert.equal(b.frames.length, frameCount); assert.equal(b.operations.length, opCount); assert.equal(bb.size, 0);
  assert.match(b.invoke('BuildTree').message, /at least one child/);
  assert.equal(b.frames.length, frameCount);
});

test('build validation rejects aliases, malformed duration/count/direction/hold at source boundary', () => {
  const b = builder(); b.invoke('Selector', { name: 's' });
  for (const [type, args] of [
    ['Attack', { name: 'a', avatarName: '草神' }],
    ['Walk', { name: 'w', avatarName: '钟离', direction: 'north', seconds: 1 }],
    ['Dash', { name: 'd', avatarName: '钟离', seconds: 0 }],
    ['UseSkill', { name: 'e', avatarName: '钟离', hold: 'false' }],
    ['UseSkillIfReadyThenDoActionsByCount', { name: 'w', avatarName: '钟离', hold: false, times: 1.5 }],
    ['SetManualSkillCd', { avatarName: '钟离', seconds: -1 }],
  ]) assert.match(b.invoke(type, args).message, /^错误:/);
  assert.equal(b.operations.length, 1);
  b.invoke('Walk', { name: 'w', avatarName: '钟离', direction: ' W ', seconds: .5 }); b.invoke('BuildTree');
  assert.equal(b.spec().children[0].direction, 'w');
});

test('provider validation follows exact provider and explicit endpoint rules', () => {
  assert.equal(resolveComboProvider({ provider: 'AnThRoPiC', ModelName: 'm', ApiKey: 'secret' }).endpoint, 'https://api.anthropic.com');
  assert.equal(resolveComboProvider({ Provider: 'other', PlanningLlmEndpoint: 'http://[::1]:999/v1', ModelName: 'm' }).provider, 'openai');
  assert.throws(() => resolveComboProvider({}), /服务地址/);
  assert.throws(() => resolveComboProvider({ PlanningLlmEndpoint: 'http://remote.example', ModelName: 'm', ApiKey: 'secret' }), /HTTPS/);
  assert.throws(() => resolveComboProvider({ PlanningLlmEndpoint: 'https://example.org', ModelName: 'm' }), /密钥/);
  assert.throws(() => resolveComboProvider({ PlanningLlmEndpoint: 'http://localhost' }), /模型名/);
  assert.throws(() => resolveComboProvider({ PlanningLlmEndpoint: 'http://user:pw@localhost', ModelName: 'm' }), /无效/);
});

test('hidden XML supports both original function forms and typed scalar parameters only', () => {
  const calls = parseXmlToolCalls('<tool_call><function=UseSkill><parameter=name>E</parameter><parameter=avatarName>钟离</parameter><parameter=hold>False</parameter></tool_call><tool_call><function><name>Dash</name><parameter=seconds>1e-1</parameter></tool_call><tool_call><name>bad</name></tool_call>', 7);
  assert.deepEqual(calls, [{ id: 'fallback_7_0', name: 'UseSkill', args: { name: 'E', avatarName: '钟离', hold: false } }, { id: 'fallback_7_1', name: 'Dash', args: { seconds: .1 } }]);
  assert.deepEqual(parseXmlToolCalls('{"name":"Attack","arguments":{}}'), []);
});

test('OpenAI function loop guards tools, supplies corrections, compacts prior previews and returns built spec', async () => {
  const b = builder(), requests = [];
  const batches = [
    [call('Selector', { name: 'root' }), call('Attack', { name: 'bad', avatarName: 'unknown' })],
    [call('Attack', { name: 'a', avatarName: '钟离' }), call('BuildTree')],
    null,
  ];
  await generateComboTree(b, 'original prompt', settings, { fetch: async (url, options) => {
    assert.equal(url, 'http://localhost:8000/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer missing-api-key'); assert.equal(options.redirect, 'manual');
    requests.push(JSON.parse(options.body)); return chat(batches.shift());
  } });
  assert.equal(b.spec().children.length, 1); assert.equal(requests.length, 3);
  assert.ok(!requests[0].tools.some(tool => tool.function.name === 'ResetTree'));
  assert.ok(requests[1].tools.some(tool => tool.function.name === 'ResetTree'));
  assert.match(requests[1].messages.findLast(message => message.role === 'tool').content, /错误:.*unknown/);
  const previews = requests[2].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(previews.filter(result => result.tree != null).length, 1);
});

test('XML fallback is injected only without native calls; iteration cap and truncated output fail explicitly', async () => {
  const b = builder({ fallback: true }); let round = 0;
  await generateComboTree(b, 'p', settings, { fetch: async () => ++round === 1 ? chat(null, { reasoning_content: '<tool_call><function=Attack><parameter=name>A</parameter><parameter=avatarName>钟离</parameter></tool_call><tool_call><function=BuildTree></tool_call>' }) : chat(null) });
  assert.equal(b.spec().children[0].type, 'Attack');
  await assert.rejects(generateComboTree(builder(), 'p', settings, { maxIterations: 1, fetch: async () => chat([call('Selector', { name: 's' })]) }), /上限.*未执行/);
  await assert.rejects(generateComboTree(builder(), 'p', settings, { fetch: async () => response({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) }), /截断/);
  const native = builder({ fallback: true }); let r = 0;
  await generateComboTree(native, 'p', settings, { fetch: async () => ++r === 1 ? chat([call('Attack', { name: 'one', avatarName: '钟离' }), call('BuildTree')], { content: '<tool_call><function=Attack><parameter=name>two</parameter><parameter=avatarName>钟离</parameter></tool_call>' }) : chat(null) });
  assert.equal(native.spec().children.length, 1);
});

test('Anthropic request retains explicit model/schema/version and pairs tool-use results', async () => {
  const anthropic = resolveComboProvider({ Provider: 'anthropic', ModelName: 'm', ApiKey: 'fixture-key' }), b = builder({ fallback: true }), sent = [];
  await generateComboTree(b, 'system prompt', anthropic, { fetch: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.headers['x-api-key'], 'fixture-key');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body); sent.push(body);
    return response(sent.length === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'Attack', input: { name: 'a', avatarName: '钟离' } }, { type: 'tool_use', id: 'b', name: 'BuildTree', input: {} }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] });
  } });
  assert.equal(sent[0].max_tokens, 8192); assert.equal(sent[0].system, 'system prompt'); assert.ok(sent[0].tools[0].input_schema);
  assert.equal(sent[1].messages.at(-1).content.length, 2); assert.ok(sent[1].messages.at(-1).content.every(item => item.type === 'tool_result'));
  await assert.rejects(generateComboTree(builder(), 'p', anthropic, { fetch: async () => response({ stop_reason: 'max_tokens', content: [] }) }), /截断/);
});

test('model listing follows same-origin redirects and paginates effective URL with replacement cursors', async () => {
  const seen = [];
  const ids = await fetchComboModels({ Provider: 'anthropic', ApiKey: 'fixture-key' }, { fetch: async (url, options) => {
    assert.equal(options.redirect, 'manual'); seen.push(url);
    if (seen.length === 1) return new Response('', { status: 302, headers: { location: '/new-models?other=kept' } });
    if (seen.length === 2) return response({ data: [{ id: 'a' }, { id: 'b' }], has_more: true, last_id: 'b' });
    if (seen.length === 3) return response({ data: [{ id: 'b' }, { id: 'c' }], has_more: true, last_id: 'c' });
    return response({ data: [{ id: 'd' }], has_more: false });
  } });
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  for (const [i, cursor] of [[2, 'b'], [3, 'c']]) { const url = new URL(seen[i]); assert.equal(url.pathname, '/new-models'); assert.equal(url.searchParams.get('other'), 'kept'); assert.equal(url.searchParams.get('limit'), '1000'); assert.deepEqual(url.searchParams.getAll('after_id'), [cursor]); }
});

test('model errors, redirects, invalid pages, cancellation and credentials are bounded', async () => {
  const config = { Provider: 'anthropic', ApiKey: 'fixture-key' };
  await assert.rejects(fetchComboModels(config, { fetch: async () => new Response('', { status: 302, headers: { location: 'https://other.example/models' } }) }), /跨域/);
  await assert.rejects(fetchComboModels(config, { fetch: async () => new Response('', { status: 302, headers: { location: '/again' } }) }), /超过3次/);
  await assert.rejects(fetchComboModels(config, { fetch: async () => response({ data: [], has_more: true }) }), /last_id/);
  await assert.rejects(fetchComboModels(config, { fetch: async () => response({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }) }), /超过5页/);
  await assert.rejects(fetchComboModels(config, { fetch: async () => response({ data: [] }) }), /为空/);
  await assert.rejects(fetchComboModels(config, { fetch: async () => new Response('failure fixture-key', { status: 401 }) }), error => /redacted/.test(error.message) && !error.message.includes('fixture-key'));
  await assert.rejects(fetchComboModels(config, { fetch: async () => { throw new Error('network fixture-key'); } }), error => !error.message.includes('fixture-key'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchComboModels(config, { signal: controller.signal, fetch: async () => { throw new Error('must not request'); } }), { name: 'AbortError' });
});
