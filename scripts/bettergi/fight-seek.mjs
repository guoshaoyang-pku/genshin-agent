// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI AutoFightSeek.cs: enemy search and MoveForwardTask.
import { NativeTasks } from './native.mjs';

const factors = [100, 90, 80, 70, 60, 45, 30, 15, 6, 1, -10, -50, -60];
const check = host => host.signal?.throwIfAborted();
async function sleep(host, ms) { check(host); await host.sleep(ms); check(host); }
async function input(host, method, args = []) { check(host); return host.input(method, args); }

export function enemyMovement({ x, y, height }) {
  if (x < 580 || x > 1315 || y > 800) {
    if (x < 500 && y < 800) return height <= 6 ? ['W', 'A'] : [];
    if (x > 1315 && y < 800) return height <= 6 ? ['W', 'D'] : [];
    if (x < 500 && y > 800) return height <= 6 ? ['S', 'A'] : [];
    if (x > 1315 && y > 800) return height <= 6 ? ['S', 'D'] : [];
    if (y < 800) return height <= 6 ? ['W'] : [];
    if (y > 800) return height <= 6 ? ['S'] : [];
    return (x < 920 || x > 920) && height > 6 ? 'tapS' : [];
  }
  if (height > 6) return 'tapS';
  if (x < 1315 && x > 500 && y < 800 && height > 2) return ['W'];
  if (x < 1315 && x > 500 && y > 800 && height > 2) return ['S'];
  return 'tapS';
}

export class FightSeek extends NativeTasks {
  constructor(host, state = {}) {
    super(host); this.state = state;
    state.rotationCount ??= 0; state.seekMovements ??= new Set();
  }
  async components(mode = 'seek') {
    return this.captured(async frame => {
      const found = await this.host.vision('fight.seekComponents', { handle: frame.handle, mode });
      return { width: frame.width, height: frame.height, ...(Array.isArray(found) ? { components: found } : found) };
    });
  }
  async held(keys, ms, host = this.host) {
    const down = [];
    try {
      for (const key of keys) { await input(host, 'keyDown', [key]); down.push(key); }
      await sleep(host, ms);
    } finally { for (const key of down) await host.input('keyUp', [key]); }
  }
  moveForward() {
    const controller = new AbortController();
    const host = Object.assign(Object.create(this.host), { signal: this.host.signal ? AbortSignal.any([this.host.signal, controller.signal]) : controller.signal });
    const task = { controller };
    this.state.seekMovements.add(task);
    task.promise = (async () => {
      const seeker = new FightSeek(host, this.state);
      const found = await seeker.components('move'), component = found.components[0];
      if (!component) return;
      const keys = enemyMovement(component);
      if (keys === 'tapS') await input(host, 'keyPress', ['S']);
      else if (keys.length) await seeker.held(keys, 1000);
    })().catch(error => {
      if (!host.signal.aborted) this.host.log?.('warn', '寻敌移动失败: ' + error.message);
    }).finally(() => this.state.seekMovements.delete(task));
    return task;
  }
  async stopMovements() {
    const tasks = [...this.state.seekMovements];
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map(task => task.promise));
  }
  async partyLoading() {
    return this.captured(async frame => {
      const yellow = await this.host.vision('image.mat', { handle: frame.handle, method: 'At', args: [50, 790] });
      const white = await this.host.vision('image.mat', { handle: frame.handle, method: 'At', args: [50, 768] });
      return yellow[2] >= 200 && yellow[1] >= 200 && yellow[0] <= 100 && white.every(channel => channel >= 240);
    });
  }
  async visible(component, { isEndCheck, second = false }) {
    if (!component) return undefined;
    if (isEndCheck) await this.held(['W'], 100);
    else if (!second) { await input(this.host, 'keyPress', ['W']); await input(this.host, 'keyPress', ['W']); }
    if (component.height > 2 && component.height < 7) { this.moveForward(); return false; }
    if (component.height > 6 && component.height < 25) {
      if (!second && [758, 722].includes(component.x) && [7, 8].includes(component.height)) {
        await input(this.host, 'moveMouseBy', [960, 0]); await sleep(this.host, 200); await input(this.host, 'middleButtonClick');
      }
      return false;
    }
    if (component.height < 3 || component.height > 25) return null;
    return undefined;
  }
  async seek({ detectDelayTime = 450, delayTime = 1500, isEndCheck = false, rotaryFactor = 6 } = {}) {
    if (!Number.isInteger(rotaryFactor) || rotaryFactor < 1 || rotaryFactor > 13) throw new RangeError('旋转因子必须为1到13');
    const adjustedX = factors[rotaryFactor - 1], divisor = rotaryFactor <= 12 ? 2 : 1.3;
    for (let retry = isEndCheck ? 1 : 0; retry < 25 + Math.trunc(adjustedX / 5); retry++) {
      check(this.host);
      const initial = await this.components();
      const result = await this.visible(initial.components[0], { isEndCheck });
      if (result !== undefined) return result;
      if (retry === 0) {
        await sleep(this.host, delayTime); await input(this.host, 'keyPress', ['L']);
        await sleep(this.host, detectDelayTime);
        const ended = await this.partyLoading();
        await input(this.host, 'keyPress', ['X']);
        if (ended) { await input(this.host, 'keyPress', ['L']); return true; }
      }
      if (this.state.rotationCount === 3 && retry === 0) { await input(this.host, 'middleButtonClick'); await sleep(this.host, 500); }
      const dy = retry > 2 ? 0 : this.state.rotationCount < 2 ? Math.trunc(initial.height / 7) : this.state.rotationCount === 2 ? 0 : Math.trunc(-initial.height / 5);
      await input(this.host, 'moveMouseBy', [Math.trunc(initial.width / 6), dy]);
      await sleep(this.host, 50 + Math.trunc(adjustedX / divisor));
      const second = await this.components();
      const after = await this.visible(second.components[0], { isEndCheck, second: true });
      if (after !== undefined) return after;
    }
    return null;
  }
}
