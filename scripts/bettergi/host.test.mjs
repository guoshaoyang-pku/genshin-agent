import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { BetterGiHost, VENDOR_ROOT } from './host.mjs';
import { CloudGame } from './cloud.mjs';
import { executeOperation, enterGame } from '../ops/bettergi.mjs';
import { AutoDomainTask } from './domain.mjs';
import { AutoBossTask } from './boss.mjs';
import { AutoWoodTask } from './wood.mjs';
import { AutoComboTask } from './combo.mjs';

test('cloud entry waits for main UI and reuses original loading templates before reporting success', async t => {
  const calls = []; let probes = 0;
  t.mock.method(CloudGame, 'connect', async () => ({
    page: { getByText: () => ({ isVisible: async () => false }) },
    status: async () => ({ sdk: { rtcDataChannelState: 'open', gameDataStarted: true }, video: { readyState: 4, width: 1920 } }),
    browser: { close: async () => calls.push('cloud.close') },
  }));
  const host = {
    runDir: '/validation/entry',
    native: {
      isInMainUi: async () => ++probes > 1,
      captured: body => body({ handle: 1 }),
      find: async (_frame, group, name) => { calls.push([group, name]); return name === 'EnterGame' ? { width: 10, height: 10 } : { width: 0, height: 0 }; },
      click: async () => calls.push('click'),
    },
    exclusiveTask: async (_name, body) => body(), sleep: async () => calls.push('sleep'),
    checkpoint: async () => ({ path: '/validation/entry/entered.png' }),
    game: { status: async () => ({ headless: true, pointerLock: false }) },
    close: async outcome => calls.push(outcome),
  };
  t.mock.method(BetterGiHost, 'connect', async options => { assert.equal(options.signal.aborted, false); return host; });
  const result = await enterGame();
  assert.equal(result.mainUiVerified, true); assert.equal(result.status.pointerLock, false);
  assert.deepEqual(calls.slice(0, 5), ['cloud.close', ['GameLoading', 'ChooseEnterGame'], ['GameLoading', 'EnterGame'], 'click', 'sleep']);
  assert.equal(calls.at(-1), result); assert.equal(probes, 2);
});

test('cloud entry rejects invalid timeouts and propagates failure after closing the owning host', async t => {
  for (const timeoutMs of [0, -1, Infinity]) await assert.rejects(enterGame({ timeoutMs }), /positive/);
  let cloudClosed = false, hostOutcome; const failure = new Error('loading recognition failed');
  t.mock.method(CloudGame, 'connect', async () => ({
    page: { getByText: () => ({ isVisible: async () => false }) },
    status: async () => ({ sdk: { rtcDataChannelState: 'open', gameDataStarted: true }, video: { readyState: 4, width: 1920 } }),
    browser: { close: async () => { cloudClosed = true; } },
  }));
  t.mock.method(BetterGiHost, 'connect', async () => ({
    exclusiveTask: async (_name, body) => body(), native: { isInMainUi: async () => { throw failure; } },
    close: async outcome => { hostOutcome = outcome; },
  }));
  await assert.rejects(enterGame(), error => error === failure);
  assert.equal(cloudClosed, true); assert.equal(hostOutcome.ok, false); assert.match(hostOutcome.error, /loading recognition failed/);
});

test('cloud capture waits for a decoded frame, rejects stalled or disconnected streams and never saves an old frame', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bettergi-fresh-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = () => {
    let decoded, expired, draws = 0, connected = true, canceled = false;
    const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4, currentTime: 17,
      requestVideoFrameCallback(callback) { decoded = callback; return 41; },
      cancelVideoFrameCallback(id) { assert.equal(id, 41); canceled = true; } };
    const context = {
      window: { __ysInputInject: { status: () => ({ rtcDataChannelState: connected ? 'open' : 'closed', gameDataStarted: connected }) } },
      document: { querySelectorAll: () => [video], createElement: () => ({ getContext: () => ({ drawImage() { draws++; } }), toDataURL: () => 'data:image/png;base64,ZnJlc2g=' }) },
      setTimeout(callback, ms) { assert.equal(ms, 10000); expired = callback; return 7; }, clearTimeout(id) { assert.equal(id, 7); },
    };
    return { game: new CloudGame({}, { evaluate: fn => vm.runInNewContext('(' + fn.toString() + ')()', context) }, {}),
      decode: () => decoded(), expire: () => expired(), disconnect: () => { connected = false; }, get draws() { return draws; }, get canceled() { return canceled; } };
  };
  const fresh = fixture(), filename = path.join(directory, 'fresh.png');
  const pending = fresh.game.capture(filename); await yieldToEvents();
  assert.equal(fresh.draws, 0); fresh.decode();
  assert.equal((await pending).videoTime, 17); assert.equal(fresh.draws, 1); assert.equal(await readFile(filename, 'utf8'), 'fresh');
  for (const kind of ['stalled', 'disconnected']) {
    const f = fixture(), output = path.join(directory, kind + '.png');
    const rejected = assert.rejects(f.game.capture(output), kind === 'stalled' ? /No decoded game frame/ : /disconnected while waiting/);
    await yieldToEvents();
    if (kind === 'stalled') f.expire(); else { f.disconnect(); f.decode(); }
    await rejected; assert.equal(f.draws, 0); await assert.rejects(readFile(output), { code: 'ENOENT' });
    if (kind === 'stalled') assert.equal(f.canceled, true);
  }
});

