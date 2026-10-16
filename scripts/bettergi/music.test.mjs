import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutoAlbum, runAutoMusic } from './music.mjs';

const button = { x: 1500, y: 940, width: 160, height: 60 };
const icon = { x: 35, y: 25, width: 60, height: 40 };
const keys = ['VK_A', 'VK_S', 'VK_D', 'VK_J', 'VK_K', 'VK_L'];
const lanes = (values = [255, 255, 255, 255, 255, 255]) => keys.map((key, i) => ({ key, blue: values[i], inBounds: values[i] !== null }));

function fixture(options = {}) {
  const controller = options.controller ?? new AbortController();
  const timers = new Set(), images = new Map(), inputs = [], calls = [], logs = [];
  let clock = 0, sequence = 0, pumping = false, samples = 0, nextClicks = 0, resultClicks = 0;
  function schedule() {
    if (pumping || !timers.size) return;
    pumping = true;
    setImmediate(() => {
      pumping = false;
      if (!timers.size) return;
      clock = Math.min(...[...timers].map(timer => timer.at));
      for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.complete(); }
      schedule();
    });
  }
  const host = {
    signal: controller.signal, controller, inputs, calls, logs, images, timers, now: () => clock,
    async capture() {
      const value = { handle: ++sequence, width: options.width ?? 1920, height: options.height ?? 1080 };
      images.set(value.handle, value); calls.push({ op: 'capture', at: clock });
      await options.onCapture?.(host, value);
      return value;
    },
    async sleep(ms, signal = this.signal) {
      signal?.throwIfAborted();
      calls.push({ op: 'sleep', ms, at: clock });
      await options.onSleep?.(host, ms);
      signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        let timer;
        const cancel = () => { timers.delete(timer); signal?.removeEventListener('abort', cancel); reject(signal.reason); };
        timer = { at: clock + ms, complete() { signal?.removeEventListener('abort', cancel); resolve(); } };
        signal?.addEventListener('abort', cancel, { once: true });
        timers.add(timer); schedule();
      });
    },
    async input(method, args, signal = this.signal) {
      signal?.throwIfAborted();
      inputs.push({ method, args, at: clock });
      if (method === 'click') {
        if (args[0] === 310 * (options.width ?? 1920) / 1920 && args[1] === 220 * (options.height ?? 1080) / 1080) nextClicks++;
        if (args[0] === button.x + button.width / 2 && args[1] === button.y + button.height / 2) resultClicks++;
      }
      await options.onInput?.(host, method, args);
    },
    async vision(op, args, signal = this.signal) {
      signal?.throwIfAborted();
      calls.push({ op, args, at: clock });
      if (op === 'image.dispose') { assert.ok(images.delete(args.handle), 'only owned image disposed'); return; }
      assert.ok(images.has(args.handle), 'live image handle');
      if (op === 'music.sample') {
        samples++;
        const custom = await options.sample?.(samples, host, args);
        return custom ?? { lanes: lanes() };
      }
      if (op === 'music.albumPage') return { icon: options.noIcon ? null : icon, allSongs: options.allSongs ?? false, texts: [] };
      if (op === 'music.ui') {
        const result = {};
        for (const name of args.names) {
          let value;
          if (options.ui) value = await options.ui(name, host, args);
          if (value === undefined) {
            if (name === 'UiLeftTopAlbumIcon') value = options.returnMissing ? null : icon;
            else if (name === 'BtnList' || name === 'BtnWhiteConfirm') value = button;
            else value = nextClicks >= (options.playSongs ?? 0) ? button : null;
          }
          result[name] = value;
        }
        return result;
      }
      throw new Error('Unexpected operation: ' + op);
    },
    log(level, text) { logs.push({ level, text }); },
    get nextClicks() { return nextClicks; },
    get samples() { return samples; },
    get resultClicks() { return resultClicks; },
  };
  return host;
}

function clean(host) {
  assert.equal(host.images.size, 0, 'all captures disposed');
  assert.equal(host.timers.size, 0, 'all sleepers joined');
  assert.equal(host.inputs.at(-1).method, 'releaseAll');
}

