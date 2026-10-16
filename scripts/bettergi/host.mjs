import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { CloudGame } from './cloud.mjs';
import { NativeTasks, UnsupportedNativeOperation } from './native.mjs';
import { DailyTasks } from './daily.mjs';
import { RealtimeDispatcher, runOneKeyExpedition } from './realtime.mjs';
import { NavigationTasks, loadPathingTask, parsePathingTask } from './navigation.mjs';
import { GenshinApi } from './genshin-api.mjs';
import { ScriptFiles } from './script-files.mjs';
import { CombatTasks } from './combat.mjs';
import { PathingActions } from './actions.mjs';
import { runAutoCook } from './cooking.mjs';
import { PartyTasks } from './party.mjs';
import { runAutoFight } from './fight.mjs';
import { FishingController, runAutoFishing } from './fishing.mjs';
import { runAutoMusic, runAutoAlbum } from './music.mjs';
import { InventoryTasks } from './inventory.mjs';
import { runAutoGeniusInvokation } from './tcg.mjs';
import { runAutoDomain } from './domain.mjs';
import { runAutoBoss } from './boss.mjs';
import { runAutoWood } from './wood.mjs';
import { SalvageTasks } from './salvage.mjs';
import { runAutoEat } from './eat.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const VENDOR_ROOT = path.join(PROJECT_ROOT, 'third_party/bettergi');

export class VisionProcess {
  constructor({ python = process.env.BETTERGI_PYTHON || path.join(PROJECT_ROOT, 'venv/bin/python'), modelRoot = path.join(VENDOR_ROOT, 'assets/bettergi.assets.model/Assets/Model'), sourceRoot = path.join(VENDOR_ROOT, 'source'), mapRoot = path.join(VENDOR_ROOT, 'assets/bettergi.assets.map/Assets/Map') } = {}) {
    this.sequence = 0;
    this.pending = new Map();
    this.stderr = '';
    this.process = spawn(python, [path.join(PROJECT_ROOT, 'scripts/bettergi/vision.py')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', BETTERGI_MODEL_ROOT: modelRoot, BETTERGI_SOURCE_ROOT: sourceRoot, BETTERGI_MAP_ROOT: mapRoot },
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Vision service emitted invalid JSON')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        pending.reject(error);
      } else pending.resolve(message.result);
    });
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-8192); });
    this.process.on('error', error => this.fail(error));
    this.exited = new Promise(resolve => {
      this.process.once('error', resolve);
      this.process.once('exit', (code, signal) => {
        this.fail(new Error(`Vision service stopped (${code ?? signal}): ${this.stderr.trim()}`));
        resolve();
      });
    });
  }

  fail(error) {
    this.error = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  call(op, args = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ id, op, args }) + '\n', error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close() {
    this.process.stdin.end();
    const timeout = setTimeout(() => this.process.kill('SIGTERM'), 2000);
    try { await this.exited; } finally { clearTimeout(timeout); this.lines.close(); }
  }
}

async function acquireInputLock() {
  const filename = path.join(PROJECT_ROOT, 'data/bettergi/input.lock');
  await mkdir(path.dirname(filename), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => {
        const owner = JSON.parse(await readFile(filename, 'utf8'));
        if (owner.pid === process.pid) await unlink(filename);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(filename, 'utf8'));
      try { process.kill(owner.pid, 0); } catch (check) {
        if (check.code !== 'ESRCH') throw check;
        await unlink(filename);
        continue;
      }
      throw new Error(`BetterGI input is already owned by process ${owner.pid}`);
    }
  }
  throw new Error('Could not acquire BetterGI input lock');
}

export class BetterGiHost {
  static async connect(options = {}) {
    const unlock = await acquireInputLock();
    let game, host;
    try {
      const provenance = JSON.parse(await readFile(path.join(VENDOR_ROOT, 'provenance.json'), 'utf8'));
      const relativeSdk = 'BetterGenshinImpact/Resources/JavaScript/ys-input-inject.js';
      game = await CloudGame.connect({ endpoint: options.endpoint, sdkPath: path.join(VENDOR_ROOT, 'source', relativeSdk), expectedSdkHash: provenance.source.files.find(file => file.path === relativeSdk)?.sha256 });
      await game.assertConnected();
      host = new BetterGiHost(game, new VisionProcess(options), options);
      host.unlock = unlock;
      await mkdir(host.runDir, { recursive: true });
      await host.record('session.start', await game.status());
      return host;
    } catch (error) {
      if (host) await host.close({ ok: false, error: error.message }).catch(() => {});
      else {
        if (game) await game.close().catch(() => {});
        await unlock();
      }
      throw error;
    }
  }