test('domain, boss, wood and combo task entries preserve observed runtime, configuration and ownership', async t => {
  const config = { AutoDomainConfig: { AutoEat: true }, AutoFightConfig: { Timeout: 27 } };
  const host = new BetterGiHost({}, {}, { config });
  const calls = [];
  for (const [Type, name, method] of [[AutoDomainTask, 'domain', 'start'], [AutoBossTask, 'boss', 'start'], [AutoWoodTask, 'wood', 'start'], [AutoComboTask, 'combo', 'start']]) {
    t.mock.method(Type.prototype, method, async function () {
      assert.ok(host.foregroundTask); calls.push(name);
      if (name === 'domain' || name === 'boss') {
        assert.equal(host.realtimeHost.realtimePauseCount ?? 0, 0);
        assert.equal(this.host.config, config); assert.equal(this.host.runDir, host.runDir);
        assert.equal(typeof this.host.addTaskTrigger, 'function'); assert.equal(typeof this.host.pauseAutoPick, 'function');
      }
      if (name === 'domain') return { rewardSummary: {}, completion: 'domain-entry' };
      if (name === 'boss') return { rewardSummary: {}, completion: 'boss-entry' };
      return { completion: name + '-entry' };
    });
  }
  assert.equal((await host.runTask('AutoDomain', { config: { DomainRoundNum: 1 }, detailed: true })).completion, 'domain-entry');
  assert.equal((await host.runTask('AutoBoss', { config: { SpecifyRunCount: true, RunCount: 1 }, detailed: true })).completion, 'boss-entry');
  await host.runTask('AutoWood', { config: { WoodRoundNum: 1 } });
  await host.runTask('AutoComboRun', { comboSession: {} });
  assert.deepEqual(calls, ['domain', 'boss', 'wood', 'combo']); assert.equal(host.foregroundTask, null);
});

test('Bv assets resolve original feature resources and reject escaped names', async () => {
  const calls=[];
  const host=new BetterGiHost({}, {call:async(op,args)=>{calls.push({op,args});return {__bgiType:'Mat',handle:1};}});
  const result=await host.call('asset.load',{feature:'Common\\Element',file:'paimon_menu.png'});
  assert.equal(result.handle,1);
  const original=path.join(VENDOR_ROOT,'source/BetterGenshinImpact/GameTask/Common/Element/Assets/1920x1080/paimon_menu.png');
  assert.equal(calls[0].args.path,original);
  assert.ok((await readFile(original)).length>100);
  for(const names of [{feature:'../../../../',file:'README.md'},{feature:'Common/Element',file:'../../../../../BetterGenshinImpact.csproj'},{feature:'/tmp',file:'a.png'},{feature:'Common/Element',file:'C:\\a.png'}]) {
    await assert.rejects(host.call('asset.load',names));
  }
  assert.equal(calls.length,1);
});

test('cancelled scopes can release input, dispose images and run cleanup sleep', async () => {
  const controller = new AbortController(), inputs = [], vision = [];
  const host = new BetterGiHost({ input: async (...args) => inputs.push(args) }, { call: async (...args) => vision.push(args) }, { signal: controller.signal });
  controller.abort(new Error('stop task'));
  await assert.rejects(host.rawSleep(1), /stop task/);
  await assert.rejects(host.taskHost.sleep(1), /stop task/);
  const cleanup = Object.create(host.realtimeHost, { signal: { value: null } });
  await cleanup.sleep(1);
  await cleanup.input('releaseAll', []);
  await cleanup.vision('image.dispose', { handle: 1 });
  assert.equal(inputs[0][0], 'releaseAll'); assert.equal(vision[0][0], 'image.dispose');
  assert.equal(host.signal.aborted, true);
});

