// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoMusicGameTask / AutoAlbumTask at c9db8b8291fe4ac25a600aee1582298005919eb2.
const LANES = ['VK_A', 'VK_S', 'VK_D', 'VK_J', 'VK_K', 'VK_L'];
const DIFFICULTIES = [
  { name: '普通', x: 480, template: 'MusicCanorusLevel1' },
  { name: '困难', x: 800, template: 'MusicCanorusLevel2' },
  { name: '大师', x: 1150, template: 'MusicCanorusLevel3' },
  { name: '传说', x: 1400, template: 'MusicCanorusLevel4' },
];
const field = (obj, key, fallback) => { const name = Object.keys(obj ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : obj[name]; };
const check = host => host.signal?.throwIfAborted();
const now = host => host.now ? host.now() : performance.now();
const exists = region => !!region && region.width > 0 && region.height > 0;
const cleanupHost = host => Object.create(host, { signal: { value: null, writable: true } });
async function input(host, method, args = []) { check(host); const result = await host.input(method, args); check(host); return result; }
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function vision(host, op, args) { check(host); const result = await host.vision(op, args); check(host); return result; }

function settings(options = {}) {
  const global = field(options, 'config', options);
  const config = field(global, 'AutoMusicGameConfig', field(global, 'AutoMusicGame', global));
  const useCapturePipeline = field(config, 'UseCapturePipeline', false);
  const mustCanorusLevel = field(config, 'MustCanorusLevel', false);
  const musicLevel = field(config, 'MusicLevel', '') ?? '';
  if (typeof useCapturePipeline !== 'boolean' || typeof mustCanorusLevel !== 'boolean') throw new TypeError('AutoMusicGame UseCapturePipeline and MustCanorusLevel must be boolean');
  if (typeof musicLevel !== 'string') throw new TypeError('AutoMusicGame MusicLevel must be a string');
  return { useCapturePipeline, mustCanorusLevel, musicLevel };
}

function assertResolution(frame) {
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0 || frame.width * 9 !== frame.height * 16) throw new Error('自动音游要求游戏画面分辨率为 16:9');
  return { width: frame.width, height: frame.height };
}

async function captured(host, body) {
  check(host);
  // Own the allocation before checking cancellation, including host post-call checks.
  const cleanup = cleanupHost(host), frame = await cleanup.capture();
  let failed;
  try { check(host); return await body(frame); }
  catch (error) { failed = error; throw error; }
  finally {
    try { if (frame?.handle) await cleanup.vision('image.dispose', { handle: frame.handle }); }
    catch (error) { if (!failed) throw error; host.log?.('error', 'Music capture disposal failed: ' + error.message); }
  }
}

async function ui(host, names) {
  return captured(host, frame => vision(host, 'music.ui', { handle: frame.handle, names }));
}

async function clickRegion(host, region) {
  if (!exists(region)) throw new Error('Cannot click an empty BetterGI music Region');
  await input(host, 'click', [(region.globalX ?? region.x) + region.width / 2, (region.globalY ?? region.y) + region.height / 2]);
}

async function playMusic(host, config, initialize = true, onCleanupError) {
  const states = new Map(LANES.map(key => [key, { down: false, pressedAt: 0 }]));
  let failed;
  try {
    const size = await captured(host, assertResolution);
    if (initialize) host.log?.('info', '自动音游需要胡桃款视觉样式“疏影引蝶映梅红”');
    host.log?.('info', '开始自动演奏');
    const minimumHoldMs = config.useCapturePipeline ? 80 : 0;
    while (true) {
      await sleep(host, 5);
      const observation = await captured(host, async frame => {
        if (!frame) return null;
        if (frame.width !== size.width || frame.height !== size.height) throw new Error('游戏分辨率在自动演奏期间发生变化');
        return vision(host, 'music.sample', { handle: frame.handle, useCapturePipeline: config.useCapturePipeline });
      });
      if (!observation) continue;
      for (const lane of observation.lanes) {
        check(host);
        const state = states.get(lane.key);
        if (!state) throw new Error('Unknown BetterGI music lane: ' + lane.key);
        if (!lane.inBounds) continue;
        if (state.down) {
          if (lane.blue >= 220 && now(host) - state.pressedAt >= minimumHoldMs) {
            state.down = false;
            await input(host, 'keyUp', [lane.key]);
          }
        } else if (lane.blue < 220) {
          state.down = true; state.pressedAt = now(host);
          await input(host, 'keyDown', [lane.key]);
        }
      }
    }
  } catch (error) { failed = error; throw error; }
  finally {
    try { await cleanupHost(host).input('releaseAll', []); }
    catch (error) { onCleanupError?.(error); if (!failed) throw error; host.log?.('error', 'Music input release failed: ' + error.message); }
    finally { host.log?.('info', '结束自动演奏'); }
  }
}

export async function runAutoMusic(rawHost, options = {}) {
  return playMusic(rawHost, settings(options));
}