  constructor(game, vision, { signal, runDir = path.join(PROJECT_ROOT, 'data/bettergi/runs', String(Date.now())), realtime = {}, navigation = {}, config = {}, gameCultureInfoName = 'zh-Hans', serverTimeZoneOffsetHours = 8 } = {}) {
    this.game = game;
    this.service = vision;
    this.signal = signal;
    this.runDir = path.resolve(runDir);
    this.sourceRoot = path.join(VENDOR_ROOT, 'source');
    this.config = config;
    this.combatState = {};
    this.partyState = {};
    this.foregroundTask = null;
    this.taskScope = new AsyncLocalStorage();
    this.frames = [];
    this.events = [];
    const host = this;
    this.taskHost = {
      sourceRoot: this.sourceRoot, signal, gameCultureInfoName, serverTimeZoneOffsetHours, config, runDir: this.runDir,
      addTaskTrigger(timer) { return host.dispatcher.addTrigger(timer); },
      pauseAutoPick() { return host.dispatcher.pauseAutoPick(); },
      capture() { return host.capture(this.signal ?? null); },
      vision(op, args) { return host.vision(op, args, this.signal ?? null); },
      input(method, args) { return host.input(method, args, true, this.signal ?? null); },
      sleep(ms) { return host.sleep(ms, this.signal ?? null); },
      log(level, text) { return host.log(level, text); },
      async isKeyDown(key) { return (await host.game.status()).sdk.pressedKeys.includes(key.length === 1 ? `Key${key.toUpperCase()}` : key); },
      navigation(operation, args) { return host.navigationAdapter(operation, args, this.signal ?? null); },
      combat(operation, args) { return host.combatAdapter(operation, args, this.signal ?? null); },
      genshin(method, args) { return host.genshin.call(method, args, this.signal ?? null); },
      task(operation, args) { return host.runTask(operation, args, this.signal ?? null); },
      clearTeamCache() { host.combat.clearTeam(); host.partyState.team = null; },
      async isGameActive() { const { sdk } = await host.game.status(); return sdk?.rtcDataChannelState === 'open' && sdk?.gameDataStarted === true; },
      setTime(hour, minute) { return new DailyTasks(this).setTime(hour, minute); },
      async disableSemiAutoFishing() { await host.fishing?.setEnabled(false); },
    };
    this.native = new NativeTasks(this.taskHost);
    this.daily = new DailyTasks(this.taskHost);
    this.navigation = new NavigationTasks(this.taskHost, navigation);
    this.genshin = new GenshinApi(this);
    this.routeScopes = [];
    this.realtimeHost = Object.assign(Object.create(this.taskHost), {
      capture() { return host.rawCapture(this.signal ?? null); },
      sleep(ms) { return host.rawSleep(ms, this.signal ?? null); },
    });
    this.fishing = new FishingController(this.realtimeHost, { config });
    this.dispatcher = new RealtimeDispatcher(this.realtimeHost, { userRoot: path.join(PROJECT_ROOT, 'data/bettergi/User'), useGlobalConfig: true, config, ...realtime, fishing: this.fishing });
    this.combat = new CombatTasks(this.realtimeHost, config.AutoFightConfig ?? {}, this.combatState);
  }

  async record(op, args) { this.events.push({ at: Date.now(), op, args }); }
  log(level, text) { this.events.push({ at: Date.now(), op: 'log', level, text: String(text) }); }

