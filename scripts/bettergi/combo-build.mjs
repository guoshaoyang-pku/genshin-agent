// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoCombo build tools and CsTrees.MEAI1.0.2 conversation lifecycle.
import { createComboNode } from './combo-tree.mjs';

const field = (value, key, fallback) => value?.[Object.keys(value ?? {}).find(name => name.toLowerCase() === key.toLowerCase())] ?? fallback;
const composites = new Set(['Sequence', 'Selector', 'ParallelAll', 'ParallelOne']);
const basics = new Set(['Attack', 'Charge', 'Walk', 'Dash', 'Jump']);
const baseTools = new Set(['End', 'BuildTree', 'ResetTree', 'Undo']);

function ascii(spec) {
  const lines = [];
  function visit(node, prefix = '', branch = '') {
    lines.push(prefix + branch + (node.type === 'RenderTerminator' ? '--> ...' : node.name + ' [' + node.type + ']'));
    node.children?.forEach((child, i) => visit(child, prefix + (branch ? branch.startsWith('└') ? '    ' : '│   ' : ''), i === node.children.length - 1 ? '└── ' : '├── '));
  }
  visit(spec); return lines.join('\n');
}

export class ComboBuilder {
  constructor(avatars, { fallback = false, blackboard = new Map(), resources } = {}) {
    this.avatars = avatars; this.fallback = fallback; this.blackboard = blackboard; this.resources = resources;
    this.frames = [{ blackboard }]; this.operations = []; this.root = null; this.built = false;
    if (fallback) this.add('Sequence', { name: '兜底攻击序列' });
    this.checkpoint = this.operations.length;
  }
  get isAtInitialCheckpoint() { return !this.built && this.operations.length === this.checkpoint; }
  tools() {
    return (this.fallback ? this.resources.fallbackTools : this.resources.mainTools).filter(tool => !this.isAtInitialCheckpoint || !['ResetTree', 'Undo'].includes(tool.name));
  }
  parent() { return this.frames.findLast(frame => frame.node)?.node; }
  validate(type, args) {
    const schema = (this.fallback ? this.resources?.fallbackTools : this.resources?.mainTools)?.find(tool => tool.name === type)?.parameters;
    if (schema) for (const key of schema.required) {
      const expected = schema.properties[key].type, value = args[key];
      if (expected === 'integer' ? !Number.isInteger(value) : typeof value !== (expected === 'number' ? 'number' : expected)) throw new TypeError(key + ' 参数类型应为 ' + expected);
    }
    if (args.avatarName !== undefined && !this.avatars.some(avatar => avatar.name === args.avatarName)) throw new Error('角色“' + args.avatarName + '”不在当前队伍中');
    if (args.seconds !== undefined && type !== 'SetManualSkillCd' && !(args.seconds > 0)) throw new RangeError('seconds 必须大于0');
    if (args.times !== undefined && (!Number.isInteger(args.times) || args.times <= 0)) throw new RangeError('times 必须为正整数');
    if (type === 'Walk' && !/^[wasd]$/i.test(String(args.direction).trim())) throw new RangeError('walk方向必须是w/a/s/d');
  }
  add(type, args) {
    this.validate(type, args);
    const open = composites.has(type) || type.includes('ThenDoActions');
    const parent = this.parent();
    if (!open && !parent) throw new Error('Cannot add leaf node at root level. Use a composite or decorator as the root.');
    const node = { type, ...args, ...(type === 'Walk' ? { direction: args.direction.trim().toLowerCase() } : {}), ...(open ? { children: [] } : {}) };
    parent?.children.push(node);
    if (open) this.frames.push({ node });
    this.operations.push({ kind: open ? 'open' : 'leaf', node, parent });
  }
  end() {
    const frame = this.frames.at(-1);
    if (!frame) throw new Error('No scope to end.');
    if (frame.node && !frame.node.children.length) throw new Error('Composite must have at least one child.');
    this.frames.pop();
    const setRoot = !!frame.node && !this.parent();
    if (setRoot) this.root = frame.node;
    this.operations.push({ kind: 'end', frame, setRoot });
  }
  undo() {
    const op = this.operations.pop();
    if (op.kind === 'end') { if (op.setRoot) this.root = null; this.frames.push(op.frame); }
    else { if (op.kind === 'open') this.frames.pop(); op.parent?.children.pop(); }
  }
  preview() {
    try {
      const root = this.frames.find(frame => frame.node)?.node ?? this.root;
      if (!root) return null;
      const deepest = this.parent();
      const copy = node => ({ ...node, ...(node.children ? { children: [...node.children.map(copy), ...(node === deepest ? [{ type: 'RenderTerminator' }] : [])] } : {}) });
      return ascii(copy(root));
    } finally { this.blackboard.clear(); }
  }
  format(message) { const tree = this.built ? ascii(this.root) : this.preview(); return { message, ...(tree ? { tree } : {}) }; }
  invoke(type, args = {}) {
    try {
      if (this.fallback && !basics.has(type) && !baseTools.has(type)) throw new Error('兜底建树不提供工具: ' + type);
      if (type === 'SetManualSkillCd') {
        this.validate(type, args);
        if (Number.isNaN(args.seconds) || args.seconds < 0) throw new RangeError('手动CD秒数不能为负数或非数字');
        this.avatars.find(avatar => avatar.name === args.avatarName).manualSkillCd = args.seconds;
        return { message: args.avatarName + (args.seconds > 0 ? ' 的E技能手动CD已设为 ' + args.seconds + ' 秒' : ' 的手动CD已取消，恢复动态识别') };
      }
      if (type === 'ResetTree') {
        while (this.operations.length > this.checkpoint) this.undo();
        this.blackboard.clear(); this.built = false;
        return { message: '构建器已重置，可以从头开始构建行为树。' };
      }
      if (this.built) {
        if (type === 'BuildTree') return this.format('树已构建。如需重建请先调用 ResetTree。');
        throw new Error(type === 'Undo' ? '树已构建，不能撤销。如需重建请先调用 ResetTree。' : '树已构建，不能再修改。');
      }
      if (type === 'Undo') { if (this.operations.length <= this.checkpoint) throw new Error('没有可撤销的操作。'); this.undo(); return this.format('已撤销上一次构建操作。'); }
      if (type === 'End') { this.end(); return this.format('已关闭当前作用域'); }
      if (type === 'BuildTree') {
        while (this.frames.length) this.end();
        this.spec(); this.built = true; return this.format('行为树构建成功！');
      }
      if (this.resources && !(this.fallback ? this.resources.fallbackTools : this.resources.mainTools).some(tool => tool.name === type)) throw new Error('未知工具: ' + type);
      this.add(type, args); return this.format('已添加 ' + type + ': ' + args.name);
    } catch (error) { return { message: '错误: ' + (type === 'BuildTree' ? '构建失败: ' : '') + error.message }; }
  }
  spec() {
    if (!this.root) throw new Error(this.frames.length ? 'Tree is incomplete. Did you forget to call End()?' : 'Tree is empty. Add at least one node.');
    return structuredClone(this.root);
  }
  build(combat, blackboard = this.blackboard) { return createComboNode(this.spec(), combat, blackboard); }
}

