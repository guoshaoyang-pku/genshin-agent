// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoFishingTask, Behaviours and AutoFishingTrigger at c9db8b8291fe4ac25a600aee1582298005919eb2.
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NativeTasks, loadRodNet } from './native.mjs';
import { webKeyCode } from './cloud.mjs';

/* Scheduling adapted from CsTrees 1.0.5, commit 8c52a59d6ad2fa4399b39ab06b347603658faa27.
MIT License. Copyright (c) CsTrees Contributors.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */
const Invalid = 'Invalid', Running = 'Running', Success = 'Success', Failure = 'Failure';
const field = (obj, key, fallback) => { const name = Object.keys(obj ?? {}).find(name => name.toLowerCase() === key.toLowerCase()); return name == null ? fallback : obj[name]; };
const exists = r => !!r && r.width > 0 && r.height > 0;
const now = host => host.now ? host.now() : performance.now();
const check = host => host.signal?.throwIfAborted();
async function input(host, method, args = []) { check(host); const result = await host.input(method, args); check(host); return result; }
async function sleep(host, ms) { check(host); if (ms > 0) await host.sleep(ms); check(host); }
async function vision(host, op, args) { check(host); const result = await host.vision(op, args); check(host); return result; }
const uninterruptible = host => Object.create(host, { signal: { value: null, writable: true } });
const ignoredBaits = failures => [...new Set(failures)].filter(bait => failures.filter(value => value === bait).length >= 2);
function settings(options = {}) {
  const global = field(options, 'config', options);
  const c = field(global, 'AutoFishingConfig', field(global, 'AutoFishing', global));
  const task = field(options, 'taskConfig', null);
  const integer = (value, label, minimum = 0) => {
    if (!Number.isInteger(value) || value < minimum) throw new TypeError('AutoFishing.' + label + ' must be an integer >= ' + minimum);
    return value;
  };
  const wholeProcessTimeoutSeconds = integer(field(task, 'wholeProcessTimeoutSeconds', field(c, 'wholeProcessTimeoutSeconds', 300)), 'WholeProcessTimeoutSeconds');
  const throwRodTimeOutTimeoutSeconds = integer(field(task, 'throwRodTimeOutTimeoutSeconds', field(c, 'autoThrowRodTimeOut', 15)), 'ThrowRodTimeOutTimeoutSeconds');
  const fishingTimePolicy = integer(field(task, 'fishingTimePolicy', field(c, 'fishingTimePolicy', 0)), 'FishingTimePolicy');
  if (fishingTimePolicy > 3) throw new RangeError('AutoFishing.FishingTimePolicy must be 0..3');
  const saveScreenshotOnKeyTick = field(task, 'saveScreenshotOnKeyTick', false);
  if (typeof saveScreenshotOnKeyTick !== 'boolean') throw new TypeError('AutoFishing.SaveScreenshotOnKeyTick must be boolean');
  const enabled = field(options, 'enabled', field(c, 'enabled', false));
  if (typeof enabled !== 'boolean') throw new TypeError('AutoFishing.Enabled must be boolean');
  const common = field(global, 'CommonConfig', {}), pick = field(global, 'AutoPickConfig', field(global, 'AutoPick', {}));
  const screenshotUidCoverEnabled = field(common, 'screenshotUidCoverEnabled', true);
  if (typeof screenshotUidCoverEnabled !== 'boolean') throw new TypeError('CommonConfig.ScreenshotUidCoverEnabled must be boolean');
  const itemTextLeftOffset = field(pick, 'itemTextLeftOffset', 115), itemTextRightOffset = field(pick, 'itemTextRightOffset', 400);
  if (![itemTextLeftOffset, itemTextRightOffset].every(Number.isFinite) || itemTextRightOffset <= itemTextLeftOffset) throw new RangeError('Invalid AutoPick item text offsets');
  return { wholeProcessTimeoutSeconds, throwRodTimeOutTimeoutSeconds, fishingTimePolicy, saveScreenshotOnKeyTick, enabled, screenshotUidCoverEnabled, pickKey: String(field(pick, 'pickKey', 'F')).trim().toUpperCase() || 'F', itemTextLeftOffset, itemTextRightOffset };
}

