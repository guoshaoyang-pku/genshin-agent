import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ScriptFiles } from './script-files.mjs';
import { createBvTypes } from './bv.mjs';
import { createTaskParamTypes } from './task-params.mjs';

const { scriptRoot, manifest, buffer } = workerData;
const header = new Int32Array(buffer, 0, 4), bytes = new Uint8Array(buffer, 16);
const raw = new WeakMap();
const roots = [scriptRoot, ...workerData.allowedRoots.map(root => fs.realpathSync(root))];

function unsupported(member) { throw new Error(`BetterGI API is not migrated: ${member}`); }
function plain(value) {
  if (raw.has(value)) value = raw.get(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function').map(([key, item]) => [key, plain(item)]));
  return value;
}
function rpc(op, args = {}) {
  Atomics.store(header, 0, 0);
  parentPort.postMessage({ type: 'call', op, args: plain(args) });
  Atomics.wait(header, 0, 0);
  const response = JSON.parse(Buffer.from(bytes.subarray(0, Atomics.load(header, 1))).toString('utf8'));
  if (response.error) { const error = new Error(response.error.message); error.name = response.error.name; throw error; }
  return wrap(response.result);
}
function caseObject(object, label, missing = true) {
  const proxy = new Proxy(object, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver);
      if (key === 'then' || key === 'toJSON') return undefined;
      let candidate = target;
      while (candidate) {
        const found = Object.getOwnPropertyNames(candidate).find(name => name.toLowerCase() === key.toLowerCase());
        if (found) return Reflect.get(target, found, receiver);
        candidate = Object.getPrototypeOf(candidate);
      }
      if (missing) return (..._args) => unsupported(`${label}.${key}`);
      return undefined;
    },
    set(target, key, value, receiver) {
      const found = typeof key === 'string' && Object.keys(target).find(name => name.toLowerCase() === key.toLowerCase());
      return Reflect.set(target, found || key, value, receiver);
    },
  });
  raw.set(proxy, object);
  return proxy;
}
function list(items = []) {
  Object.defineProperty(items, 'Count', { get: () => items.length });
  Object.defineProperty(items, 'count', { get: () => items.length });
  Object.defineProperties(items, { Add: { value: value => items.push(value) }, Clear: { value: () => { items.length = 0; } }, Contains: { value: value => items.includes(value) } });
  return caseObject(items, 'List');
}
function wrap(value) {
  if (Array.isArray(value)) return list(value.map(wrap));
  if (['Mat', 'Region', 'ImageRegion', 'YoloRegion'].includes(value?.__bgiType)) return imageObject(value);
  if (value && typeof value === 'object') return caseObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wrap(item)])), 'HostObject', false);
  return value;
}
function rect(x = 0, y = 0, width = 0, height = 0) {
  return caseObject({ x, y, width, height, get left() { return this.x; }, get top() { return this.y; }, get right() { return this.x + this.width; }, get bottom() { return this.y + this.height; } }, 'Rect');
}
function box(args) { return args.length === 1 ? plain(args[0]) : { x: args[0], y: args[1], width: args[2] ?? 0, height: args[3] ?? 0 }; }
function input(method, args, canonical = false) { return rpc('input', { method, args, canonical }); }
function imageObject(descriptor) {
  const image = Object.fromEntries(Object.entries(descriptor).map(([key, value]) => [key, wrap(value)]));
  const isMat = image.__bgiType === 'Mat';
  const mat = (method, args = []) => rpc('image.mat', { handle: image.handle, method, args });
  const center = (x = 0, y = 0, width = image.width, height = image.height) => [image.globalX + x + width / 2, image.globalY + y + height / 2].map(Math.round);
  Object.defineProperties(image, {
    left: { get: () => image.x, set: value => { image.globalX += value - image.x; image.x = value; } },
    top: { get: () => image.y, set: value => { image.globalY += value - image.y; image.y = value; } },
    right: { get: () => image.x + image.width }, bottom: { get: () => image.y + image.height },
    srcMat: { get: () => imageObject({ ...descriptor, __bgiType: 'Mat' }) },
    cacheGreyMat: { get: () => mat('CvtColor', ['BGR2GRAY']) },
    rows: { get: () => image.height }, cols: { get: () => image.width },
  });
  const self = caseObject(image, image.__bgiType);
  Object.assign(image, {
    isEmpty: () => image.x === 0 && image.y === 0 && image.width === 0 && image.height === 0,
    isExist: () => !image.isEmpty(),
    dispose: () => { if (image.handle) rpc('image.dispose', { handle: image.handle }); },
    click: () => { input('click', center(), true); return self; },
    doubleClick: () => { self.click(); rpc('sleep', { ms: 60 }); self.click(); return self; },
    clickTo: (...args) => { const r = box(args); input('click', center(r.x, r.y, r.width, r.height), true); },
    move: () => input('moveMouseTo', center(), true),
    moveTo: (...args) => { const r = box(args); input('moveMouseTo', center(r.x, r.y, r.width, r.height), true); },
    derive: (...args) => { const r = box(args); return imageObject({ __bgiType: 'Region', handle: 0, ...r, globalX: image.globalX + r.x, globalY: image.globalY + r.y, text: '' }); },
    deriveCrop: (...args) => rpc('image.crop', { handle: image.handle, ...box(args) }),
    find: (recognition, success, fail) => { const found = rpc('image.find', { handle: image.handle, recognition }); if (found.isExist()) success?.(found); else fail?.(); return found; },
    findMulti: (recognition, success, fail) => { const found = rpc('image.findMulti', { handle: image.handle, recognition }); if (found.length) success?.(found); else fail?.(); return found; },
    toRect: () => rect(image.x, image.y, image.width, image.height),
    convertSelfPositionToGameCaptureRegion: () => rect(image.globalX, image.globalY, image.width, image.height),
    toImageRegion: () => image.__bgiType === 'ImageRegion' ? self : unsupported('Region.ToImageRegion'),
  });
  if (isMat) {
    for (const method of ['Clone', 'CopyTo', 'Empty', 'Channels', 'Size', 'SetTo', 'Roi', 'SubMat', 'At', 'Get', 'CountNonZero', 'MinMaxLoc']) image[method] = (...args) => mat(method, args);
  }
  return self;
}