export const createComboBuilder = (avatars, options) => new ComboBuilder(avatars, options);

export function resolveComboProvider(config = {}, { requireModel = true } = {}) {
  const provider = String(field(config, 'Provider', 'openai')).toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
  const endpointText = String(field(config, 'PlanningLlmEndpoint', '')).trim();
  if (!endpointText && provider === 'openai') throw new Error('请先配置 LLM 服务地址');
  let endpoint;
  try { endpoint = new URL(endpointText || 'https://api.anthropic.com'); } catch { throw new Error('LLM 服务地址无效'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !loopback) throw new Error('LLM 服务地址必须使用 HTTPS，本机回环地址除外');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('LLM 服务地址无效');
  const apiKey = String(field(config, 'ApiKey', '')).trim(), model = String(field(config, 'ModelName', '')).trim();
  if (!apiKey && !loopback) throw new Error('请先配置 LLM 密钥（本机回环地址除外）');
  if (requireModel && !model) throw new Error('请先配置 LLM 模型名');
  endpoint.search = ''; endpoint.hash = '';
  return { provider, endpoint: endpoint.href.replace(/\/$/, ''), apiKey, model };
}

export function parseXmlToolCalls(text, round = 1, offset = 0) {
  const calls = [];
  for (const block of String(text ?? '').matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const nameMatch = block[1].match(/<function\s*=\s*([\w.\-]+)\s*>|<function>\s*<name>\s*([\w.\-]+)\s*<\/name>/i), name = nameMatch?.[1] ?? nameMatch?.[2];
    if (!name || !/^[A-Za-z_][\w.\-]*$/.test(name)) continue;
    const args = {};
    for (const parameter of block[1].matchAll(/<parameter\s*=\s*([\w.\-]+)\s*>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      const value = parameter[2].trim();
      args[parameter[1]] = /^(true|false)$/i.test(value) ? value.toLowerCase() === 'true' : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : value;
    }
    calls.push({ id: 'fallback_' + round + '_' + (offset + calls.length), name, args });
  }
  return calls;
}

function compact(messages) {
  const latest = messages.findLastIndex(message => message.role === 'tool' && message.result?.tree != null);
  return messages.map((message, i) => { if (message.role !== 'tool' || i === latest || message.result?.tree == null) return message; const { tree, ...result } = message.result; return { ...message, result }; });
}

function providerMessages(messages, provider) {
  const history = compact(messages);
  if (provider === 'openai') return { messages: history.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.id, content: JSON.stringify(message.result) };
    if (!message.calls?.length) return { role: message.role, content: message.content };
    return { role: 'assistant', content: message.content || null, tool_calls: message.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
  }) };
  const merged = [];
  for (const message of history.filter(message => message.role !== 'system')) {
    const role = message.role === 'tool' ? 'user' : message.role;
    const content = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.id, content: JSON.stringify(message.result) }] : [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.calls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))];
    if (merged.at(-1)?.role === role) merged.at(-1).content.push(...content); else merged.push({ role, content });
  }
  return { system: history.filter(message => message.role === 'system').map(message => message.content).join('\n'), messages: merged };
}