test('default mode preserves blue219 down /220 up without80ms hold', async () => {
  const host = fixture({ sample: index => index <= 2 ? { lanes: lanes([index === 1 ? 219 : 220, 255, 255, 255, 255, 255]) } : undefined,
    onSleep(host) { if (host.samples >= 2) host.controller.abort(); } });
  await assert.rejects(runAutoMusic(host), { name: 'AbortError' });
  assert.deepEqual(host.inputs.slice(0, 2), [{ method: 'keyDown', args: ['VK_A'], at: 5 }, { method: 'keyUp', args: ['VK_A'], at: 10 }]);
  assert.ok(host.calls.filter(call => call.op === 'music.sample').every(call => call.args.useCapturePipeline === false));
  clean(host);
});

test('capture pipeline preserves80ms minimum with no repeat keyDown', async () => {
  const host = fixture({ sample: index => ({ lanes: lanes([index === 1 ? 0 : 255, 255, 255, 255, 255, 255]) }),
    onSleep(host) { if (host.samples >= 18) host.controller.abort(); } });
  await assert.rejects(runAutoMusic(host, { config: { AutoMusicGameConfig: { UseCapturePipeline: true } } }), { name: 'AbortError' });
  assert.deepEqual(host.inputs.filter(call => call.method.startsWith('key')), [
    { method: 'keyDown', args: ['VK_A'], at: 5 }, { method: 'keyUp', args: ['VK_A'], at: 85 },
  ]);
  clean(host);
});

test('lane order, simultaneous keys and bounds skip match the source keys', async () => {
  const host = fixture({ sample: () => ({ lanes: lanes([0, null, 219, 0, 219, 0]) }),
    onSleep(host) { if (host.samples) host.controller.abort(); } });
  await assert.rejects(runAutoMusic(host), { name: 'AbortError' });
  assert.deepEqual(host.inputs.filter(call => call.method === 'keyDown').map(call => call.args[0]), ['VK_A', 'VK_D', 'VK_J', 'VK_K', 'VK_L']);
  clean(host);
});

test('standalone rejects non16:9 before any gameplay input and releases', async () => {
  const host = fixture({ width: 1920, height: 1200 });
  await assert.rejects(runAutoMusic(host), /16:9/);
  assert.deepEqual(host.inputs.map(call => call.method), ['releaseAll']); clean(host);
});

test('cancellation during capture allocation owns and disposes the handle', async () => {
  const host = fixture({ onCapture(host) { host.controller.abort(); } });
  await assert.rejects(runAutoMusic(host), { name: 'AbortError' }); clean(host);
});

test('cancellation while a key is being issued releases using signal:null', async () => {
  const host = fixture({ sample: () => ({ lanes: lanes([0, 0, 0, 0, 0, 0]) }),
    onInput(host, method) { if (method === 'keyDown') host.controller.abort(); } });
  await assert.rejects(runAutoMusic(host), { name: 'AbortError' });
  assert.equal(host.inputs.filter(call => call.method === 'keyDown').length, 1); clean(host);
});

test('vision failure propagates after capture cleanup and held key release', async () => {
  const failure = new Error('sample transport failed');
  const host = fixture({ sample(index) { if (index === 2) throw failure; return { lanes: lanes([0, 255, 255, 255, 255, 255]) }; } });
  await assert.rejects(runAutoMusic(host), error => error === failure); clean(host);
});

test('capture resolution change fails rather than sampling stale geometry', async () => {
  let captures = 0;
  const host = fixture({ onCapture(_host, frame) { if (++captures > 1) { frame.width = 1280; frame.height = 720; } } });
  await assert.rejects(runAutoMusic(host), /分辨率/); clean(host);
});

test('source config defaults and empty BaseTaskParam do not override global config', async () => {
  const host = fixture();
  const result = await runAutoAlbum(host, { config: { AutoMusicGameConfig: { MusicLevel: '' } }, taskConfig: { musicLevel: '普通' } });
  assert.equal(result.musicLevel, '传说'); assert.equal(result.useCapturePipeline, false);
  assert.equal(result.mustCanorusLevel, false); assert.equal(result.songs.length, 13);
  assert.equal(result.completed, true); assert.equal(result.verified, false);
  assert.equal(result.scoreVerified, false); assert.equal(result.rewardsVerified, false);
  assert.equal(host.nextClicks, 13); clean(host);
});