test('foreground task ownership allows sequential nested tasks and rejects parallel callers', async () => {
  const host = new BetterGiHost({}, {});
  const toggles = [];
  host.fishing = { enabled: true, async setEnabled(value) { this.enabled = value; toggles.push(value); } };
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const pending = host.exclusiveTask('route', async () => {
    assert.equal(host.foregroundTask, 'route'); assert.equal(host.fishing.enabled, false);
    assert.equal(host.realtimeHost.realtimePauseCount ?? 0, 0);
    await host.exclusiveTask('fight', async () => { assert.equal(host.foregroundTask, 'fight'); assert.equal(host.realtimeHost.realtimePauseCount, 1); });
    assert.equal(host.foregroundTask, 'route'); assert.equal(host.realtimeHost.realtimePauseCount, 0);
    enter(); await blocked;
    throw new Error('route failed');
  }, { pauseRealtime: false });
  const rejected = assert.rejects(pending, /route failed/); await entered;
  await assert.rejects(host.exclusiveTask('other', async () => assert.fail('parallel input')), /already owns input: route/);
  release(); await rejected;
  assert.equal(host.foregroundTask, null); assert.equal(host.realtimeHost.realtimePauseCount, 0);
  assert.deepEqual(toggles, [false, true]);
});

test('foreground task cancellation skips resume delay and restores fishing after failure', async () => {
  const controller = new AbortController(), host = new BetterGiHost({}, {}, { signal: controller.signal });
  host.fishing = { enabled: true, async setEnabled(value) { this.enabled = value; } };
  host.rawSleep = async () => assert.fail('must not delay cancellation');
  await assert.rejects(host.exclusiveTask('fight', async () => { controller.abort(new Error('stop')); controller.signal.throwIfAborted(); }, { resumeDelayMs: 5000 }), /stop/);
  assert.equal(host.foregroundTask, null); assert.equal(host.fishing.enabled, true);
  assert.equal(host.realtimeHost.realtimePauseCount, 0);
});

test('game activity uses the cloud data channel and stream state', async () => {
  let sdk = { connected: true, rtcDataChannelState: 'closed', gameDataStarted: true };
  const host = new BetterGiHost({ status: async () => ({ sdk }) }, {});
  assert.equal(await host.taskHost.isGameActive(), false);
  sdk = { rtcDataChannelState: 'open', gameDataStarted: true };
  assert.equal(await host.taskHost.isGameActive(), true);
  sdk.gameDataStarted = false; assert.equal(await host.taskHost.isGameActive(), false);
});

test('dispatcher forwards original task objects and rejects malformed or unmigrated methods', async () => {
  const host = new BetterGiHost({}, {}), calls = [];
  host.runTask = async (...args) => { calls.push(args); return { result: calls.length }; };
  const controller = new AbortController();
  assert.deepEqual(await host.call('dispatcher.RunAutoFightTask', { args: [{ Timeout: 7, CombatStrategyPath: 'rotation.json' }] }, controller.signal), { result: 1 });
  assert.deepEqual(await host.call('dispatcher.RunCountInventoryItemTask', { args: [{ ItemNames: ['清水玉'] }] }), { result: 2 });
  await host.call('dispatcher.runTask', { args: [{ name: 'AutoAlbum', config: { MusicLevel: 'normal' } }] });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ['autoFight', { config: { Timeout: 7, CombatStrategyPath: 'rotation.json' } }],
    ['countInventoryItem', { config: { ItemNames: ['清水玉'] } }],
    ['AutoAlbum', { config: { MusicLevel: 'normal' } }],
  ]);
  assert.equal(calls[0][2], controller.signal);
  await assert.rejects(host.call('dispatcher.RunAutoFightTask', { args: [] }), /parameters/);
  await assert.rejects(host.call('dispatcher.RunCombatScript', { args: [' '] }), /不能为空/);
  await assert.rejects(host.call('dispatcher.missing', { args: [] }), /requires an implemented adapter/);
});

