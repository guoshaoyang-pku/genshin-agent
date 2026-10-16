import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CloudGame } from '../bettergi/cloud.mjs';
import { BetterGiHost, VENDOR_ROOT } from '../bettergi/host.mjs';

const operations = ['capture', 'walk', 'look', 'main', 'mail', 'rewards', 'script', 'task', 'pathing', 'genshin', 'combat', 'macro'];

export async function enterGame({ endpoint, timeoutMs = 180000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Cloud game entry timed out')), timeoutMs);
  let game, host, outcome;
  try {
    game = await CloudGame.connect({ endpoint, sdkPath: path.join(VENDOR_ROOT, 'source/BetterGenshinImpact/Resources/JavaScript/ys-input-inject.js') });
    const page = game.page;
    const exit = page.getByText('退出游戏', { exact: true });
    if ((await game.status()).sdk.rtcDataChannelState !== 'open' && await exit.isVisible()) await exit.click({ timeout: Math.min(5000, timeoutMs) });
    const enter = page.getByText('进入游戏', { exact: true });
    if (await enter.isVisible()) await enter.click({ timeout: Math.min(5000, timeoutMs) });
    while (true) {
      controller.signal.throwIfAborted();
      const status = await game.status();
      if (status.sdk.rtcDataChannelState === 'open' && status.sdk.gameDataStarted === true && status.video?.readyState >= 2 && status.video.width > 0) break;
      const queue = page.getByText('普通队列', { exact: true });
      if (await queue.isVisible()) await queue.click({ timeout: Math.min(5000, timeoutMs) });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await game.browser.close(); game = null;
    host = await BetterGiHost.connect({ endpoint, signal: controller.signal });
    await host.exclusiveTask('enter', async () => {
      while (true) {
        controller.signal.throwIfAborted();
        if (await host.native.isInMainUi()) return;
        await host.native.captured(async frame => {
          for (const name of ['ChooseEnterGame', 'EnterGame']) {
            const button = await host.native.find(frame, 'GameLoading', name);
            if (button.width > 0 && button.height > 0) { await host.native.click(button); return; }
          }
        });
        await host.sleep(2000);
      }
    });
    const frame = await host.checkpoint('entered');
    outcome = { ok: true, operation: 'enter', mainUiVerified: true, status: await host.game.status(), screenshot: frame.path, runDir: host.runDir };
    return outcome;
  } catch (error) { outcome = { ok: false, operation: 'enter', error: String(error?.message ?? error) }; throw error; }
  finally { clearTimeout(timer); if (host) await host.close(outcome); else if (game) await game.browser.close(); }
}

async function packagePath(name) {
  const root = path.join(VENDOR_ROOT, 'scripts/repo/js');
  if (!name) throw new Error('Specify an installed BetterGI package name');
  const candidate = await realpath(path.resolve(root, name));
  if (!candidate.startsWith(await realpath(root) + path.sep)) throw new Error('Specify an installed BetterGI package name');
  await readFile(path.join(candidate, 'manifest.json'));
  return candidate;
}

export async function executeOperation(host, name, args = {}, signal = host.signal) {
  if (name === 'walk') {
    const key = args.key ?? 'S', ms = args.ms ?? 1000;
    if (!Number.isFinite(ms) || ms < 0 || ms > 10000) throw new RangeError('walk ms must be between 0 and 10000');
    return host.exclusiveTask('walk', async () => {
      await host.input('keyDown', [key]);
      try { await host.sleep(ms); } finally { await host.input('keyUp', [key]); }
      return { key, ms };
    }, { signal });
  }
  if (name === 'look') return host.exclusiveTask('look', async () => {
    signal?.throwIfAborted();
    await host.game.sdk('look', [args.dx ?? 300, args.dy ?? 0, args.steps ?? 20, args.intervalMs ?? 12]);
    return { dx: args.dx ?? 300, dy: args.dy ?? 0 };
  }, { signal });
  if (['main', 'mail', 'rewards'].includes(name)) return host.exclusiveTask(name, () => name === 'main' ? host.native.returnMainUi() : name === 'mail' ? host.native.claimMailRewards() : host.native.claimRewards(args), { signal });
  if (name === 'script') return host.runScript({
    scriptRoot: await packagePath(args.package), settings: args.settings ?? {}, config: args.config,
    entry: args.entry, stateRoot: args.stateRoot, userFightRoot: args.userFightRoot, userPathingRoot: args.userPathingRoot,
    serverTimeZoneOffsetMs: args.serverTimeZoneOffsetMs, signal, timeoutMs: args.timeoutMs,
  });
  if (name === 'task') {
    if (typeof args.task !== 'string' || !args.task.trim()) throw new TypeError('Specify task=AutoFight (or another migrated BetterGI task)');
    return host.runTask(args.task, { config: args.taskConfig ?? args.param, detailed: args.detailed, strategies: args.strategies, suspendAutoPick: args.suspendAutoPick, autoPickResumeDelaySeconds: args.autoPickResumeDelaySeconds }, signal);
  }
  if (name === 'pathing') {
    if (!args.filename && !args.source) throw new TypeError('Specify a route filename or source');
    return host.runPathing({ filename: args.filename, source: args.source }, signal);
  }
  if (name === 'genshin') {
    if (typeof args.method !== 'string' || !args.method.trim() || args.methodArgs !== undefined && !Array.isArray(args.methodArgs)) throw new TypeError('Specify a genshin method and optional methodArgs array');
    return host.exclusiveTask('genshin.' + args.method, () => host.call('genshin.' + args.method, { args: args.methodArgs ?? [] }, signal), { pauseRealtime: false, signal });
  }
  if (name === 'combat' || name === 'macro') {
    const source = args.source ?? (args.filename ? await readFile(args.filename, 'utf8') : undefined);
    if (typeof source !== 'string' || !source.trim()) throw new TypeError('Specify a script filename or source');
    return host.call(name === 'combat' ? 'dispatcher.RunCombatScript' : 'keyMouseScript.run', name === 'combat' ? { args: [source, args.avatarName] } : { source }, signal);
  }
  throw new Error(`Unknown BetterGI operation: ${name}`);
}

export async function run(name, args = {}) {
  if (name === 'enter') { console.log(JSON.stringify(await enterGame(args))); return; }
  if (name === 'catalog') {
    const root = path.join(VENDOR_ROOT, 'scripts/repo/js');
    const packages = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(root, entry.name, 'manifest.json'), 'utf8'));
        packages.push({ directory: entry.name, name: manifest.name, version: manifest.version, description: manifest.description });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    console.log(JSON.stringify({ packages }, null, 2));
    return;
  }
  if (name === 'status') {
    const game = await CloudGame.connect({ endpoint: args.endpoint, sdkPath: path.join(VENDOR_ROOT, 'source/BetterGenshinImpact/Resources/JavaScript/ys-input-inject.js') });
    try { console.log(JSON.stringify(await game.status())); } finally { await game.browser.close(); }
    return;
  }
  if (!operations.includes(name)) throw new Error(`Unknown BetterGI operation: ${name}`);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('BetterGI operation interrupted'));
  const timeoutMs = args.timeoutMs ?? 120000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const timeout = setTimeout(() => controller.abort(new Error(`BetterGI operation exceeded ${timeoutMs}ms`)), timeoutMs);
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let host, outcome;
  try {
    host = await BetterGiHost.connect({
      endpoint: args.endpoint, python: args.python, signal: controller.signal, runDir: args.runDir,
      config: args.config, navigation: args.navigation, realtime: args.realtime,
      gameCultureInfoName: args.gameCultureInfoName, serverTimeZoneOffsetHours: args.serverTimeZoneOffsetHours,
    });
    const before = await host.checkpoint('before');
    const result = name === 'capture' ? before : await executeOperation(host, name, { ...args, timeoutMs }, controller.signal);
    await host.sleep(300);
    const after = await host.checkpoint('after');
    outcome = { ok: true, operation: name, result, before: before.path, after: after.path, runDir: host.runDir };
  } catch (error) {
    outcome = { ok: false, operation: name, error: error.message };
    throw error;
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (host) await host.close(outcome);
  }
  console.log(JSON.stringify(outcome));
}