test('all four difficulties retain13iterations each and exact canorus assets', async () => {
  const host = fixture();
  const result = await runAutoAlbum(host, { config: { automusicgameconfig: { musiclevel: '所有', mustcanoruslevel: true } } });
  assert.equal(result.songs.length, 52);
  for (let i = 0; i < 4; i++) {
    assert.equal(result.songs.filter(song => song.template === 'MusicCanorusLevel' + (i + 1)).length, 13);
  }
  assert.equal(host.nextClicks, 52); assert.equal(host.samples, 0); clean(host);
});

test('invalid settings reject before captures', async () => {
  for (const config of [{ MusicLevel: ' ' }, { MusicLevel: '专家' }, { UseCapturePipeline: 1 }, { MustCanorusLevel: 'false' }, { MusicLevel: 3 }]) {
    const host = fixture();
    await assert.rejects(runAutoAlbum(host, { config }));
    assert.equal(host.calls.length, 0);
  }
});

test('album requires observed themed album and rejects all-songs page', async () => {
  for (const option of [{ noIcon: true }, { allSongs: true }]) {
    const host = fixture(option);
    await assert.rejects(runAutoAlbum(host), /专辑|全部歌曲/);
    assert.equal(host.nextClicks, 0); clean(host);
  }
});

test('one played song uses exact confirm/difficulty waits, checker starts after5sec, workers join', async () => {
  const host = fixture({ playSongs: 1, sample: () => ({ lanes: lanes([0, 255, 255, 255, 255, 255]) }) });
  const result = await runAutoAlbum(host, { config: { musicLevel: '大师' } });
  assert.equal(result.songs[0].completion, 'resultListObserved');
  assert.equal(result.songs[0].albumReturnObserved, true);
  assert.equal(result.songs.filter(song => song.completion === 'existingTemplateObserved').length, 12);
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').slice(0, 6).map(call => call.ms), [500, 800, 200, 500, 500, 5000]);
  assert.ok(host.inputs.some(call => call.method === 'click' && call.args[0] === 1150 && call.args[1] === 600));
  const firstSample = host.calls.find(call => call.op === 'music.sample');
  const resultCheck = host.calls.find(call => call.op === 'music.ui' && call.args.names[0] === 'BtnList');
  assert.ok(resultCheck.at - firstSample.at >= 4995);
  const resultClick = host.inputs.findIndex(call => call.method === 'click' && call.at === resultCheck.at);
  const release = host.inputs.findIndex((call, i) => i > resultClick && call.method === 'releaseAll');
  const next = host.inputs.findIndex((call, i) => i > resultClick && call.method === 'click' && call.args[0] === 310);
  assert.ok(release > resultClick && release < next);
  assert.equal(host.calls.filter(call => call.op === 'music.sample' && call.at > host.inputs[next].at).length, 0);
  clean(host);
});

test('canonical1080 clicks scale to raw capture dimensions', async () => {
  const host = fixture({ width: 1280, height: 720 });
  await runAutoAlbum(host);
  assert.ok(host.inputs.filter(call => call.method === 'click').every(call => call.args[0] === 310 * 2 / 3 && call.args[1] === 220 * 2 / 3));
  clean(host);
});

test('missing white confirms retain source flow and do not fabricate a click', async () => {
  const host = fixture({ playSongs: 1, ui: name => name === 'BtnWhiteConfirm' ? null : undefined });
  const result = await runAutoAlbum(host, { config: { musicLevel: '普通' } });
  assert.equal(result.songs[0].completion, 'resultListObserved');
  assert.deepEqual(host.calls.filter(call => call.op === 'sleep').slice(0, 4).map(call => call.ms), [800, 200, 500, 5000]);
  assert.equal(host.inputs.filter(call => call.method === 'click' && call.args[0] === button.x + button.width / 2).length, 1);
  clean(host);
});

test('result checker error cancels and joins playback before propagating', async () => {
  const failure = new Error('result detector failed');
  const host = fixture({ playSongs: 1, ui(name) { if (name === 'BtnList') throw failure; } });
  await assert.rejects(runAutoAlbum(host), error => error === failure && error.evidence.completed === false);
  assert.equal(host.nextClicks, 0); clean(host);
});

test('music worker error cancels checker and preserves original failure', async () => {
  const failure = new Error('music capture failed');
  const host = fixture({ playSongs: 1, sample() { throw failure; } });
  await assert.rejects(runAutoAlbum(host), error => error === failure);
  assert.equal(host.calls.filter(call => call.op === 'music.ui' && call.args.names[0] === 'BtnList').length, 0);
  clean(host);
});

