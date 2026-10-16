// SPDX-License-Identifier: GPL-3.0-or-later
// AutoArtifactSalvage ArtifactStat / ArtifactAffix / IsMatchJavaScript, c9db8b8.
import vm from 'node:vm';

export const ArtifactStatus = Object.freeze({ None: 0, Locked: 1, Selected: 2 });
export const RecognitionFailurePolicy = Object.freeze({ Skip: 0, Abort: 1 });
export const ArtifactAffixType = Object.freeze(Object.fromEntries([
  'ATK', 'ATKPercent', 'DEF', 'DEFPercent', 'HP', 'HPPercent', 'CRITRate', 'CRITDMG',
  'ElementalMastery', 'EnergyRecharge', 'HealingBonus', 'PhysicalDMGBonus',
  'PyroDMGBonus', 'HydroDMGBonus', 'DendroDMGBonus', 'ElectroDMGBonus',
  'AnemoDMGBonus', 'CryoDMGBonus', 'GeoDMGBonus',
].map((name, index) => [name, index])));
export const DEFAULT_SALVAGE_JAVASCRIPT = `var hasATK = Array.from(ArtifactStat.MinorAffixes).some(affix => affix.Type == 'ATK');
var hasDEF = Array.from(ArtifactStat.MinorAffixes).some(affix => affix.Type == 'DEF');
var hasHP = Array.from(ArtifactStat.MinorAffixes).some(affix => affix.Type == 'HP');
Output = (hasATK && hasDEF) || (hasHP && hasDEF);`;

export class ArtifactAffix {
  constructor(type, value, isUnactivated = false) {
    const name = Number.isInteger(type) ? Object.keys(ArtifactAffixType)[type] : type;
    if (!Object.hasOwn(ArtifactAffixType, name)) throw new TypeError('Unknown ArtifactAffixType: ' + type);
    if (typeof value !== 'number' || typeof isUnactivated !== 'boolean') throw new TypeError('Invalid ArtifactAffix');
    Object.assign(this, { Type: name, Value: Math.fround(value), IsUnactivated: isUnactivated });
  }
  static from(value) { return new ArtifactAffix(value.Type, value.Value, value.IsUnactivated ?? false); }
}

export class ArtifactStat {
  constructor(name, mainAffix, minorAffixes, level) {
    if (typeof name !== 'string' || !Array.isArray(minorAffixes) || !Number.isInteger(level)) throw new TypeError('Invalid ArtifactStat');
    Object.assign(this, { Name: name, MainAffix: ArtifactAffix.from(mainAffix), MinorAffixes: minorAffixes.map(ArtifactAffix.from), Level: level });
  }
  static from(value) { return new ArtifactStat(value.Name, value.MainAffix, value.MinorAffixes, value.Level); }
  ToStructuredString() {
    const valueText = value => {
      if (!Number.isFinite(value)) return String(value);
      for (let digits = 1; digits <= 9; digits++) {
        const rounded = Number(value.toPrecision(digits));
        if (Math.fround(rounded) === value) return String(rounded);
      }
      return String(value);
    };
    return `Properties
├─Name: ${this.Name}
├─MainAffix: ${this.MainAffix.Type}, ${valueText(this.MainAffix.Value)}
├─MinorAffixes: 
${this.MinorAffixes.map((affix, index) => `│\t${index === this.MinorAffixes.length - 1 ? '└─' : '├─'}[${index}]: ${affix.Type}, ${valueText(affix.Value)}${affix.IsUnactivated ? ', Unactivated' : ''}\n`).join('')}└─Level: ${this.Level}`;
  }
  toStructuredString() { return this.ToStructuredString(); }
}

const bootstrap = String.raw`(() => {
  function hostMembers(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) value = value.map(hostMembers);
    else for (const key of Object.keys(value)) value[key] = hostMembers(value[key]);
    return new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !(key in target)) {
          if (Array.isArray(target) && key.toLowerCase() === 'length') return target.length;
          const matched = Object.keys(target).find(name => name.toLowerCase() === key.toLowerCase());
          if (matched !== undefined) key = matched;
        }
        return Reflect.get(target, key, receiver);
      },
      set() { return false; }, defineProperty() { return false; }, deleteProperty() { return false; }
    });
  }
  String.prototype.ToString = String.prototype.toString;
  Number.prototype.ToString = Number.prototype.toString;
  const value = JSON.parse(ARTIFACT_JSON);
  const text = ARTIFACT_TEXT;
  value.ToStructuredString = () => text;
  globalThis.ArtifactStat = hostMembers(value);
  delete globalThis.ARTIFACT_JSON;
  delete globalThis.ARTIFACT_TEXT;
})();`;

export async function isMatchJavaScript(artifact, javaScript, { signal, log } = {}) {
  signal?.throwIfAborted();
  if (typeof javaScript !== 'string') throw new TypeError('JavaScript must be a string');
  const input = ArtifactStat.from(artifact);
  const context = vm.createContext({ ARTIFACT_JSON: JSON.stringify(input), ARTIFACT_TEXT: input.ToStructuredString() }, { microtaskMode: 'afterEvaluate' });
  new vm.Script(bootstrap).runInContext(context, { timeout: 3000 });
  const deadline = performance.now() + 3000;
  const options = () => ({ timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
  let output;
  try {
    new vm.Script(javaScript, { filename: 'BetterGI-artifact-filter.js' }).runInContext(context, options());
    // ClearScript reads the enumerable global property, excluding lexical let/const.
    output = new vm.Script(`Object.prototype.propertyIsEnumerable.call(globalThis, 'Output') ? { exists: true, value: globalThis.Output } : { exists: false }`).runInContext(context, options());
  } catch (cause) {
    if (cause?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      log?.('warning', '脚本执行超出3秒限制，请使用正确的JS代码（JavaScript execution timeout!）');
      const error = new Error('JavaScript execution timeout!', { cause }); error.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT'; throw error;
    }
    throw new Error('JavaScript execution error: ' + (cause?.message ?? String(cause)), { cause });
  }
  signal?.throwIfAborted();
  if (!output.exists) throw new Error('JavaScript没有设置Output输出');
  if (typeof output.value !== 'boolean') throw new Error('JavaScript的Output输出不是布尔类型');
  return output.value;
}

export function isMatchRegularExpression(affixes, regularExpression) {
  const match = new RegExp(regularExpression).exec(affixes);
  return { success: !!match, message: match ? match[0] ? '匹配成功：' + match[0] : '匹配成功！' : '匹配失败！' };
}
export const IsMatchJavaScript = isMatchJavaScript;
export const IsMatchRegularExpression = isMatchRegularExpression;