  async rawSleep(ms, signal = this.signal) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Sleep duration must be nonnegative');
    signal?.throwIfAborted();
    await delay(ms, undefined, { signal: signal ?? undefined });
  }

  async sleep(ms, signal = this.signal) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Sleep duration must be nonnegative');
    signal?.throwIfAborted();
    const end = Date.now() + ms;
    do {
      await this.dispatcher.tick(undefined, signal);
      signal?.throwIfAborted();
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      await this.rawSleep(Math.min(50, remaining), signal);
    } while (Date.now() < end);
    signal?.throwIfAborted();
  }

  async input(method, args = [], capturePixels = false, signal = this.signal) {
    const release = /^(releaseall|keyup|(left|right|middle)buttonup)$/i.test(method);
    if (!release) signal?.throwIfAborted();
    return this.game.input(method, args, capturePixels ? { metrics: [1920, 1080, 1] } : {});
  }

  async vision(op, args = {}, signal = this.signal) {
    const disposing = /^(image|yolo)\.dispose$|^(reward|salvage)\.(release|setRelease)$/.test(op);
    if (!disposing) signal?.throwIfAborted();
    const result = await this.service.call(op, args);
    if (!disposing) signal?.throwIfAborted();
    return result;
  }

  async loadAsset(feature, file, signal = this.signal) {
    const root = await realpath(path.join(this.sourceRoot, 'BetterGenshinImpact/GameTask'));
    for (const value of [feature, file]) {
      if (typeof value !== 'string' || !value || value.includes('\0') || /^[A-Za-z]:/.test(value) || path.isAbsolute(value.replaceAll('\\', '/'))) throw new TypeError('Asset requires relative feature and file names');
    }
    const folder = path.resolve(root, feature.replaceAll('\\', '/'), 'Assets/1920x1080');
    const filename = await realpath(path.resolve(folder, file.replaceAll('\\', '/')));
    if (!folder.startsWith(root + path.sep) || !filename.startsWith(folder + path.sep)) throw new Error('Asset path escapes original feature resources');
    return this.vision('image.load', { path: filename, type: 'Mat', mode: 'Color' }, signal);
  }

  async rawCapture(signal = this.signal) {
    signal?.throwIfAborted();
    const frame = await this.game.capture(path.join(this.runDir, 'latest-frame.png'));
    const { path: transientPath, ...metadata } = frame;
    this.frames.push({ ...metadata, retained: false });
    const descriptor = await this.service.call('image.load', { path: frame.path, type: 'ImageRegion' });
    if (signal?.aborted) { await this.service.call('image.dispose', { handle: descriptor.handle }); signal.throwIfAborted(); }
    return descriptor;
  }

  async capture(signal = this.signal) {
    const frame = await this.rawCapture(signal);
    try {
      await this.dispatcher.tick(frame, signal);
      signal?.throwIfAborted();
      return frame;
    } catch (error) { await this.service.call('image.dispose', { handle: frame.handle }); throw error; }
  }

  async checkpoint(name) {
    const frame = await this.game.capture(path.join(this.runDir, `${name}.png`));
    this.frames.push({ ...frame, retained: true });
    return frame;
  }

  scopedTaskHost(signal = this.signal, { raw = false } = {}) {
    const base = raw ? this.realtimeHost : this.taskHost;
    return signal === this.signal ? base : Object.assign(Object.create(base), { signal });
  }

  async navigationAdapter(operation, args = {}, signal = this.signal) {
    if (operation === 'endRoute') return this.routeScopes.pop()?.dispose();
    signal?.throwIfAborted();
    if (operation === 'beginRoute') {
      this.routeScopes.push(this.dispatcher.beginRoute(args.task));
      return { installed: true };
    }
    if (operation === 'blessingOfTheWelkinMoon') return new DailyTasks(this.scopedTaskHost(signal)).blessingOfTheWelkinMoon();
    if (['prepareRoute', 'recoverWhenLowHp', 'resolveAnomalies'].includes(operation)) return new PartyTasks(this.scopedTaskHost(signal, { raw: true }), { conditionConfig: this.config.PathingConditionConfig }, this.partyState)[operation](args);
    if (operation.startsWith('action.')) return new PathingActions(this.scopedTaskHost(signal), {
      dpi: this.navigation.options.dpi, autoFightConfig: this.config.AutoFightConfig, autoFishingConfig: this.config.AutoFishingConfig,
    }).run(operation.slice(7), { ...args, config: args.options?.partyConfig ?? this.navigation.options.partyConfig });
    throw new UnsupportedNativeOperation(`navigation.${operation}`);
  }

  async combatAdapter(operation, args = {}, signal = this.signal) {
    signal?.throwIfAborted();
    const host = this.scopedTaskHost(signal, { raw: true });
    const party = new PartyTasks(host, { conditionConfig: this.config.PathingConditionConfig }, this.partyState);
    if (operation === 'switchParty') return party.switchParty(args.name);
    if (operation === 'switchCharacter') return party.switchCharacter(args.slots, args.usePhysicalSlots);
    if (operation === 'clearPartyCache') return party.clearCache();
    if (operation === 'autoFight') return this.runTask('autoFight', args, signal);
    if (operation === 'getAvatars') return (await new CombatTasks(host, this.combat.options, this.combatState).initializeTeam({ force: true, requireObserved: true })).map(avatar => avatar.name);
    return new CombatTasks(host, this.combat.options, this.combatState).call(operation, args);
  }

  async runTask(operation, args = {}, signal = this.signal) {
    signal?.throwIfAborted();
    const host = this.scopedTaskHost(signal, { raw: true });
    const options = { config: this.config, taskConfig: args.config ?? args.param ?? {}, partyState: this.partyState, combatState: this.combatState, strategies: args.strategies, comboSession: args.comboSession, detailed: args.detailed };
    if (operation.toLowerCase() === 'autoeat') return this.exclusiveTask(operation, () => runAutoEat(host, { ...options, partyConfig: args.partyConfig ?? this.navigation.options.partyConfig }), { signal });
    if (operation.toLowerCase() === 'autoartifactsalvage') return this.exclusiveTask(operation, () => new SalvageTasks(host, this.config).autoArtifactSalvage(options.taskConfig), { signal });
    if (operation.toLowerCase() === 'autodomain') return this.exclusiveTask(operation, () => runAutoDomain(this.scopedTaskHost(signal), options), { pauseRealtime: false, signal });
    if (operation.toLowerCase() === 'autoboss') return this.exclusiveTask(operation, () => runAutoBoss(this.scopedTaskHost(signal), options), { pauseRealtime: false, signal });
    if (operation.toLowerCase() === 'autowood') return this.exclusiveTask(operation, () => runAutoWood(host, options), { signal });
    if (['autocombobuild', 'autocomborun', 'autocombo'].includes(operation.toLowerCase())) return this.exclusiveTask(operation, async () => {
      const { buildComboSession, AutoComboTask } = await import('./combo.mjs');
      const comboHost = this.scopedTaskHost(signal);
      if (operation.toLowerCase() !== 'autocomborun') this.comboSession = await buildComboSession(comboHost, this.config.AutoComboBuildConfig ?? {});
      if (operation.toLowerCase() === 'autocombobuild') return { built: true, team: this.comboSession.avatars.map(avatar => avatar.name), builtAt: this.comboSession.builtAt };
      return new AutoComboTask(comboHost, { ...options, config: this.config.AutoFightConfig, session: args.comboSession ?? this.comboSession }, this.combatState).start();
    }, { pauseRealtime: false, signal });
    if (['onekeyexpedition', 'autoexpedition'].includes(operation.toLowerCase())) return this.exclusiveTask('oneKeyExpedition', () => runOneKeyExpedition(host), { signal });
    if (['autogeniusinvokation', 'autotcg'].includes(operation.toLowerCase())) return this.exclusiveTask(operation, () => runAutoGeniusInvokation(host, { config: this.config, taskConfig: args.config, strategyContent: args.strategyContent, strategyRoot: args.strategyRoot }), { signal });
    if (['automusic', 'automusicgame', 'autoalbum'].includes(operation.toLowerCase())) return this.exclusiveTask(operation, () => (operation.toLowerCase() === 'autoalbum' ? runAutoAlbum : runAutoMusic)(host, { config: this.config, taskConfig: args.config }), { signal });
    if (operation.toLowerCase() === 'countinventoryitem') return this.exclusiveTask(operation, () => {
      const inventory = new InventoryTasks(host, this.config);
      return args.detailed ? inventory.countInventoryItemDetailed(args.config ?? args.param ?? args) : inventory.countInventoryItem(args.config ?? args.param ?? args);
    }, { signal });
    if (operation.toLowerCase() === 'autocook') return this.exclusiveTask('autoCook', () => runAutoCook(host, args.config ?? this.config.AutoCookConfig ?? {}), { signal });
    if (operation.toLowerCase() === 'autofishing') return this.exclusiveTask('autoFishing', async () => {
      const result = await runAutoFishing(host, { config: this.config, taskConfig: args.config });
      return { ...result, completed: result.completion === 'behaviourTreeTerminal' };
    }, { signal });
    if (operation.toLowerCase() === 'autofight') {
      return this.exclusiveTask('autoFight', async () => {
        return runAutoFight(this.scopedTaskHost(signal), { config: this.config.AutoFightConfig, comboBuildConfig: this.config.AutoComboBuildConfig, taskConfig: args.config ?? {}, partyState: this.partyState, strategies: args.strategies, comboSession: args.comboSession }, this.combatState);
      }, { pauseRealtime: args.suspendAutoPick === true, resumeDelayMs: (args.autoPickResumeDelaySeconds ?? 0) * 1000, signal });
    }
    throw new UnsupportedNativeOperation('task.' + operation);
  }

  async exclusiveTask(name, body, { pauseRealtime = true, resumeDelayMs = 0, signal = this.signal } = {}) {
    if (!Number.isFinite(resumeDelayMs) || resumeDelayMs < 0) throw new RangeError('Realtime resume delay must be nonnegative');
    if (this.foregroundTask && this.taskScope.getStore() !== this.foregroundOwner) throw new Error('BetterGI task already owns input: ' + this.foregroundTask);
    const previousTask = this.foregroundTask, previousOwner = this.foregroundOwner;
    if (!previousTask) this.dispatcher.beginTask();
    const owner = Symbol(name);
    this.foregroundOwner = owner;
    this.foregroundTask = name;
    if (pauseRealtime) this.realtimeHost.realtimePauseCount = (this.realtimeHost.realtimePauseCount ?? 0) + 1;
    const restoreFishing = this.fishing?.enabled;
    try {
      if (restoreFishing) await this.fishing.setEnabled(false);
      return await this.taskScope.run(owner, body);
    } finally {
      try {
        if (pauseRealtime && resumeDelayMs && !signal?.aborted) await this.rawSleep(resumeDelayMs, signal);
      } finally {
        try { if (restoreFishing && !this.fishing.closed) await this.fishing.setEnabled(true); }
        finally { if (pauseRealtime) this.realtimeHost.realtimePauseCount--; this.foregroundTask = previousTask; this.foregroundOwner = previousOwner; if (!previousTask) this.dispatcher.endTask(); }
      }
    }
  }

  async runPathing(args, signal = this.signal) {
    return this.exclusiveTask('pathing', () => this.executePathing(args, signal), { pauseRealtime: false, signal });
  }

  async runScript(options) {
    const { runScript } = await import('./script-runtime.mjs');
    const signal = options.signal ?? this.signal;
    return this.exclusiveTask('script', () => runScript({
      ...options, config: options.config ?? this.config,
      signal,
      callHost: (op, args, signal) => this.call(op, args, signal),
    }), { pauseRealtime: false, signal });
  }

  async executePathing(args, signal = this.signal) {
    const navigation = signal === this.signal ? this.navigation : new NavigationTasks(this.scopedTaskHost(signal), this.navigation.options);
    let task;
    if (args.filename) {
      let readSource;
      if (args.fileContext) {
        const files = new ScriptFiles(args.fileContext);
        readSource = async filename => {
          const relative = path.relative(files.root, filename);
          const located = files.locate(relative);
          if (!located) throw Object.assign(new Error(`Route file does not exist: ${relative}`), { code: 'ENOENT' });
          return readFile(located, 'utf8');
        };
      }
      task = await loadPathingTask(args.filename, { sourceRoot: this.sourceRoot, ...(readSource ? { readSource } : {}) });
    }
    else {
      task = parsePathingTask(args.source);
      const geometry = await navigation.geometry(task.mapName);
      const { loadAvatarCatalog } = await import('./native.mjs');
      const { aliases } = await loadAvatarCatalog(this.sourceRoot);
      task = parsePathingTask(args.source, { geometry, aliases });
    }
    signal?.throwIfAborted();
    return navigation.execute(task);
  }

  async yoloDetect(args, signal = this.signal) {
    const frame = await this.capture(signal);
    try { return await this.vision('yolo.regions', { ...args, handle: frame.handle }, signal); }
    finally { await this.vision('image.dispose', { handle: frame.handle }); }
  }

  async call(op, args = {}, signal = this.signal) {
    await this.record(op, op === 'inputText' ? { redacted: true } : args);
    if (op === 'capture') return this.capture(signal);
    if (op === 'asset.load') return this.loadAsset(args.feature, args.file, signal);
    if (op === 'input') return this.input(args.method, args.args, args.canonical === true, signal);
    if (op === 'sleep') return this.sleep(args.ms, signal);
    if (op === 'setGameMetrics') { this.game.setGameMetrics(...(args.metrics ?? [args.width, args.height, args.dpi ?? 1])); return this.game.metrics; }
    if (op === 'getGameMetrics') return this.game.metrics;
    if (op === 'log') return this.log(args.level, args.text ?? args.message);
    if (op === 'inputText') {
      signal?.throwIfAborted();
      if (typeof args.text !== 'string') throw new TypeError('inputText requires a string');
      await this.game.sdk('sendIme', [args.text]);
      return { ok: true };
    }
    if (op === 'yolo.detect') return this.yoloDetect(args, signal);
    if (op === 'getAvatars') return this.combatAdapter('getAvatars', {}, signal);
    if (op.startsWith('yolo.') || op.startsWith('realtime.')) return this.vision(op, args, signal);
    if (/^(image\.|recognition\.|vision\.|map\.|party\.|fight\.|fishing\.|music\.|inventory\.|tcg\.|reward\.|combo\.|salvage\.)/.test(op)) return this.vision(op, args, signal);
    if (op.startsWith('genshin.')) return this.genshin.call(op.slice(8), args.args ?? [], signal);
    if (op.startsWith('dispatcher.')) {
      const method = op.slice(11).toLowerCase(), values = args.args ?? [];
      if (method === 'addtimer') { this.dispatcher.addTimer(values[0]); return; }
      if (method === 'addtrigger') { this.dispatcher.addTrigger(values[0]); return; }
      if (method === 'clearalltriggers') return this.dispatcher.clearAllTriggers();
      if (method === 'runtask' && typeof values[0]?.name === 'string') return this.runTask(values[0].name, { config: values[0].config }, signal);
      if (['runautofighttask', 'runcountinventoryitemtask'].includes(method)) {
        if (!values[0] || typeof values[0] !== 'object') throw new TypeError('Task parameters are required');
        return this.runTask(method === 'runautofighttask' ? 'autoFight' : 'countInventoryItem', { config: values[0] }, signal);
      }
      if (method === 'runcombatscript') {
        if (typeof values[0] !== 'string' || !values[0].trim()) throw new TypeError('策略字符串不能为空');
        return this.exclusiveTask('combatScript', () => new NativeTasks(this.scopedTaskHost(signal)).runCombat(values[0], { validate: false, defaultAvatarName: values[1] }), { pauseRealtime: false, signal });
      }
    }
    if (op === 'keyMouseScript.run') return this.exclusiveTask('keyMouseScript', () => new NativeTasks(this.scopedTaskHost(signal)).runKeyMouse(args.source ?? args.json), { pauseRealtime: false, signal });
    if (op === 'pathingScript.run') return this.runPathing(args, signal);
    throw new UnsupportedNativeOperation(op);
  }

  async close(outcome = {}) {
    const failures = [];
    try { await this.dispatcher.close(); } catch (error) { failures.push(error); }
    try { await this.game.releaseAll(); } catch (error) { failures.push(error); }
    try { await this.record('session.end', await this.game.status()); } catch (error) { failures.push(error); }
    try {
      await writeFile(path.join(this.runDir, 'trace.json'), JSON.stringify({ outcome, sdkSha256: this.game.options.sdkSha256, events: this.events, inputs: this.game.trace, frames: this.frames, cleanupErrors: failures.map(error => error.message) }, null, 2));
    } catch (error) { failures.push(error); }
    try { await this.service.close(); } catch (error) { failures.push(error); }
    try { await this.game.browser.close(); } catch (error) { failures.push(error); }
    try { await this.unlock?.(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'BetterGI cleanup failed');
  }
}