const headers = (settings, placeholder = false) => settings.provider === 'anthropic' ? { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } : settings.apiKey || placeholder ? { Authorization: 'Bearer ' + (settings.apiKey || 'missing-api-key') } : {};
const sanitized = (text, key) => String(text).replaceAll(key || '\0', '[redacted]').replace(/\s+/g, ' ').slice(0, 300);

async function request(url, settings, { fetch: fetchImpl, signal, method = 'GET', body, timeout = 20_000 }) {
  const timed = AbortSignal.timeout(timeout), combined = signal ? AbortSignal.any([signal, timed]) : timed;
  for (let redirects = 0; ; redirects++) {
    combined.throwIfAborted();
    let response;
    try { response = await fetchImpl(url.href, { method, headers: { ...headers(settings, method === 'POST'), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: combined, redirect: 'manual' }); }
    catch (error) { combined.throwIfAborted(); throw new Error('LLM 请求失败: ' + sanitized(error.message, settings.apiKey)); }
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= 3) throw new Error('服务连续重定向超过3次，已停止');
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      const next = new URL(location, url);
      if (url.origin !== next.origin || next.username || next.password) throw new Error('服务返回了跨域重定向，已停止');
      url = next; continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + sanitized(text, settings.apiKey));
    try { return { data: JSON.parse(text), url }; } catch { throw new Error('无法解析 LLM 响应: ' + sanitized(text, settings.apiKey)); }
  }
}

