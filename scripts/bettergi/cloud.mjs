import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Ported from BetterGI Core/Input/Backends/WebSdk/WebKeyCodes.cs.
const codes = new Map(Object.entries({
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft',
  18: 'AltLeft', 19: 'Pause', 20: 'CapsLock', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft',
  38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 44: 'PrintScreen',
  45: 'Insert', 46: 'Delete', 91: 'MetaLeft', 92: 'MetaRight',
  106: 'NumpadMultiply', 107: 'NumpadAdd', 109: 'NumpadSubtract',
  110: 'NumpadDecimal', 111: 'NumpadDivide', 144: 'NumLock', 145: 'ScrollLock',
  160: 'ShiftLeft', 161: 'ShiftRight', 162: 'ControlLeft', 163: 'ControlRight',
  164: 'AltLeft', 165: 'AltRight', 186: 'Semicolon', 187: 'Equal', 188: 'Comma',
  189: 'Minus', 190: 'Period', 191: 'Slash', 192: 'Backquote',
  219: 'BracketLeft', 220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
}).map(([key, value]) => [Number(key), value]));
const aliases = {
  BACK: 8, TAB: 9, RETURN: 13, ENTER: 13, SHIFT: 16, CONTROL: 17, CTRL: 17,
  MENU: 18, ALT: 18, PAUSE: 19, CAPITAL: 20, ESCAPE: 27, ESC: 27, SPACE: 32,
  PRIOR: 33, NEXT: 34, END: 35, HOME: 36, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
  SNAPSHOT: 44, INSERT: 45, DELETE: 46, LWIN: 91, RWIN: 92,
  MULTIPLY: 106, ADD: 107, SUBTRACT: 109, DECIMAL: 110, DIVIDE: 111,
  NUMLOCK: 144, SCROLL: 145, LSHIFT: 160, RSHIFT: 161, LCONTROL: 162,
  RCONTROL: 163, LMENU: 164, RMENU: 165, OEM_1: 186, OEM_PLUS: 187,
  OEM_COMMA: 188, OEM_MINUS: 189, OEM_PERIOD: 190, OEM_2: 191, OEM_3: 192,
  OEM_4: 219, OEM_5: 220, OEM_6: 221, OEM_7: 222,
};

export function webKeyCode(key) {
  if (typeof key === 'string') {
    if (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2]))$/.test(key) || [...codes.values()].includes(key)) return key;
    const name = key.toUpperCase().replace(/^VK_/, '');
    if (/^[A-Z0-9]$/.test(name)) key = name.charCodeAt(0);
    else if (/^F([1-9]|1[0-2])$/.test(name)) key = 111 + Number(name.slice(1));
    else if (/^NUMPAD[0-9]$/.test(name)) key = 96 + Number(name.slice(6));
    else key = aliases[name];
  }
  if (key >= 65 && key <= 90) return `Key${String.fromCharCode(key)}`;
  if (key >= 48 && key <= 57) return `Digit${key - 48}`;
  if (key >= 112 && key <= 123) return `F${key - 111}`;
  if (key >= 96 && key <= 105) return `Numpad${key - 96}`;
  if (codes.has(key)) return codes.get(key);
  throw new Error(`Unsupported BetterGI virtual key: ${String(key)}`);
}

export class CloudGame {
  constructor(browser, page, options) {
    this.browser = browser;
    this.page = page;
    this.options = options;
    this.metrics = [1920, 1080, 1];
    this.queue = Promise.resolve();
    this.trace = [];
  }

  static async connect({ endpoint = 'http://127.0.0.1:9222', sdkPath, expectedSdkHash, ...options }) {
    const source = await readFile(sdkPath, 'utf8');
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (expectedSdkHash && sha256 !== expectedSdkHash) throw new Error('Upstream SDK hash mismatch');
    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const pages = browser.contexts().flatMap(context => context.pages());
      const page = pages.find(item => { try { return new URL(item.url()).hostname === 'ys.mihoyo.com'; } catch { return false; } });
      if (!page) throw new Error('No ys.mihoyo.com game page on CDP endpoint');
      await page.evaluate(() => {
        const mute = () => { for (const media of document.querySelectorAll('video,audio')) { media.muted = true; media.volume = 0; } };
        mute();
        window.__genshinMuteObserver?.disconnect();
        window.__genshinMuteObserver = new MutationObserver(mute);
        window.__genshinMuteObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.removeEventListener('volumechange', window.__genshinMuteListener, true);
        window.__genshinMuteListener = mute;
        document.addEventListener('volumechange', mute, true);
      });
      await page.evaluate(source);
      const game = new CloudGame(browser, page, { ...options, sdkPath, sdkSha256: sha256 });
      return game;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async sdk(method, args = []) {
    return this.serial(async () => {
      const started = Date.now();
      const result = await this.page.evaluate(async ({ method, args }) => {
        const sdk = window.__ysInputInject;
        if (!sdk || typeof sdk[method] !== 'function') throw new Error(`Cloud input SDK method missing: ${method}`);
        return await sdk[method](...args);
      }, { method, args });
      this.trace.push({ at: started, method, args: method.startsWith('send') ? ['<text omitted>'] : args, durationMs: Date.now() - started });
      return result;
    });
  }

  async status() {
    return this.serial(() => this.page.evaluate(() => {
      const video = [...document.querySelectorAll('video')].sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
      const getter = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement')?.get;
      return {
        sdk: window.__ysInputInject.status(),
        pointerLock: !!document.pointerLockElement,
        pointerLockGetterNative: !!getter && Function.prototype.toString.call(getter).includes('[native code]'),
        pointerLockOwnOverride: Object.hasOwn(document, 'pointerLockElement'),
        headless: navigator.userAgent.includes('HeadlessChrome'),
        video: video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState } : null,
      };
    }));
  }