class Behaviour {
  constructor(name, update, initialize, screenshot = false) { Object.assign(this, { name, update, initialize, screenshot, status: Invalid, children: [], current: 0 }); }
  stop(status) {
    if (this.kind === 'parallel') {
      for (const child of this.children) if (child.status === Running) child.stop(Invalid);
    } else if (status === Invalid) {
      for (const child of this.children) if (child.status !== Invalid) child.stop(Invalid);
    }
    if (this.kind === 'map' && this.children[0].status === Running) this.children[0].stop(Invalid);
    this.status = status;
  }
  resetChildren() { for (const child of this.children) if (child.status !== Invalid) child.stop(Invalid); }
  async tick(ctx) {
    check(ctx.host);
    const fresh = this.status !== Running;
    if (this.kind) this.status = Running;
    if (this.kind === 'sequence') {
      if (fresh) { this.resetChildren(); this.current = 0; }
      else if (!this.memory) this.current = 0;
      for (; this.current < this.children.length; this.current++) {
        const status = await this.children[this.current].tick(ctx);
        if (status !== Success) {
          if (!this.memory) for (const child of this.children.slice(this.current + 1)) if (child.status !== Invalid) child.stop(Invalid);
          if (status === Running) this.status = Running; else this.stop(status);
          return this.status;
        }
      }
      this.stop(Success);
    } else if (this.kind === 'selector') {
      if (fresh) this.current = 0;
      else if (this.memory) {
        for (const child of this.children.slice(0, this.current)) if (child.status !== Invalid) child.stop(Invalid);
      } else this.current = 0;
      for (; this.current < this.children.length; this.current++) {
        const status = await this.children[this.current].tick(ctx);
        if (status !== Failure) {
          for (const child of this.children.slice(this.current + 1)) if (child.status !== Invalid) child.stop(Invalid);
          if (status === Running) this.status = Running; else this.stop(status);
          return this.status;
        }
      }
      this.current = Math.max(0, this.children.length - 1); this.stop(Failure);
    } else if (this.kind === 'parallel') {
      if (fresh) this.resetChildren();
      for (const child of this.children) if (!(this.all && child.status === Success)) await child.tick(ctx);
      const statuses = this.children.map(child => child.status);
      const status = statuses.includes(Failure) ? Failure : (this.all ? statuses.every(value => value === Success) : !statuses.length || statuses.includes(Success)) ? Success : Running;
      if (status === Running) this.status = status; else this.stop(status);
    } else if (this.kind === 'try') {
      if (fresh) { this.resetChildren(); this.current = 0; }
      if (this.current === 0) {
        const status = await this.children[0].tick(ctx);
        if (status === Running) { this.status = Running; return Running; }
        this.bodyResult = status; this.current = 1;
      }
      const status = await this.children[1].tick(ctx);
      if (status === Running) this.status = Running;
      else this.stop(this.bodyResult === Success && status === Success ? Success : Failure);
    } else if (this.kind === 'always') {
      if (fresh) this.resetChildren();
      const guard = await this.children[0].tick(ctx);
      if (guard === Running) this.status = Running;
      else if (guard !== Success) { if (this.children[1].status !== Invalid) this.children[1].stop(Invalid); this.stop(Failure); }
      else { const status = await this.children[1].tick(ctx); if (status === Running) this.status = status; else this.stop(status); }
    } else if (this.kind === 'map') {
      const status = await this.children[0].tick(ctx), result = status === this.from ? this.to : status;
      if (result === Running) this.status = result; else this.stop(result);
    } else {
      let status;
      try {
        if (fresh) await this.initialize?.call(this, ctx);
        status = await this.update.call(this, ctx);
      } catch (error) { this.status = Running; throw error; }
      if (![Running, Success, Failure].includes(status)) throw new Error('Invalid fishing behaviour status: ' + this.name);
      if (status === Running) this.status = status; else this.stop(status);
      if (this.screenshot && status !== Running && ctx.config.saveScreenshotOnKeyTick) await ctx.saveScreenshot(this.name, status);
    }
    return this.status;
  }
  async handoff(ctx) {
    if (this.status !== Running) return this.status;
    if (this.kind === 'try') {
      if (this.children[0].status === Running) { await this.children[0].handoff(ctx); if (this.children[0].status === Running) return Running; }
      if (await this.children[1].tick(ctx) === Running) return Running;
    } else if (this.kind === 'always') {
      if (this.children[1].status === Running) {
        if (await this.children[0].tick(ctx) !== Success) return Running;
        if (await this.children[1].handoff(ctx) === Running) return Running;
      } else if (this.children[0].status === Running && await this.children[0].handoff(ctx) === Running) return Running;
    } else if (this.kind === 'parallel') {
      for (const child of this.children) if (child.status === Running) await child.handoff(ctx);
      if (this.children.some(child => child.status === Running)) return Running;
    } else {
      const child = this.children[this.kind === 'map' ? 0 : this.current];
      if (child?.status === Running && await child.handoff(ctx) === Running) return Running;
    }
    this.status = Invalid; return Invalid;
  }
}
function composite(kind, name, children, options = {}) { return Object.assign(new Behaviour(name), { kind, children }, options); }
const sequence = (name, children, memory = true) => composite('sequence', name, children, { memory });
const parallel = (name, children, all = false) => composite('parallel', name, children, { all });
const mapped = (name, child, from, to) => composite('map', name, [child], { from, to });
const attempt = (name, body, cleanup) => composite('try', name, [body, cleanup]);