export async function generateComboTree(builder, prompt, settings, { fetch: fetchImpl = globalThis.fetch, signal, onPreview, maxIterations = 128 } = {}) {
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: builder.fallback ? '请为当前队伍构建兜底攻击行为树' : '请为当前队伍构建战斗策略行为树' }];
  for (let round = 1; round <= maxIterations + 1; round++) {
    signal?.throwIfAborted();
    await onPreview?.({ fallback: builder.fallback, tree: builder.preview(), round });
    const tools = builder.tools(), anthropic = settings.provider === 'anthropic';
    const body = { model: settings.model, ...providerMessages(messages, settings.provider), tools: tools.map(tool => anthropic ? { name: tool.name, description: tool.description, input_schema: tool.parameters } : { type: 'function', function: tool }), ...(anthropic ? { max_tokens: 8192 } : {}) };
    const { data } = await request(new URL(settings.endpoint + (anthropic ? '/v1/messages' : '/chat/completions')), settings, { fetch: fetchImpl, signal, method: 'POST', body, timeout: 600_000 });
    const choice = data.choices?.[0], message = choice?.message;
    if (anthropic ? data.stop_reason === 'max_tokens' : choice?.finish_reason === 'length') throw new Error('LLM 输出被截断，无法确认建树完成');
    if (anthropic ? !Array.isArray(data.content) : !message) throw new Error('LLM 响应缺少消息');
    const content = anthropic ? data.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : message.content ?? '';
    let calls = anthropic ? data.content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, name: item.name, args: item.input })) : (message.tool_calls ?? []).map(item => { let args; try { args = JSON.parse(item.function.arguments); } catch { args = null; } return { id: item.id, name: item.function.name, args }; });
    if (!calls.length) {
      const texts = anthropic ? data.content.filter(item => ['text', 'thinking'].includes(item.type)).map(item => item.text ?? item.thinking) : [message.reasoning_content, message.reasoning, content];
      for (const text of texts) calls.push(...parseXmlToolCalls(text, round, calls.length));
    }
    messages.push({ role: 'assistant', content, calls });
    if (!calls.length) { builder.spec(); await onPreview?.({ fallback: builder.fallback, tree: builder.preview(), complete: true }); return builder; }
    if (round > maxIterations) throw new Error('LLM 工具调用循环达到上限（' + maxIterations + '轮）仍有未执行的工具调用');
    const allowed = new Set(tools.map(tool => tool.name));
    for (const call of calls) messages.push({ role: 'tool', id: call.id, result: !allowed.has(call.name) ? { message: '错误: 工具不可用: ' + call.name } : !call.args || typeof call.args !== 'object' || Array.isArray(call.args) ? { message: '错误: 工具参数必须为 JSON 对象' } : builder.invoke(call.name, call.args) });
  }
}

export async function fetchComboModels(config, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  const settings = resolveComboProvider(config, { requireModel: false }), anthropic = settings.provider === 'anthropic';
  let url = new URL(settings.endpoint + (anthropic ? '/v1/models?limit=1000' : '/models'));
  const ids = new Set();
  for (let page = 0; page < 5; page++) {
    const result = await request(url, settings, { fetch: fetchImpl, signal });
    for (const item of result.data.data ?? []) if (typeof item.id === 'string' && item.id.trim()) ids.add(item.id);
    if (!result.data.has_more) { if (!ids.size) throw new Error('服务返回的模型列表为空'); return [...ids]; }
    if (!result.data.last_id?.trim()) throw new Error('服务返回 has_more=true 但未给出 last_id');
    url = new URL(result.url);
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase() === 'after_id' || anthropic && key.toLowerCase() === 'limit') url.searchParams.delete(key);
    if (anthropic) url.searchParams.set('limit', '1000');
    url.searchParams.set('after_id', result.data.last_id);
  }
  throw new Error('模型列表分页超过5页仍未取完，已停止');
}