test('external abort during playback is propagated with no next-song click', async () => {
  const host = fixture({ playSongs: 1, sample(index, host) { if (index === 2) host.controller.abort(); return { lanes: lanes([0, 255, 255, 255, 255, 255]) }; } });
  await assert.rejects(runAutoAlbum(host), { name: 'AbortError' });
  assert.equal(host.nextClicks, 0); clean(host);
});

test('album joins an already running sample before releasing and advancing', async () => {
  let unblock, pending = false, checked = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const host = fixture({ playSongs: 1,
    async sample() { pending = true; await gate; pending = false; return { lanes: lanes([0, 255, 255, 255, 255, 255]) }; },
    onInput(host, method, args) {
      if (method !== 'click' || args[0] !== button.x + button.width / 2 || host.resultClicks !== 3) return;
      setImmediate(() => {
        assert.equal(pending, true);
        assert.equal(host.nextClicks, 0);
        assert.equal(host.inputs.some(call => call.method === 'releaseAll'), false);
        checked = true; unblock();
      });
    },
  });
  await runAutoAlbum(host);
  assert.equal(checked, true);
  assert.equal(pending, false);
  assert.equal(host.inputs.some(call => call.method === 'keyDown'), false, 'cancelled sample cannot emit a late key');
  clean(host);
});

test('input cleanup failure preserves the original task error and records cleanup failure', async () => {
  const failure = new Error('first music failure'), releaseFailure = new Error('release transport failed');
  const host = fixture({ sample() { throw failure; }, onInput(_host, method) { if (method === 'releaseAll') throw releaseFailure; } });
  await assert.rejects(runAutoMusic(host), error => error === failure);
  assert.ok(host.logs.some(line => line.level === 'error' && line.text.includes(releaseFailure.message)));
  clean(host);
});

test('failed release after observed result prevents album from starting next song', async () => {
  const failure = new Error('held key release not confirmed');
  const host = fixture({ playSongs: 1, onInput(_host, method) { if (method === 'releaseAll') throw failure; } });
  await assert.rejects(runAutoAlbum(host), error => error === failure);
  assert.equal(host.nextClicks, 0); clean(host);
});

test('disposal failure preserves the original observation error', async () => {
  const failure = new Error('first detector failure'), disposalFailure = new Error('disposal failed');
  const host = fixture({ sample() { throw failure; } }), originalVision = host.vision;
  host.vision = async function (op, args, signal = this.signal) {
    const result = await originalVision.call(this, op, args, signal);
    if (op === 'image.dispose' && host.samples) throw disposalFailure;
    return result;
  };
  await assert.rejects(runAutoMusic(host), error => error === failure);
  assert.ok(host.logs.some(line => line.level === 'error' && line.text.includes(disposalFailure.message)));
  clean(host);
});

test('album page timeout is uncompleted evidence and joins every worker', async () => {
  const host = fixture({ playSongs: 1, returnMissing: true });
  await assert.rejects(runAutoAlbum(host), error => {
    assert.equal(error.code, 'album-return-timeout');
    assert.equal(error.evidence.completed, false);
    assert.equal(error.evidence.songs[0].albumReturnObserved, false);
    assert.equal(error.evidence.songs[0].resultListObserved, true);
    return true;
  });
  assert.equal(host.calls.filter(call => call.op === 'sleep' && call.ms === 1000).length, 5);
  assert.equal(host.nextClicks, 0); clean(host);
});

test('source active lane map and13loop are pinned, ignoring obsolete comments', async () => {
  const root = fileURLToPath(new URL('../../third_party/bettergi/source/BetterGenshinImpact/GameTask/AutoMusicGame/', import.meta.url));
  const music = (await readFile(root + 'AutoMusicGameTask.cs', 'utf8')).replace(/\/\/[^\n]*/g, '');
  for (const [key, x] of [['A', 417], ['S', 628], ['D', 844], ['J', 1061], ['K', 1277], ['L', 1493]]) assert.ok(music.includes('[User32.VK.VK_' + key + '] = ' + x));
  assert.ok(music.includes('_keyY = 921')); assert.ok(music.includes('minHoldMs = 80'));
  assert.match(await readFile(root + 'AutoAlbumTask.cs', 'utf8'), /i < 13/);
});