function confined(relative, base = scriptRoot, { exists = true } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0')) throw new TypeError('Expected a relative script path');
  relative = relative.replaceAll('\\', '/');
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Absolute script paths are not allowed');
  const candidate = path.resolve(base, relative);
  const parent = exists ? fs.realpathSync(candidate) : path.join(fs.realpathSync(path.dirname(candidate)), path.basename(candidate));
  if (!roots.some(root => parent === root || parent.startsWith(root + path.sep))) throw new Error(`Script path escapes installed resources: ${relative}`);
  return parent;
}
const files = new ScriptFiles({ scriptRoot, stateRoot: workerData.stateRoot, allowedRoots: workerData.allowedRoots, rpc, list,
  log: (level, text) => rpc('log', { level, text }) });
const fileMethods = Object.getOwnPropertyNames(ScriptFiles.prototype).filter(name => !['constructor', 'normalize', 'hidden', 'overlayPath', 'locate', 'stat', 'writeTarget'].includes(name));
const file = caseObject(Object.fromEntries(fileMethods.map(name => [name, files[name].bind(files)])), 'file');

function recognition(values = {}) {
  const result = { recognitionType: 'TemplateMatch', regionOfInterest: rect(), threshold: 0.8, use3Channels: false, templateMatchMode: 'CCoeffNormed', useMask: false, maskColor: [0, 255, 0], maxMatchCount: -1, useBinaryMatch: false, binaryThreshold: 128, allContainMatchText: list(), oneContainMatchText: list(), regexMatchText: list(), text: '', ...values };
  result.initTemplate = () => self;
  result.clone = () => recognition(plain(result));
  const self = caseObject(result, 'RecognitionObject');
  return self;
}
const RecognitionObject = caseObject(function RecognitionObject() { return recognition(); }, 'RecognitionObject');
RecognitionObject.TemplateMatch = (mat, ...args) => recognition({ templateImageMat: mat, ...(typeof args[0] === 'boolean' ? { useMask: args[0], maskColor: args[1] ?? [0, 255, 0] } : args.length ? { regionOfInterest: box(args) } : {}) });
RecognitionObject.Ocr = (...args) => recognition({ recognitionType: 'Ocr', regionOfInterest: box(args) });
RecognitionObject.OcrMatch = (x, y, width, height, ...texts) => recognition({ recognitionType: 'OcrMatch', regionOfInterest: rect(x, y, width, height), oneContainMatchText: list(texts.flat()) });
RecognitionObject.OcrThis = recognition({ recognitionType: 'Ocr' });
const Mat = caseObject(function Mat(...args) { return rpc('image.mat', { method: 'New', args }); }, 'Mat');
for (const method of ['Zeros', 'Ones']) Mat[method] = (...args) => rpc('image.mat', { method, args });
function enumObject(name) { return new Proxy({}, { get: (_target, key) => typeof key === 'string' ? key : undefined }); }
const Cv2 = new Proxy({}, { get: (_target, method) => (...args) => {
  if (['GetStructuringElement', 'ContourArea', 'BoundingRect'].some(name => name.toLowerCase() === method.toLowerCase())) return rpc('image.mat', { method, args });
  const [source, destination, ...parameters] = args;
  if (!source?.handle) return unsupported(`Cv2.${method}`);
  const hasDestination = destination?.__bgiType === 'Mat';
  return rpc('image.mat', { handle: source.handle, method, args: hasDestination ? parameters : args.slice(1), ...(hasDestination ? { destination: destination.handle } : {}) });
} });
const OpenCvSharp = caseObject({ Mat, Cv2, Rect: rect, Size: function Size(width = 0, height = 0) { return caseObject({ width, height }, 'Size'); }, Point: function Point(x = 0, y = 0) { return caseObject({ x, y }, 'Point'); }, Scalar: function Scalar(...values) { return list(values); } }, 'OpenCvSharp');
for (const name of ['ColorConversionCodes', 'TemplateMatchModes', 'MorphTypes', 'MorphShapes', 'RetrievalModes', 'ContourApproximationModes', 'ThresholdTypes', 'InterpolationFlags', 'ImreadModes', 'MatType']) OpenCvSharp[name] = enumObject(name);
const genshin = new Proxy({ width: 1920, height: 1080, scaleTo1080PRatio: 1, screenDpiScale: 1 }, { get(target, key) {
  const found = Object.keys(target).find(name => name.toLowerCase() === String(key).toLowerCase());
  if (found) return target[found];
  if (key === 'then') return undefined;
  return (...args) => rpc(`genshin.${key}`, { args });
} });
function nativeObject(name) { return new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : (...args) => rpc(`${name}.${key}`, { args }) }); }
function scriptObject(name) {
  const runFile = (sourceFiles, relative) => {
    if (name !== 'pathingScript') return rpc(`${name}.run`, { source: sourceFiles.readTextSync(relative) });
    const entry = sourceFiles.normalize(relative);
    return rpc(`${name}.run`, {
      filename: entry.source,
      fileContext: { scriptRoot: sourceFiles.root, stateRoot: sourceFiles.stateRoot, allowedRoots: sourceFiles.roots.slice(1) },
    });
  };
  const api = { run: async source => rpc(`${name}.run`, { source }), runFile: async relative => runFile(files, relative) };
  if (name === 'pathingScript') {
    const userRoot = workerData.userPathingRoot ?? path.resolve(import.meta.dirname, '../../third_party/bettergi/scripts/repo/pathing');
    let userFiles;
    const installed = () => userFiles ??= new ScriptFiles({ scriptRoot: userRoot, stateRoot: path.join(workerData.stateRoot, 'pathing'), rpc, list });
    api.runFileFromUser = async relative => runFile(installed(), relative);
    for (const method of ['isExists', 'isFile', 'isFolder', 'readTextSync']) api[method] = relative => installed()[method](relative);
    api.readPathSync = (relative = './') => installed().readPathSync(relative);
  }
  return caseObject(api, name);
}

