// SPDX-License-Identifier: GPL-3.0-or-later
// Port of AutoFight/Script/ConditionEvaluator.cs at c9db8b8291fe4ac25a600aee1582298005919eb2.
export const CONDITION_FUNCTION_NAMES = Object.freeze(['last-exec', 'q-ready', 'e-ready', 'e-cd', 'low-hp', 'battle-time', 'in-party', 'onfield', 't', 'since', 'count', 'min', 'max', 'last-check']);
const lower = value => value.toLowerCase();
const letter = value => /\p{L}/u.test(value ?? '');
const digit = value => /\p{Nd}/u.test(value ?? '');
const alnum = value => letter(value) || digit(value);
const now = runtime => runtime.host.now?.() ?? performance.now();
const check = runtime => runtime.host.signal?.throwIfAborted();
const toBool = value => typeof value === 'boolean' ? value : typeof value === 'number' && value > 0;
const toNumber = value => typeof value === 'number' ? value : value === true ? 1 : 0;

function tokenize(expression, known) {
  const tokens = [];
  for (let i = 0; i < expression.length;) {
    const char = expression[i], pair = expression.slice(i, i + 2);
    if (/\s/u.test(char)) { i++; continue; }
    if (pair === '&&' || pair === '||') { tokens.push({ type: pair }); i += 2; continue; }
    if ('!+-*/><=(),'.includes(char)) { tokens.push({ type: char }); i++; continue; }
    if (digit(char) || char === '.' && digit(expression[i + 1])) {
      const start = i++;
      while (digit(expression[i]) || expression[i] === '.') i++;
      tokens.push({ type: 'number', value: expression.slice(start, i) }); continue;
    }
    if (letter(char)) {
      const start = i++;
      while (alnum(expression[i])) i++;
      if (expression[i] === '-') {
        let end = i + 1;
        while (alnum(expression[end]) || expression[end] === '-') end++;
        while (end > i && !known.has(lower(expression.slice(start, end)))) end--;
        if (end > i) i = end;
      }
      const value = expression.slice(start, i);
      tokens.push({ type: value === 'true' || value === 'false' ? 'bool' : 'identifier', value }); continue;
    }
    throw new SyntaxError('无法识别的字符：' + char);
  }
  tokens.push({ type: 'end' });
  return tokens;
}

export function isValidActionName(name, actionNames = []) {
  if (typeof name !== 'string' || !name || /^(true|false)$/i.test(name) || CONDITION_FUNCTION_NAMES.includes(lower(name))) return false;
  try {
    const known = new Set([...CONDITION_FUNCTION_NAMES, ...actionNames].map(lower));
    const tokens = tokenize(name, known);
    return tokens.length === 2 && tokens[0].type === 'identifier' && lower(tokens[0].value) === lower(name);
  } catch { return false; }
}

function parse(expression, known) {
  const tokens = tokenize(expression, known); let pos = 0;
  const levels = [['||'], ['&&'], ['>', '<', '='], ['+', '-'], ['*', '/']];
  const read = (level = 0) => {
    if (level === levels.length) return unary();
    let node = read(level + 1);
    while (levels[level].includes(tokens[pos].type)) {
      const operator = tokens[pos++].type;
      node = { type: 'binary', operator, left: node, right: read(level + 1) };
    }
    return node;
  };
  const unary = () => {
    if (tokens[pos].type === '!' || tokens[pos].type === '-') return { type: 'unary', operator: tokens[pos++].type, operand: unary() };
    const token = tokens[pos++];
    if (token.type === '(') {
      const node = read();
      if (tokens[pos++].type !== ')') throw new SyntaxError('缺少右括号');
      return node;
    }
    if (token.type === 'identifier') {
      const args = [];
      if (tokens[pos].type === '(') {
        pos++;
        if (tokens[pos].type !== ')') {
          args.push(read());
          while (tokens[pos].type === ',') { pos++; args.push(read()); }
        }
        if (tokens[pos++].type !== ')') throw new SyntaxError('函数 ' + token.value + ' 缺少右括号');
      }
      return { type: 'call', name: token.value, args };
    }
    if (token.type === 'bool') return { type: 'bool', value: token.value === 'true' };
    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new SyntaxError('无效数字：' + token.value);
      return { type: 'number', value };
    }
    throw new SyntaxError('意外的 token：' + token.type);
  };
  // The original parser evaluates its first expression without requiring End.
  return read();
}