class FishingRound extends NativeTasks {
  constructor(host, config, options = {}, semiauto = false) {
    super(host); this.config = config; this.options = options; this.semiauto = semiauto;
    this.blackboard = { abort: false, chooseBaitFailures: [], throwRodNoBaitFishFailures: [], selectedBait: null };
    this.stats = { frames: 0, casts: 0, hookClicks: 0, barDisappearanceCount: 0, mainUiObserved: false };
    this.frame = null; this.screenshotIndex = 0;
    this.root = semiauto ? this.buildSemiAuto() : this.buildTask();
  }
  leaf(name, update, initialize, screenshot = true) {
    return new Behaviour(name, update, initialize, screenshot);
  }
  async observe(op, args = {}) { return vision(this.host, 'fishing.' + op, { handle: this.frame.handle, ...args }); }
  async ui(names) { return this.observe('ui', { names }); }
  async template(group, name, options) {
    const ro = await this.recognition(group, name, this.frame); check(this.host);
    return vision(this.host, 'image.find', { handle: this.frame.handle, recognition: { ...ro, ...options } });
  }
  async confirm(name) { const button = await this.template('Common/Element', name); if (!exists(button)) return false; await sleep(this.host, 500); await this.click(button); check(this.host); return true; }
  async findFishingInteraction() {
    const c = this.config, s = Math.min(this.frame.width / 1920, this.frame.height / 1080, 1);
    const ro = await this.recognition('AutoPick', 'F', this.frame); check(this.host);
    let key = c.pickKey;
    if (key !== 'F') {
      const filename = path.join(path.dirname(ro.template_path), key + '.png');
      try { await access(filename); ro.template_path = filename; ro.template = key + '.png'; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.host.log?.('error', '加载自定义拾取按键失败，继续使用默认的F键：' + key); key = 'F';
      }
    }
    webKeyCode(key);
    const button = await vision(this.host, 'image.find', { handle: this.frame.handle, recognition: ro });
    if (!exists(button)) return false;
    const roi = [button.x + Math.trunc(c.itemTextLeftOffset * s), button.y, Math.trunc((c.itemTextRightOffset - c.itemTextLeftOffset) * s), button.height];
    const words = await vision(this.host, 'image.ocr', { handle: this.frame.handle, recognition: { type: 'Ocr', roi } });
    if (!(words[0]?.text ?? '').match(new RegExp(this.options.fishingText ?? '钓鱼'))) return false;
    await input(this.host, 'keyPress', [key]); return true;
  }
  async saveScreenshot(name, status) {
    if (!this.frame) return;
    const dir = this.options.screenshotDir ?? path.join(this.host.userRoot ?? process.cwd(), 'log/screenshot');
    await mkdir(dir, { recursive: true });
    const filename = path.join(dir, new Date().toISOString().replace(/[-:.TZ]/g, '') + '_' + String(++this.screenshotIndex) + '_' + name + '_' + status + '.png');
    const cleanup = uninterruptible(this.host), handles = [];
    let handle = this.frame.handle;
    let failed;
    try {
      if (this.config.screenshotUidCoverEnabled) {
        check(this.host);
        const clone = await cleanup.vision('image.mat', { handle, method: 'Clone', args: [] }); handles.push(clone); handle = clone.handle; check(this.host);
        const s = Math.min(this.frame.width / 1920, this.frame.height / 1080);
        const roi = [Math.trunc(this.frame.width - 235 * s), Math.trunc(this.frame.height - 27 * s), Math.trunc(178 * s), Math.trunc(22 * s)];
        const uid = await cleanup.vision('image.mat', { handle, method: 'SubMat', args: [roi] }); handles.push(uid); check(this.host);
        await vision(this.host, 'image.mat', { handle: uid.handle, method: 'SetTo', args: [[255, 255, 255]] });
      }
      await vision(this.host, 'image.save', { handle, path: filename });
    } catch (error) { failed = error; throw error; }
    finally {
      let disposalError;
      for (const value of handles.reverse()) {
        try { await cleanup.vision('image.dispose', { handle: value.handle }); } catch (error) { disposalError ??= error; }
      }
      if (disposalError) { if (!failed) throw disposalError; this.host.log?.('error', disposalError.message); }
    }
    this.host.log?.('info', '保存截图: ' + filename);
  }
  moveViewpointDown() {
    return this.leaf('MoveViewpointDown', async ctx => {
      if (ctx.blackboard.pitchReset ?? true) { ctx.blackboard.pitchReset = false; await input(ctx.host, 'moveMouseBy', [0, 500]); await sleep(ctx.host, 100); return Running; }
      return Success;
    });
  }
  turnAround() {
    return this.leaf('TurnAround', async ctx => {
      const pond = await ctx.observe('fishpond');
      if (pond.detectionCount > 0) {
        await sleep(ctx.host, 1000);
        const r = pond.fishpondRect;
        if (r.x > Math.trunc(3 * ctx.frame.width / 4)) { await input(ctx.host, 'moveMouseBy', [100, 0]); await sleep(ctx.host, 100); return Running; }
        if (r.x + r.width < Math.trunc(ctx.frame.width / 4)) { await input(ctx.host, 'moveMouseBy', [-100, 0]); await sleep(ctx.host, 100); return Running; }
        await input(ctx.host, 'keyDown', ['S']); await sleep(ctx.host, 100); await input(ctx.host, 'keyUp', ['S']); await sleep(ctx.host, 400);
        await input(ctx.host, 'keyDown', ['W']); await sleep(ctx.host, 100); await input(ctx.host, 'keyUp', ['W']); await sleep(ctx.host, 700); return Success;
      }
      await input(ctx.host, 'moveMouseBy', [100, 0]); await sleep(ctx.host, 100); return Running;
    });
  }
  findFishTimeout(seconds) {
    return this.leaf('FindFishTimeout' + seconds, function (ctx) { if (now(ctx.host) >= this.deadline) { ctx.blackboard.abort = true; ctx.blackboard.abortReason = 'findFishTimeout'; return Failure; } return Running; }, function (ctx) { this.deadline = now(ctx.host) + seconds * 1000; }, false);
  }
  bubble() { return this.leaf('BubbleAbortCheck', ctx => ctx.blackboard.abort ? Failure : Success, undefined, false); }
  enterFishingMode() {
    return this.leaf('EnterFishingMode', async function (ctx) {
      if (this.status === Invalid) { this.deadline = now(ctx.host) + 10000; return Running; }
      if ((this.fCooldown == null || this.fCooldown < now(ctx.host)) && await ctx.findFishingInteraction()) { this.fCooldown = now(ctx.host) + 3000; return Running; }
      if ((this.confirmCooldown == null || this.confirmCooldown < now(ctx.host)) && await ctx.confirm('BtnWhiteConfirm')) {
        const selected = await ctx.observe('selectedBait'); ctx.blackboard.selectedBait = selected?.baitType ?? null;
        ctx.blackboard.pitchReset = true; this.confirmCooldown = now(ctx.host) + 3000; return Running;
      }
      if (exists((await ctx.ui(['ExitFishingButton'])).ExitFishingButton)) return Success;
      return this.deadline < now(ctx.host) ? Failure : Running;
    });
  }
  quitFishingMode() {
    return this.leaf('QuitFishingMode', async function (ctx) {
      if (ctx.blackboard.handoffTimeSeconds != null && ctx.blackboard.handoffTimeSeconds <= 10) return Success;
      if (this.status === Invalid) return Running;
      if (await ctx.isInMainUi(ctx.frame)) { check(ctx.host); ctx.stats.mainUiObserved = true; return Success; }
      check(ctx.host);
      if (await ctx.confirm('BtnBlackConfirm')) await sleep(ctx.host, 1000);
      else { await input(ctx.host, 'keyPress', ['VK_ESCAPE']); await sleep(ctx.host, 2000); }
      return Running;
    });
  }
  initialState() {
    return this.leaf('CheckInitialState', async function (ctx) {
      if (exists((await ctx.ui(['BaitButton'])).BaitButton)) return Success;
      if (this.interval == null || now(ctx.host) > this.interval) {
        this.theta += Math.PI / 10; const rho = 10 + 2 * this.theta;
        await input(ctx.host, 'moveMouseBy', [Math.trunc(rho * Math.cos(this.theta)), Math.trunc(rho * Math.sin(this.theta))]); this.interval = now(ctx.host) + 100;
      }
      return Running;
    }, function () { this.theta = 0; });
  }
  getFishpond() {
    return this.leaf('GetFishpond', async function (ctx) {
      if (this.interval != null && now(ctx.host) < this.interval) return Running;
      this.interval = now(ctx.host) + 500;
      const pond = await ctx.observe('fishpond', { ignoreObtained: true });
      if (!exists(pond.fishpondRect)) return Running;
      ctx.blackboard.fishpond = pond;
      const ignored = [...ignoredBaits(ctx.blackboard.chooseBaitFailures), ...ignoredBaits(ctx.blackboard.throwRodNoBaitFishFailures)];
      await sleep(ctx.host, 1000);
      return pond.fishes.some(fish => !ignored.includes(fish.baitType)) ? Success : Running;
    });
  }
  chooseBait() {
    return this.leaf('ChooseBait', async function (ctx) {
      const b = ctx.blackboard;
      if (this.status === Invalid) {
        if (b.selectedBait != null && b.fishpond.fishes.some(fish => fish.baitType === b.selectedBait)) return Success;
        this.deadline = now(ctx.host) + 3000; b.chooseBaitUIOpening = true;
        await input(ctx.host, 'rightButtonClick'); await sleep(ctx.host, 100); await input(ctx.host, 'moveMouseBy', [0, 200]); await sleep(ctx.host, 500); return Running;
      }
      const groups = new Map();
      for (const fish of b.fishpond.fishes) groups.set(fish.baitType, (groups.get(fish.baitType) ?? 0) + 1);
      const ignored = ignoredBaits(b.chooseBaitFailures), eligible = [...groups].filter(([bait]) => !ignored.includes(bait)).sort((a, b) => b[1] - a[1]);
      if (!eligible.length) throw new Error('ChooseBait has no eligible bait in the original fishpond');
      b.selectedBait = eligible[0][0];
      const grid = await ctx.observe('baitGrid');
      const bait = grid.find(item => item.baitType === b.selectedBait);
      if (bait) {
        await ctx.click(bait.rect); check(ctx.host); await sleep(ctx.host, 700);
        await input(ctx.host, 'click', [Math.trunc(ctx.frame.width * 0.675), Math.trunc(ctx.frame.height / 3)]); await sleep(ctx.host, 200);
        const confirm = await ctx.template('Common/Element', 'BtnWhiteConfirm', { roi: [0, 0, ctx.frame.width, ctx.frame.height], use3Channels: true });
        if (exists(confirm)) { await ctx.click(confirm); check(ctx.host); }
        b.chooseBaitUIOpening = false; await sleep(ctx.host, 500); return Success;
      }
      if (now(ctx.host) >= this.deadline) { await input(ctx.host, 'keyPress', ['VK_ESCAPE']); b.chooseBaitUIOpening = false; b.chooseBaitFailures.push(b.selectedBait); b.selectedBait = null; return Failure; }
      await sleep(ctx.host, 200); return Running;
    });
  }
  async randomMove() {
    const random = this.host.random ?? Math.random, w = this.frame.width, h = this.frame.height;
    await input(this.host, 'moveMouseBy', [Math.trunc(100 * (Math.trunc(w / 2) - Math.floor(random() * w)) / w), Math.trunc(100 * (Math.trunc(h / 2) - Math.floor(random() * h)) / h)]);
  }
  liftRod() {
    return this.leaf('LiftRod', async function (ctx) {
      const b = ctx.blackboard, pond = await ctx.observe('fishpond', { includeTarget: now(ctx.host) <= this.includeTargetEnd }); b.fishpond = pond;
      if (!exists(pond.targetRect)) {
        if (!this.foundTarget) {
          if (now(ctx.host) <= this.targetDeadline) { this.r += Math.PI / 16; await input(ctx.host, 'moveMouseBy', [0, this.direction * 80 * Math.sign(Math.cos(this.r))]); await sleep(ctx.host, 100); return Running; }
          b.throwRodNoTarget = true; b.throwRodNoTargetTimes = (b.throwRodNoTargetTimes ?? 0) + 1;
          if (b.throwRodNoTargetTimes > 2) { b.abort = true; b.abortReason = 'noRodTarget'; } return Failure;
        }
        this.noPlacementTimes++; await sleep(ctx.host, 50); await ctx.randomMove(); return this.noPlacementTimes > 25 ? Failure : Running;
      }
      this.foundTarget = true;
      const aim = await ctx.observe('rodInput', { fishpond: pond, selectedBait: b.selectedBait, ignoredBaits: ignoredBaits(b.throwRodNoBaitFishFailures) });
      if (!aim.currentFish) {
        if (++this.noTargetFishTimes > 10) {
          b.throwRodNoBaitFish = true;
          if (b.selectedBait == null) throw new Error('LiftRod selected bait is null');
          b.throwRodNoBaitFishFailures.push(b.selectedBait); b.selectedBait = null; return Failure;
        }
        return Running;
      }
      this.noTargetFishTimes = 0;
      const state = ctx.rodNet.getRodState(aim.rodInput), { dx, dy, distance } = aim;
      if (![dx, dy, distance].every(Number.isFinite) || distance < 0) throw new RangeError('Invalid RodNet aim geometry');
      if (state === 0) return Success;
      if (state === -1) await ctx.randomMove();
      else if (state === 1) {
        if (!distance) throw new RangeError('RodNet close-aim distance is zero');
        await input(ctx.host, 'moveMouseBy', [Math.trunc(-(dx / distance * 30) / 1.5), Math.trunc(-(dy / distance * 30) * 1.5)]);
      } else if (state === 2) await input(ctx.host, 'moveMouseBy', [Math.trunc(dx / 1.5), Math.trunc(dy * 1.5)]);
      else throw new RangeError('Invalid original RodNet state: ' + state);
      await sleep(ctx.host, Math.trunc(distance)); return Running;
    }, async function (ctx) {
      const b = ctx.blackboard; this.noPlacementTimes = this.noTargetFishTimes = 0; b.throwRodNoBaitFish = b.throwRodNoTarget = false;
      this.includeTargetEnd = now(ctx.host) + 6000; this.targetDeadline = now(ctx.host) + 5000; this.foundTarget = false;
      this.direction = -(this.direction ?? 1); this.r = 0;
      await input(ctx.host, 'leftButtonDown'); b.pitchReset = true;
    });
  }
  cast() {
    return this.leaf('Cast', async function (ctx) {
      if (this.castAt == null) { await input(ctx.host, 'leftButtonUp'); this.castAt = now(ctx.host); ctx.stats.casts++; return Running; }
      return now(ctx.host) - this.castAt < 2000 ? Running : Success;
    }, function () { this.castAt = null; });
  }
  checkButtonAfter(name, buttonName) {
    return this.leaf(name, async function (ctx) {
      if (now(ctx.host) < this.deadline || this.checked) return Running;
      if (exists((await ctx.ui([buttonName]))[buttonName])) return Failure;
      this.checked = true; return Running;
    }, function (ctx) { this.deadline = now(ctx.host) + 3000; this.checked = false; });
  }
  biteTimeout() {
    return this.leaf('FishBiteTimeout', async function (ctx) {
      if (now(ctx.host) < this.deadline) return Running;
      if (this.clicked) return Failure;
      this.clicked = true; await input(ctx.host, 'leftButtonClick'); this.deadline = now(ctx.host) + 2000; return Running;
    }, function (ctx) { this.deadline = now(ctx.host) + ctx.config.throwRodTimeOutTimeoutSeconds * 1000; this.clicked = false; });
  }
  checkFishBite() { return this.leaf('CheckFishBite', async ctx => (await ctx.observe('bite', { getABiteText: ctx.options.getABiteText ?? '上钩' })).bite ? Success : Running); }
  raiseHook() {
    return this.leaf('RaiseHook', async function (ctx) {
      if (now(ctx.host) < this.deadline && this.delay == null) {
        const ui = await ctx.ui(['WaitBiteButton', 'LiftRodButton']);
        if (exists(ui.WaitBiteButton) || exists(ui.LiftRodButton)) { await input(ctx.host, 'leftButtonClick'); ctx.stats.hookClicks++; this.delay = now(ctx.host) + 800; }
        return Running;
      }
      return this.delay != null && now(ctx.host) < this.delay ? Running : Success;
    }, function (ctx) { this.deadline = now(ctx.host) + 2000; this.delay = null; });
  }
  getFishBox() {
    return this.leaf('GetFishBoxArea', async function (ctx) {
      if (now(ctx.host) > this.deadline) return Failure;
      const box = await ctx.observe('fishBox');
      if (exists(box.rect)) { ctx.blackboard.fishBoxRect = box.rect; return Success; }
      if (ctx.config.saveScreenshotOnKeyTick && box.reason === 'height-difference') await ctx.saveScreenshot('GetFishBoxArea', 'Error');
      return Running;
    }, function (ctx) { this.deadline = now(ctx.host) + 5000; });
  }
  fishing() {
    return this.leaf('Fishing', async function (ctx) {
      const control = await ctx.observe('control', { fishBoxRect: ctx.blackboard.fishBoxRect });
      if (control.sourceCount > 3 && ctx.config.saveScreenshotOnKeyTick) await ctx.saveScreenshot('Fishing', 'Error');
      if (control.invalidTwoRects) return Running;
      if (typeof control.desiredPressed === 'boolean' && control.desiredPressed !== (this.pressed ?? false)) {
        await input(ctx.host, control.desiredPressed ? 'leftButtonDown' : 'leftButtonUp'); this.pressed = control.desiredPressed;
      }
      if (control.resetNoDetectionTimer) this.missingDeadline = null;
      if (!control.missing) return Running;
      if (this.missingDeadline == null) { this.missingDeadline = now(ctx.host) + 1000; return Running; }
      if (now(ctx.host) < this.missingDeadline) return Running;
      await input(ctx.host, 'leftButtonUp'); this.pressed = false; ctx.stats.barDisappearanceCount++; return Success;
    });
  }
  buildTask() {
    const castAndAim = attempt('AimAndCast', sequence('Aim', [this.moveViewpointDown(), this.liftRod()]), this.cast());
    const repeatCast = mapped('RepeatCast', composite('selector', 'CastOrRaise', [castAndAim, mapped('RaiseThenFail', this.raiseHook(), Success, Failure)], { memory: true }), Failure, Running);
    const throwResult = this.leaf('CheckThrowRodResult', ctx => ctx.blackboard.abort || ctx.blackboard.throwRodNoTarget || ctx.blackboard.throwRodNoBaitFish ? Failure : Running, undefined, false);
    const castBite = attempt('CastWaitRaise', sequence('CastWait', [parallel('CastUntilResult', [repeatCast, throwResult]), parallel('WaitingBite', [this.checkButtonAfter('CheckThrowRod', 'BaitButton'), this.checkFishBite(), this.biteTimeout()])]), this.raiseHook());
    const fromFishpond = sequence('FromFishpond', [this.moveViewpointDown(), parallel('InitialFishpond10s', [sequence('InitialFishpond', [this.initialState(), this.getFishpond()]), this.findFishTimeout(10)]), this.chooseBait(), castBite, parallel('Reel', [this.checkButtonAfter('CheckRaiseHook', 'WaitBiteButton'), sequence('ReelSequence', [this.getFishBox(), this.fishing()])])]);
    const keepFishing = mapped('KeepFishing', sequence('UntilNoFish', [mapped('IgnoreCycleFailure', fromFishpond, Failure, Success), this.bubble()], false), Success, Running);
    const enterQuit = attempt('EnterAndQuit', sequence('EnterAndFish', [this.enterFishingMode(), keepFishing]), this.quitFishingMode());
    const initial = parallel('InitialSearch', [sequence('FindFish', [this.moveViewpointDown(), parallel('FindFish20s', [this.turnAround(), this.findFishTimeout(20)])]), this.bubble()], true);
    const wholeTimeout = this.leaf('WholeProcessTimeout', function (ctx) { if (now(ctx.host) >= this.deadline) { ctx.blackboard.abort = true; ctx.blackboard.abortReason = 'wholeProcessTimeout'; } return Running; }, function (ctx) { this.deadline = now(ctx.host) + ctx.config.wholeProcessTimeoutSeconds * 1000; }, false);
    return composite('always', 'FreshScreenshot', [this.screenshot(), parallel('TimedFishing', [sequence('SearchAndFish', [initial, enterQuit]), wholeTimeout])]);
  }
  buildSemiAuto() {
    const ui = this.leaf('CheckFishingUserInterface', async ctx => {
      ctx.exclusive = exists((await ctx.ui(['ExitFishingButton'])).ExitFishingButton); return ctx.exclusive ? Running : Failure;
    }, undefined, false);
    const reel = mapped('ReelLoop', sequence('SemiAutoReel', [this.checkFishBite(), this.raiseHook(), this.getFishBox(), this.fishing()]), Failure, Success);
    return sequence('SemiAutoFishing', [this.screenshot(), parallel('SemiAutoRoot', [ui, reel])], false);
  }
  screenshot() {
    return this.leaf('TakeScreenshot', async ctx => {
      await ctx.disposeFrame(); check(ctx.host);
      const frame = await ctx.host.capture(); ctx.frame = frame; check(ctx.host);
      if (!(frame.width > 0 && frame.height > 0)) throw new RangeError('AutoFishing requires a nonempty capture');
      ctx.stats.frames++; return Success;
    }, undefined, false);
  }
  async disposeFrame() { if (this.frame) { const frame = this.frame; this.frame = null; await uninterruptible(this.host).vision('image.dispose', { handle: frame.handle }); } }
  async tick() { return this.root.tick(this); }
  async handoff() { this.blackboard.handoffTimeSeconds = 1; return this.root.handoff(this); }
}