const defaults = {};
if (manifest.settings_ui) {
  for (const setting of JSON.parse(fs.readFileSync(confined(manifest.settings_ui), 'utf8').replace(/^\uFEFF/, ''))) {
    defaults[setting.name] = setting.default ?? (setting.type === 'checkbox' ? false : setting.type === 'multi-checkbox' ? [] : '');
  }
}
const globals = {
  settings: caseObject({ ...defaults, ...workerData.settings }, 'settings', false),
  getVersion: () => '0.66.2-alpha.2', setGameMetrics: (...metrics) => rpc('setGameMetrics', { metrics }), getGameMetrics: () => rpc('getGameMetrics'),
  sleep: async ms => rpc('sleep', { ms }), captureGameRegion: () => rpc('capture'),
  inputText: text => rpc('inputText', { text }), getAvatars: () => rpc('getAvatars'),
  file, genshin, RecognitionObject, Mat, OpenCvSharp, Region: function Region(...args) { const r = box(args); return imageObject({ __bgiType: 'Region', handle: 0, ...r, globalX: r.x, globalY: r.y }); },
  Point2f: OpenCvSharp.Point, keyMouseScript: scriptObject('keyMouseScript'), pathingScript: scriptObject('pathingScript'),
  log: caseObject(Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (text, ...args) => { let index = 0; return rpc('log', { level, text: String(text).replace(/\{[^}]*\}/g, () => String(args[index++])) }); }])), 'log'),
  Task: caseObject({ delay: async ms => rpc('sleep', { ms }), whenAll: async (...tasks) => Promise.all(tasks.flat()) }, 'Task'),
  host: caseObject({ toArray: value => Array.from(value), newArr: (_type, length) => list(new Array(length).fill(null)) }, 'host'),
};
for (const method of ['keyDown', 'keyUp', 'keyPress', 'moveMouseBy', 'moveMouseTo', 'click', 'leftButtonClick', 'leftButtonDown', 'leftButtonUp', 'rightButtonClick', 'rightButtonDown', 'rightButtonUp', 'middleButtonClick', 'middleButtonDown', 'middleButtonUp', 'verticalScroll']) globals[method] = (...args) => input(method, args);
for (const name of ['dispatcher', 'notification', 'htmlMask', 'http', 'strategyFile', 'characterDevelopmentTask']) globals[name] = nativeObject(name);
globals.yolo = caseObject({
  createPredictor(modelPath, options) {
    const filename = confined(modelPath);
    if (path.extname(filename).toLowerCase() !== '.onnx') throw new TypeError('模型文件必须是.onnx');
    let predictor, disposed = false;
    return caseObject({
      detect(overrides) {
        if (disposed) throw new Error('YOLO predictor is disposed');
        predictor ??= rpc('yolo.create', { path: filename, options, requireDetection: true }).predictor;
        return rpc('yolo.detect', { predictor, options: overrides });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (predictor !== undefined) rpc('yolo.dispose', { predictor });
      },
    }, 'YoloDetector');
  },
}, 'yolo');
const skipConfigs = new WeakSet();
globals.AutoSkipConfig = function AutoSkipConfig() { const config = caseObject({
  enabled: true, quicklySkipConversationsEnabled: true, afterChooseOptionSleepDelay: 0,
  autoWaitDialogueOptionVoiceEnabled: false, dialogueOptionVoiceMaxWaitSeconds: 30, dialogueOptionVoiceVadDiagnosticEnabled: false,
  beforeClickConfirmDelay: 0, autoGetDailyRewardsEnabled: true, autoReExploreEnabled: true, autoReExploreCharacter: '',
  clickChatOption: '优先选择第一个选项', customPriorityOptionsEnabled: false, customPriorityOptions: '',
  autoHangoutEventEnabled: false, autoHangoutEndChoose: '', autoHangoutChooseOptionSleepDelay: 0, autoHangoutPressSkipEnabled: true,
  runBackgroundEnabled: false, bringGameToFrontAfterBackgroundDialogEnabled: false, submitGoodsEnabled: true,
  pictureInPictureEnabled: false, pictureInPictureSourceType: 'CaptureLoop', closePopupPagedEnabled: true, skipBuiltInClickOptions: false,
  isClickFirstChatOption() { return this.clickChatOption === '优先选择第一个选项'; },
  isClickRandomChatOption() { return this.clickChatOption === '随机选择选项'; },
  isClickNoneChatOption() { return this.clickChatOption === '不选择选项'; },
}, 'AutoSkipConfig', false); skipConfigs.add(config); return config; };
globals.RealtimeTimer = function RealtimeTimer(name = null, config) {
  if (name === 'AutoSkip' && config !== undefined && !skipConfigs.has(config)) throw new TypeError('AutoSkip的配置参数需要为AutoSkipConfig类型');
  return caseObject({ name, interval: 50, config: ['AutoPick', 'AutoSkip'].includes(name) ? config ?? null : null }, 'RealtimeTimer', false);
};
globals.SoloTask = function SoloTask(name, config = null) { return caseObject({ name, config }, 'SoloTask', false); };
globals.ServerTime = caseObject({ getServerTimeZoneOffset: () => workerData.serverTimeZoneOffsetMs }, 'ServerTime');
Object.assign(globals, createTaskParamTypes({ caseObject, list, getConfig: () => workerData.config ?? {}, combatRoot: workerData.userFightRoot }));
Object.assign(globals, createBvTypes({ caseObject, list, rect, recognition, capture: () => rpc('capture'), input,
  sleep: ms => rpc('sleep', { ms }), loadAsset: (feature, file) => rpc('asset.load', { feature, file }) }));