  async assertConnected() {
    const status = await this.status();
    if (status.sdk.rtcDataChannelState !== 'open' || status.sdk.gameDataStarted !== true) throw new Error(`Cloud game is not connected (${status.sdk.stateMachine})`);
    return status;
  }

  setGameMetrics(width, height, dpi = 1) {
    if (![width, height, dpi].every(Number.isFinite) || width <= 0 || height <= 0 || dpi <= 0 || width * 9 !== height * 16) throw new Error('Game metrics must have positive 16:9 dimensions and DPI');
    this.metrics = [width, height, dpi];
  }

  async input(method, args = [], { metrics = this.metrics } = {}) {
    const lower = method.toLowerCase();
    const mouseKey = key => {
      const name = String(key).toUpperCase().replace(/^VK_/, '');
      return ({ LBUTTON: 'left', RBUTTON: 'right', MBUTTON: 'middle', 1: 'left', 2: 'right', 4: 'middle' })[name];
    };
    if (['keydown', 'keyup', 'keypress'].includes(lower)) {
      const button = mouseKey(args[0]);
      if (button) return this.sdk(({ keydown: 'mouseDown', keyup: 'mouseUp', keypress: 'click' })[lower], [button]);
      return this.sdk(({ keydown: 'keyDown', keyup: 'keyUp', keypress: 'tapKey' })[lower], [webKeyCode(args[0])]);
    }
    if (lower === 'movemouseto' || lower === 'click') {
      const [x, y] = args;
      const [width, height] = metrics;
      if (![x, y].every(Number.isFinite) || x < 0 || x > width || y < 0 || y > height) throw new Error(`Mouse coordinates outside script metrics: ${x},${y}`);
      if (lower === 'click') return this.sdk('click', ['left', 60, x / width, y / height]);
      await this.sdk('setAbsPosition', [x / width, y / height]);
      return this.sdk('mouseMove', [0, 0]);
    }
    if (lower === 'movemouseby') {
      if (args.length < 2 || !args.slice(0, 2).every(Number.isFinite)) throw new TypeError('Relative mouse movement requires two finite numbers');
      return this.sdk('mouseMove', args.slice(0, 2).map(value => Math.trunc(value / metrics[2])));
    }
    if (lower === 'verticalscroll') {
      if (!Number.isFinite(args[0])) throw new TypeError('Scroll requires a finite number');
      return this.sdk('scroll', [args[0] * 120]);
    }
    const buttonMatch = /^(left|right|middle)button(click|down|up)$/.exec(lower);
    if (buttonMatch) return this.sdk(({ click: 'click', down: 'mouseDown', up: 'mouseUp' })[buttonMatch[2]], buttonMatch[2] === 'click' ? [buttonMatch[1], 60] : [buttonMatch[1]]);
    if (lower === 'releaseall') return this.releaseAll();
    throw new Error(`Unsupported cloud input method: ${method}`);
  }

  async capture(filename) {
    return this.serial(async () => {
      const frame = await this.page.evaluate(async () => {
        const connection = window.__ysInputInject?.status();
        if (connection?.rtcDataChannelState !== 'open' || connection?.gameDataStarted !== true) throw new Error('Cannot capture a disconnected cloud game');
        const video = [...document.querySelectorAll('video')].sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error('Game video frame is unavailable');
        if (video.videoWidth * 9 !== video.videoHeight * 16) throw new Error('Game video must be 16:9');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { video.cancelVideoFrameCallback(callback); reject(new Error('No decoded game frame within 10000ms')); }, 10000);
          const callback = video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
        });
        const current = window.__ysInputInject?.status();
        if (current?.rtcDataChannelState !== 'open' || current?.gameDataStarted !== true) throw new Error('Cloud game disconnected while waiting for a frame');
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return { png: canvas.toDataURL('image/png').split(',')[1], sourceWidth: video.videoWidth, sourceHeight: video.videoHeight, videoTime: video.currentTime };
      });
      await mkdir(path.dirname(filename), { recursive: true });
      const png = Buffer.from(frame.png, 'base64');
      await writeFile(filename, png);
      return { path: filename, width: 1920, height: 1080, sourceWidth: frame.sourceWidth, sourceHeight: frame.sourceHeight, videoTime: frame.videoTime, capturedAt: Date.now(), sha256: createHash('sha256').update(png).digest('hex') };
    });
  }

  async releaseAll() {
    await this.sdk('releaseAll');
    const { sdk } = await this.status();
    if (sdk.pressedKeys.length || sdk.pressedButtons.length) throw new Error(`Remote input release not confirmed (${sdk.stateMachine})`);
  }

  async close() {
    try { await this.releaseAll(); } finally { await this.browser.close(); }
  }
}