async function whiteConfirm(host) {
  return captured(host, async frame => {
    const found = (await vision(host, 'music.ui', { handle: frame.handle, names: ['BtnWhiteConfirm'] })).BtnWhiteConfirm;
    if (!exists(found)) return false;
    await sleep(host, 500);
    await clickRegion(host, found);
    return true;
  });
}

async function playAlbumSong(host, config) {
  const controller = new AbortController();
  const cancelFromParent = () => controller.abort(host.signal.reason);
  host.signal?.addEventListener('abort', cancelFromParent, { once: true });
  if (host.signal?.aborted) cancelFromParent();
  const scoped = Object.create(host, { signal: { value: controller.signal, writable: true } });
  const internalStop = new DOMException('Album result checker stopped the other music worker', 'AbortError');
  const checker = async () => {
    while (true) {
      await sleep(scoped, 5000);
      const result = (await ui(scoped, ['BtnList'])).BtnList;
      if (exists(result)) {
        await clickRegion(scoped, result);
        return { resultListObserved: true, resultList: result };
      }
    }
  };
  let releaseFailure;
  const tasks = [checker(), playMusic(scoped, config, false, error => { releaseFailure = error; })];
  let first, outcomes;
  try {
    first = await Promise.race(tasks.map((task, index) => task.then(value => ({ index, value }), error => ({ index, error, failed: true }))));
  } finally {
    controller.abort(internalStop);
    outcomes = await Promise.allSettled(tasks);
    host.signal?.removeEventListener('abort', cancelFromParent);
  }
  check(host);
  if (first.failed) throw first.error;
  if (releaseFailure) throw releaseFailure;
  for (const result of outcomes) {
    if (result.status === 'rejected' && result.reason !== internalStop && !(result.reason?.name === 'AbortError' && result.reason.cause === internalStop)) throw result.reason;
  }
  if (first.index !== 0 || !first.value?.resultListObserved) throw new Error('自动演奏结束，但没有观察到返回列表按钮');
  return first.value;
}

async function waitAlbumPage(host) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(host, 1000);
    if (exists((await ui(host, ['UiLeftTopAlbumIcon'])).UiLeftTopAlbumIcon)) return true;
  }
  return false;
}

export async function runAutoAlbum(rawHost, options = {}) {
  const config = settings(options), musicLevel = config.musicLevel || '传说';
  const levels = musicLevel === '所有' ? DIFFICULTIES : DIFFICULTIES.filter(level => level.name === musicLevel);
  if (!levels.length) throw new RangeError('MusicLevel 必须是 普通、困难、大师、传说 或 所有');
  const host = rawHost, songs = [];
  let size, failed;
  const result = { completed: false, completion: null, verified: false, scoreVerified: false, rewardsVerified: false,
    musicLevel, mustCanorusLevel: config.mustCanorusLevel, useCapturePipeline: config.useCapturePipeline, songs };
  try {
    const page = await captured(host, frame => {
      size = assertResolution(frame);
      return vision(host, 'music.albumPage', { handle: frame.handle });
    });
    if (!exists(page.icon)) throw new Error('当前未处于主题专辑界面，请在以国家为主题的专辑页运行本任务');
    if (page.allSongs) throw new Error('当前在全部歌曲页面，此页面无法运行主题专辑任务');
    result.albumPageObserved = true;
    host.log?.('info', '自动音游需要胡桃款视觉样式“疏影引蝶映梅红”；乐曲难度：' + musicLevel);
    const click1080 = (x, y) => input(host, 'click', [x * size.width / 1920, y * size.height / 1080]);
    for (const level of levels) {
      for (let index = 1; index <= 13; index++) {
        check(host);
        const skipTemplate = config.mustCanorusLevel ? level.template : 'AlbumMusicComplate';
        if (exists((await ui(host, [skipTemplate]))[skipTemplate])) {
          songs.push({ index, difficulty: level.name, completion: 'existingTemplateObserved', template: skipTemplate });
          await click1080(310, 220); await sleep(host, 800);
          continue;
        }
        await whiteConfirm(host); await sleep(host, 800);
        await click1080(level.x, 600); await sleep(host, 200);
        await whiteConfirm(host); await sleep(host, 500);
        const observed = await playAlbumSong(host, config);
        const song = { index, difficulty: level.name, completion: 'resultListObserved', ...observed, albumReturnObserved: false };
        songs.push(song);
        await sleep(host, 2000);
        if (!await waitAlbumPage(host)) {
          const error = new Error('返回列表后等待主题专辑图标超时');
          error.code = 'album-return-timeout';
          throw error;
        }
        song.albumReturnObserved = true;
        await click1080(310, 220); await sleep(host, 800);
      }
    }
    return { ...result, completed: true, completion: 'sourceAlbumTraversal' };
  } catch (error) {
    failed = error;
    if (error && typeof error === 'object' && !host.signal?.aborted) error.evidence = result;
    throw error;
  } finally {
    try { await cleanupHost(host).input('releaseAll', []); }
    catch (error) { if (!failed) throw error; host.log?.('error', 'Album input release failed: ' + error.message); }
  }
}