test('whole script owns TaskRunner scope, permits nested native tasks and restores global triggers', async t => {
  const scriptRoot = await mkdtemp(path.join(os.tmpdir(), 'bettergi-host-script-'));
  t.after(() => rm(scriptRoot, { recursive: true, force: true }));
  await writeFile(path.join(scriptRoot, 'manifest.json'), JSON.stringify({ name: 'host-task', main: 'main.js' }));
  await writeFile(path.join(scriptRoot, 'main.js'), "(async function(){ if(settings.marker!==9) throw Error('settings'); const p=new AutoFightParam(); if(p.Timeout!==37) throw Error('config'); dispatcher.addTrigger(new RealtimeTimer('AutoPick')); await dispatcher.RunAutoFightTask(p); })();");
  const host = new BetterGiHost({ setGameMetrics() {} }, {}, { config: { AutoFightConfig: { Timeout: 37 }, AutoPickConfig: { Enabled: true } } });
  const originalGlobals = host.dispatcher.globalLeases;
  let nested = false;
  host.runTask = async (name, args) => host.exclusiveTask(name, async () => {
    assert.equal(host.foregroundTask, 'autoFight'); assert.equal(host.dispatcher.inTask, true);
    assert.equal(host.dispatcher.leases.length, 1); assert.equal(args.config.Timeout, 37);
    nested = true;
  });
  const result = await host.runScript({ scriptRoot, settings: { marker: 9 } });
  assert.equal(result.package, 'host-task'); assert.equal(nested, true);
  assert.equal(host.foregroundTask, null); assert.equal(host.dispatcher.inTask, false);
  assert.equal(host.dispatcher.leases.length, 0); assert.equal(host.dispatcher.globalLeases, originalGlobals);
});

test('whole script inherits host cancellation and always ends task ownership', async t => {
  const scriptRoot = await mkdtemp(path.join(os.tmpdir(), 'bettergi-host-cancel-'));
  t.after(() => rm(scriptRoot, { recursive: true, force: true }));
  await writeFile(path.join(scriptRoot, 'manifest.json'), JSON.stringify({ name: 'host-cancel', main: 'main.js' }));
  await writeFile(path.join(scriptRoot, 'main.js'), 'while(true){}');
  const controller = new AbortController(), host = new BetterGiHost({ setGameMetrics() {} }, {}, { signal: controller.signal });
  const running = host.runScript({ scriptRoot });
  setTimeout(() => controller.abort(new Error('host stop')), 100);
  await assert.rejects(running, /host stop/);
  assert.equal(host.foregroundTask, null); assert.equal(host.dispatcher.inTask, false);
});

test('unified operations preserve task parameters, route source, native scripts and original package roots', async () => {
  const calls = [], signal = new AbortController().signal;
  const host = {
    signal,
    runTask: async (...args) => calls.push(['task', ...args]),
    runPathing: async (...args) => calls.push(['pathing', ...args]),
    runScript: async args => calls.push(['script', args]),
    call: async (...args) => calls.push(['call', ...args]),
    exclusiveTask: async (name, body) => { calls.push(['exclusive', name]); return body(); },
  };
  await executeOperation(host, 'task', { task: 'CountInventoryItem', taskConfig: { ItemNames: ['清水玉'] }, detailed: true });
  await executeOperation(host, 'pathing', { source: '{"positions":[]}' });
  await executeOperation(host, 'combat', { source: '当前角色 attack(1)', avatarName: '钟离' });
  await executeOperation(host, 'macro', { source: '{"events":[]}' });
  await executeOperation(host, 'genshin', { method: 'ReturnMainUi' });
  await executeOperation(host, 'script', { package: '取消任务追踪', config: { AutoFightConfig: { Timeout: 9 } }, userFightRoot: '/tmp/fights', userPathingRoot: '/tmp/routes' });
  assert.deepEqual(calls[0].slice(0, 3), ['task', 'CountInventoryItem', { config: { ItemNames: ['清水玉'] }, detailed: true, strategies: undefined, suspendAutoPick: undefined, autoPickResumeDelaySeconds: undefined }]);
  assert.equal(calls[0][3], signal); assert.equal(calls[1][1].source, '{"positions":[]}');
  assert.deepEqual(calls[2].slice(1, 3), ['dispatcher.RunCombatScript', { args: ['当前角色 attack(1)', '钟离'] }]);
  assert.equal(calls[3][1], 'keyMouseScript.run'); assert.equal(calls[5][1], 'genshin.ReturnMainUi');
  const script = calls.at(-1)[1];
  assert.equal(script.scriptRoot, path.join(VENDOR_ROOT, 'scripts/repo/js/取消任务追踪'));
  assert.equal(script.userFightRoot, '/tmp/fights'); assert.equal(script.userPathingRoot, '/tmp/routes');
  assert.equal(script.config.AutoFightConfig.Timeout, 9); assert.equal(script.signal, signal);
  await assert.rejects(executeOperation(host, 'task', {}), /Specify task/);
  await assert.rejects(executeOperation(host, 'genshin', { method: 'x', methodArgs: {} }), /methodArgs/);
});