for (const name of ['CombatScenes', 'Avatar', 'KeyMouseHook', 'PostMessage', 'DesktopRegion', 'GameCaptureRegion', 'CancellationTokenSource', 'CancellationToken', 'Pen', 'Color']) globals[name] = new Proxy(function UnsupportedType() { unsupported(name); }, { get: (_target, key) => (..._args) => unsupported(`${name}.${String(key)}`) });
globals.console = Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(level => [level, (...args) => globals.log.info(args.map(String).join(' '))]));
const context = vm.createContext(globals, { name: `BetterGI:${manifest.name}`, codeGeneration: { strings: true, wasm: false } });

function resolveModule(specifier, referrer) {
  specifier = specifier.replaceAll('\\', '/').replace(/^(?:\.\.\/)+(packages\/)/, '$1');
  const locations = [specifier.startsWith('.') ? path.dirname(referrer) : scriptRoot];
  for (const relative of ['packages', ...(manifest.library ?? [])]) {
    try { locations.push(confined(relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of locations) {
    for (const suffix of ['', '.js']) {
      try { const candidate = confined(specifier + suffix, directory); if (fs.statSync(candidate).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  throw new Error(`Cannot resolve BetterGI module ${specifier} from ${path.basename(referrer)}`);
}
const modules = new Map();
function loadModule(filename, isEntry = false) {
  if (modules.has(filename)) return modules.get(filename);
  const extension = path.extname(filename).toLowerCase();
  let module;
  if (extension !== '.js' && extension !== '.mjs') {
    const value = /\.(png|jpe?g|bmp|tiff|webp)$/i.test(extension) ? rpc('image.load', { path: filename, type: 'Mat' }) : fs.readFileSync(filename, 'utf8');
    module = new vm.SyntheticModule(['default'], function () { this.setExport('default', value); }, { context, identifier: filename });
  } else {
    let source = fs.readFileSync(filename, 'utf8');
    if (isEntry) source = source.replace(/(^|\n)([ \t]*)\(async\s+(function\b|\()/, '$1$2globalThis.__bgiEntryPromise = (async $3');
    module = new vm.SourceTextModule(source, { context, identifier: filename, importModuleDynamically: async (specifier, referrer) => { const dependency = loadModule(resolveModule(specifier, referrer.identifier)); if (dependency.status === 'unlinked') await dependency.link(linker); if (dependency.status === 'linked') await dependency.evaluate(); return dependency; } });
  }
  modules.set(filename, module);
  return module;
}
const linker = (specifier, referrer) => loadModule(resolveModule(specifier, referrer.identifier));
async function main() {
  rpc('setGameMetrics', { metrics: [1920, 1080, 1] });
  const filename = confined(workerData.entry ?? manifest.main ?? 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  let result;
  if ((manifest.library?.length ?? 0) || /\b(import|export)\s/.test(source)) {
    const entry = loadModule(filename, true); await entry.link(linker); await entry.evaluate(); result = await context.__bgiEntryPromise;
  } else result = await new vm.Script(source, { filename }).runInContext(context);
  return { package: manifest.name, version: manifest.version, result: plain(result), modules: modules.size };
}
try { parentPort.postMessage({ type: 'done', result: await main() }); } catch (error) { parentPort.postMessage({ type: 'error', error: { name: error.name, message: error.message, stack: error.stack } }); }