export class FishingTask extends NativeTasks {
  constructor(host, options = {}) { super(host); this.options = options; this.config = settings(options); }
  createRound() { this.round = new FishingRound(this.host, this.config, this.options); this.round.rodNet = this.rodNet; return this.round; }
  async setTime(hour) {
    if (this.host.setTime) return this.host.setTime(hour, 0);
    const { DailyTasks } = await import('./daily.mjs');
    return new DailyTasks(this.host).setTime(hour, 0);
  }
  async start() {
    if (this.running) throw new Error('AutoFishing task is already running');
    this.running = true;
    const result = { completion: 'behaviourTreeTerminal', rounds: [], coOp: false, barDisappearanceCount: 0, inventoryVerified: false, verified: false };
    let failed;
    try {
      check(this.host);
      this.rodNet = await loadRodNet(this.host.sourceRoot); check(this.host);
      await this.host.disableSemiAutoFishing?.(); check(this.host);
      result.coOp = await this.captured(async frame => { check(this.host); const found = await this.find(frame, 'AutoFight', 'P', true); check(this.host); return found.length > 0; });
      const hours = result.coOp || this.config.fishingTimePolicy === 3 ? [null] : this.config.fishingTimePolicy === 1 ? [7] : this.config.fishingTimePolicy === 2 ? [19] : [7, 19];
      for (const hour of hours) {
        if (hour != null) { await this.setTime(hour); check(this.host); }
        const round = this.createRound();
        let roundFailure;
        try {
          while (true) {
            check(this.host);
            if (this.host.isGameActive && !await this.host.isGameActive()) { result.completion = 'gameInactive'; return result; }
            const status = await round.tick();
            if (status !== Running) {
              result.rounds.push({ hour, status, abortReason: round.blackboard.abortReason ?? null, ...round.stats });
              result.barDisappearanceCount += round.stats.barDisappearanceCount; break;
            }
          }
        } catch (error) { roundFailure = error; throw error; }
        finally {
          const original = round.host; round.host = uninterruptible(this.host);
          try {
            try { if (round.root.status === Running) while (await round.handoff() === Running) {} }
            finally { await round.disposeFrame(); }
          } catch (error) { if (!roundFailure) throw error; this.host.log?.('error', 'Fishing handoff failed: ' + error.message); }
          finally { round.host = original; }
        }
      }
      return result;
    } catch (error) { failed = error; throw error; }
    finally {
      try { await uninterruptible(this.host).input('releaseAll', []); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', 'Fishing input release failed: ' + error.message); }
      finally { this.running = false; }
    }
  }
}

export function runAutoFishing(host, options) { return new FishingTask(host, options).start(); }

export class FishingController {
  constructor(host, options = {}) {
    this.host = host; this.options = options; this.config = settings(options); this.enabled = this.config.enabled;
    this.priority = 15; this.exclusive = false; this.lastExecute = -Infinity; this.stopController = new AbortController();
    this.round = new FishingRound(host, this.config, options, true);
  }
  tick(frame, signal) {
    signal?.throwIfAborted();
    if (this.closed || !this.enabled) return Promise.resolve({ exclusive: false, reason: this.closed ? 'closed' : 'disabled', status: Invalid });
    if (this.pending) return Promise.reject(new Error('AutoFishing controller tick is already running'));
    const signals = [this.host.signal, signal, this.stopController.signal].filter(Boolean);
    const tickHost = Object.create(this.host, { signal: { value: AbortSignal.any(signals), writable: true } });
    const run = this.runTick(frame, tickHost);
    const pending = run.finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending; return pending;
  }
  async runTick(frame, tickHost) {
    let owned, failed, previous = this.round.host;
    try {
      check(tickHost);
      const time = now(tickHost);
      if (time - this.lastExecute <= 67) return { exclusive: this.exclusive, reason: 'interval', status: this.round.root.status };
      this.lastExecute = time; this.round.host = tickHost;
      if (!this.exclusive) {
        if (!frame) { frame = await tickHost.capture(); owned = frame; check(tickHost); }
        const ui = await vision(tickHost, 'fishing.ui', { handle: frame.handle, names: ['ExitFishingButton'] });
        this.exclusive = exists(ui.ExitFishingButton);
        return { exclusive: this.exclusive, reason: this.exclusive ? 'enteredFishingUi' : 'outsideFishingUi', status: this.round.root.status };
      }
      const status = await this.round.tick(); this.exclusive = this.round.exclusive;
      if (!this.exclusive) await uninterruptible(tickHost).input('releaseAll', []);
      return { exclusive: this.exclusive, reason: this.exclusive ? 'fishing' : 'leftFishingUi', status, ...this.round.stats, verified: false, inventoryVerified: false };
    } catch (error) {
      failed = error; this.exclusive = false;
      try { await uninterruptible(tickHost).input('releaseAll', []); } catch (releaseError) { this.host.log?.('error', releaseError.message); }
      throw error;
    } finally {
      try { if (owned) await uninterruptible(tickHost).vision('image.dispose', { handle: owned.handle }); await this.round.disposeFrame(); }
      catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); }
      finally { this.round.host = previous; }
    }
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('AutoFishing enabled must be boolean');
    if (!enabled) {
      this.enabled = false; this.stopController.abort(new Error('AutoFishing controller disabled'));
      let failed;
      try { await this.pending; } catch (error) { if (error !== this.stopController.signal.reason) { failed = error; throw error; } }
      finally {
        try { await uninterruptible(this.host).input('releaseAll', []); }
        catch (error) { if (!failed) throw error; this.host.log?.('error', error.message); }
        finally { this.exclusive = false; }
      }
      return;
    }
    if (this.closed) throw new Error('AutoFishing controller is closed');
    if (this.pending) throw new Error('AutoFishing controller tick is already running');
    this.config = settings(this.options); this.stopController = new AbortController(); this.lastExecute = -Infinity; this.exclusive = false;
    this.round = new FishingRound(this.host, this.config, this.options, true); this.enabled = true;
  }
  close() { if (!this.closing) { this.closed = true; this.closing = this.setEnabled(false); } return this.closing; }
}