export class ConditionEvaluator {
  constructor(runtime, { actionNames = [], battleStartAt = now(runtime) } = {}) {
    this.runtime = runtime; this.battleStartAt = battleStartAt;
    this.actionNames = new Set(actionNames.map(lower));
    this.known = new Set([...CONDITION_FUNCTION_NAMES, ...this.actionNames]);
    this.history = []; this.activeContext = {};
    this.setCachedCapture(null);
  }
  setCachedCapture(frame) { this.frame = frame; this.qReadyCache = null; this.lowHpCache = null; }
  elapsed() { return (now(this.runtime) - this.battleStartAt) / 1000; }
  updateLastExecTime(index, name) { this.history.push({ index, name, time: this.elapsed() }); }
  async evaluate(expression, index, character = null, name = null) {
    check(this.runtime);
    if (expression == null || /^\s*$/.test(expression)) return true;
    try { return toBool(await this.eval(parse(expression, this.known), { index, character, name })); }
    catch (error) {
      check(this.runtime);
      if (error.name === 'AbortError' || error.code === 'PATH_RETRY') throw error;
      this.runtime.host.log?.('warn', '条件表达式求值失败：' + expression + '，' + error.message);
      return false;
    }
  }
  async eval(node, current) {
    check(this.runtime);
    if (node.type === 'number' || node.type === 'bool') return node.value;
    if (node.type === 'unary') {
      const operand = await this.eval(node.operand, current);
      return node.operator === '!' ? !toBool(operand) : -toNumber(operand);
    }
    if (node.type === 'call') return this.call(lower(node.name), node.args, current);
    const left = await this.eval(node.left, current);
    if (node.operator === '&&') return toBool(left) && toBool(await this.eval(node.right, current));
    if (node.operator === '||') return toBool(left) || toBool(await this.eval(node.right, current));
    const a = toNumber(left), b = toNumber(await this.eval(node.right, current));
    switch (node.operator) {
      case '>': return a > b;
      case '<': return a < b;
      case '=': return Math.abs(a - b) < .0001;
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? 0 : a / b;
      default: throw new Error('未知条件运算符：' + node.operator);
    }
  }
  async target(node, current) {
    if (!node) return { index: current.index, name: current.name };
    if (node.type === 'call' && !node.args.length) {
      if (!this.actionNames.has(lower(node.name))) throw new Error('未知动作名称：' + node.name);
      return { name: node.name };
    }
    return { index: Math.trunc(toNumber(await this.eval(node, current))) };
  }
  matches(event, target) {
    return (target.index == null || event.index === target.index) && (target.name == null || lower(event.name ?? '') === lower(target.name));
  }
  since(target) {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.matches(this.history[i], target)) return this.elapsed() - this.history[i].time;
    return Infinity;
  }
  async capture(body) { return this.frame ? body(this.frame) : this.runtime.captured(body); }
  async qReady(targetName) {
    try {
      if (this.qReadyCache === null) {
        const result = await this.capture(frame => this.runtime.host.vision('fight.qReady', { handle: frame.handle, activeIndex: this.runtime.state.lastActiveIndex ?? 0 }));
        this.qReadyCache = new Set(result.readyIndexes);
      }
      return this.runtime.state.team.some(avatar => (targetName == null || lower(avatar.name) === lower(targetName)) && this.qReadyCache.has(avatar.index));
    } catch (error) {
      check(this.runtime);
      if (error.name === 'AbortError' || error.code === 'PATH_RETRY') throw error;
      this.runtime.host.log?.('warn', '[Q检测] 异常：' + error.message); return false;
    }
  }
  remaining(name) {
    if (!name) return 0;
    const tracker = this.runtime.state.skillTracker;
    const value = tracker?.get(name) ?? [...(tracker ?? [])].find(([key]) => lower(key) === lower(name))?.[1];
    return Math.max(0, ((value ?? -Infinity) - now(this.runtime)) / 1000);
  }
  async lowHp() {
    if (this.lowHpCache === null) {
      try { this.lowHpCache = await this.capture(frame => this.runtime.host.vision('party.lowHp', { handle: frame.handle })); }
      catch (error) {
        check(this.runtime);
        if (error.name === 'AbortError' || error.code === 'PATH_RETRY') throw error;
        this.runtime.host.log?.('warn', '[低血检测] 异常：' + error.message); this.lowHpCache = false;
      }
    }
    return this.lowHpCache;
  }
  async onfield(name) {
    if (!name) return false;
    if (!(this.runtime.state.lastActiveIndex > 0) && !(await this.capture(frame => this.runtime.active(frame, this.activeContext)) > 0)) return false;
    return this.runtime.state.team.some(avatar => avatar.name === name && avatar.index === this.runtime.state.lastActiveIndex);
  }
  async call(name, args, current) {
    const number = async (node, context = current) => toNumber(await this.eval(node, context));
    const targetName = args[0]?.type === 'call' && !args[0].args.length ? args[0].name : current.character;
    const greater = args[1]?.type === 'bool' ? args[1].value : true;
    switch (name) {
      case 't': return this.elapsed();
      case 'last-check': return (now(this.runtime) - this.runtime.state.lastFightCheckAt) / 1000;
      case 'since': return this.since(await this.target(args[0], current));
      case 'count': {
        const target = await this.target(args[0], current), start = args[1] ? await number(args[1]) : 0, end = args[2] ? await number(args[2]) : this.elapsed();
        return this.history.filter(event => this.matches(event, target) && event.time >= start && event.time <= end).length;
      }
      case 'last-exec': {
        if (!args.length) return false;
        const time = await number(args[0]), elapsed = this.since(await this.target(args[2], current));
        if (elapsed === Infinity) return greater;
        return greater ? elapsed > time : elapsed < time;
      }
      case 'battle-time': {
        if (!args.length) return false;
        const time = await number(args[0], { ...current, index: 0 });
        return greater ? this.elapsed() > time : this.elapsed() < time;
      }
      case 'min': case 'max': {
        let result = name === 'min' ? Infinity : -Infinity;
        for (const arg of args) result = Math[name](result, await number(arg));
        return args.length ? result : 0;
      }
      case 'e-cd': return this.remaining(targetName);
      case 'e-ready': return targetName != null && this.remaining(targetName) <= 0;
      case 'q-ready': return this.qReady(targetName);
      case 'low-hp': return this.lowHp();
      case 'in-party': return args[0]?.type === 'call' && !args[0].args.length && this.runtime.state.team.some(avatar => avatar.name === args[0].name);
      case 'onfield': return this.onfield(current.character);
      default: throw new Error('未知条件函数：' + name);
    }
  }
}
