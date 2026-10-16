// SPDX-License-Identifier: GPL-3.0-or-later
// BetterGI Core/Script/Dependence/Genshin.cs and AutoPathing/NavigationInstance.cs.
import { NativeTasks, UnsupportedNativeOperation } from './native.mjs';
import { DailyTasks } from './daily.mjs';
import { NavigationTasks, parsePathingTask } from './navigation.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const positive = point => point?.x > 0 && point?.y > 0;
const found = result => result?.found && result.position && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && (result.position.x !== 0 || result.position.y !== 0);
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}
const tpNumber = value => typeof value === 'string' ? (value.trim() && Number.isFinite(Number(value)) ? Number(value) : 0) : finite(value, 'teleport coordinate');

export class GenshinApi {
  constructor(host) {
    this.host = host;
    this.previous = null;
    this.capturedAt = -Infinity;
  }

  async mapTarget(navigation, x, y, mapName, country) {
    finite(x, 'x'); finite(y, 'y');
    const catalog = await navigation.catalog();
    if (!catalog.scenes.has(mapName)) throw new TypeError(`Unknown BetterGI map: ${mapName}`);
    const target = { x, y, mapName, country };
    await navigation.openMap(mapName, { retries: 1 });
    await navigation.switchTargetArea(target);
    return target;
  }

  async position(navigation, mapName = 'Teyvat', matchingMethod = 'TemplateMatch', cacheTimeMs = 900, hint) {
    if (!Number.isInteger(cacheTimeMs)) throw new TypeError('cacheTimeMs must be an integer');
    const geometry = await navigation.geometry(mapName);
    if (!geometry) throw new TypeError(`Unknown BetterGI map: ${mapName}`);
    return navigation.captured(async frame => {
      if (!await navigation.isInMainUi(frame)) throw new Error('不在主界面，无法识别小地图坐标');
      const at = Date.now();
      if (!hint && at - this.capturedAt < cacheTimeMs && positive(this.previous)) return geometry.imageToGame(this.previous);
      if (hint) this.previous = geometry.gameToImage({ x: Math.fround(hint.x), y: Math.fround(hint.y) });
      const recognize = (previous, stable) => navigation.host.vision('map.locateMinimap', { handle: frame.handle, mapName, matchingMethod, ...(previous ? { previous } : {}), ...(stable ? { rank: 0 } : {}) });
      let result = await recognize(this.previous, !hint);
      if (!hint && (!found(result) || (positive(this.previous) && distance(this.previous, result.position) > 150))) {
        this.previous = null;
        result = await recognize(null, false);
      }
      if (!found(result)) return null;
      if (at > this.capturedAt) { this.previous = result.position; this.capturedAt = at; }
      return result.genshin ?? geometry.imageToGame(result.position);
    });
  }

  async statue(navigation, signal) {
    const config = { x: 2296.4, y: -824.4, nearest: false, shouldMove: false, hpRestoreDuration: 5, ...this.host.statueConfig };
    finite(config.x, 'statue x'); finite(config.y, 'statue y');
    if (!Number.isFinite(config.hpRestoreDuration) || config.hpRestoreDuration < 1 || config.hpRestoreDuration > 30) throw new RangeError('hpRestoreDuration must be between 1 and 30 seconds');
    await navigation.openMap();
    const statues = (await navigation.catalog()).scenes.get('Teyvat').points.filter(point => point.type === 'Goddess');
    const nearest = point => [...statues].sort((a, b) => distance(a, point) - distance(b, point))[0];
    let { x, y } = config;
    let target = config.point ?? nearest({ x, y });
    if (config.nearest) { target = nearest(await navigation.locateBigMapCenter('Teyvat')); x = target?.x; y = target?.y; }
    if (!target) throw new Error('没找到最近的七天神像');
    const teleport = await navigation.teleport(x, y);
    if (config.shouldMove || config.nearest) {
      const dx = x - target.tranX, dy = y - target.tranY, length = Math.hypot(dx, dy);
      const point = length < 5 ? { x: target.tranX, y: target.tranY } : { x: x - dx * 5 / length, y: y - dy * 5 / length };
      const task = parsePathingTask({ positions: [{ ...point, type: 'path', move_mode: 'walk' }] }, { geometry: await navigation.geometry('Teyvat') });
      await navigation.moveTo(task.positions[0]);
      await this.host.input('keyPress', ['X'], true, signal);
    }
    await this.host.sleep(config.hpRestoreDuration * 1000, signal);
    return { teleport, recoveryWaitMs: config.hpRestoreDuration * 1000 };
  }

  async call(method, args = [], signal = this.host.signal) {
    signal?.throwIfAborted();
    method = String(method).toLowerCase();
    const scoped = signal === this.host.signal;
    const taskHost = scoped ? this.host.taskHost : this.host.scopedTaskHost(signal);
    const navigation = scoped ? this.host.navigation : new NavigationTasks(taskHost, this.host.navigation.options);
    const native = scoped ? this.host.native : new NativeTasks(taskHost);
    const daily = scoped ? this.host.daily : new DailyTasks(taskHost);
    switch (method) {
      case 'tp': {
        const [x, y, mapOrForce, force = false] = args;
        return navigation.teleport(tpNumber(x), tpNumber(y), { mapName: typeof mapOrForce === 'string' ? mapOrForce : 'Teyvat', force: typeof mapOrForce === 'boolean' ? mapOrForce : force });
      }
      case 'movemapto':
      case 'clickmappoint':
      case 'moveindependentmapto': {
        const independent = method === 'moveindependentmapto';
        const target = await this.mapTarget(navigation, args[0], args[1], independent ? args[2] : 'Teyvat', independent ? args[3] : args[2]);
        const result = await navigation.moveMapToCore(target, { finalZoom: 2, allowZoom: true });
        if (method === 'clickmappoint') {
          const view = await navigation.evaluateView(target);
          if (!view.safe) throw new Error('目标点未移动到可点击区域');
          await this.host.input('click', [view.point.x, view.point.y], true, signal);
        }
        return result;
      }
      case 'getbigmapzoomlevel': return navigation.bigMapZoom();
      case 'setbigmapzoomlevel': return navigation.adjustMapZoom(args[0]);
      case 'tptostatueoftheseven': return this.statue(navigation, signal);
      case 'getpositionfrombigmap': {
        try { return await navigation.locateBigMapCenter(args[0] ?? 'Teyvat'); }
        catch (error) { if (error.code !== 'MAP_POSITION_NOT_RECOGNIZED') throw error; return null; }
      }
      case 'getpositionfrommap': return args.length === 3
        ? this.position(navigation, args[0], navigation.options.mapMatchingMethod ?? 'TemplateMatch', 0, { x: finite(args[1], 'x'), y: finite(args[2], 'y') })
        : this.position(navigation, args[0] ?? 'Teyvat', navigation.options.mapMatchingMethod ?? 'TemplateMatch', args[1] ?? 900);
      case 'getpositionfrommapwithmatchingmethod': return args.length === 1
        ? this.position(navigation, 'Teyvat', args[0])
        : this.position(navigation, args[0], args[1], args[2] ?? 900);
      case 'getcameraorientation': return navigation.captured(async frame => {
        const result = await taskHost.vision('map.cameraOrientation', { handle: frame.handle });
        if (!result.valid || !Number.isFinite(result.angle)) throw new Error('Original camera orientation is not observable');
        return result.angle;
      });
      case 'returnmainui': return native.returnMainUi();
      case 'blessingofthewelkinmoon': return daily.blessingOfTheWelkinMoon();
      case 'choosetalkoption': return daily.chooseTalkOption(...args);
      case 'claimbattlepassrewards': return daily.claimBattlePassRewards();
      case 'claimencounterpointsrewards': return daily.claimEncounterPointsRewards();
      case 'settime': return daily.setTime(...args);
      case 'uid': {
        try {
          return await native.captured(async frame => {
            const scale = frame.width / 1920;
            const result = await taskHost.vision('image.find', { handle: frame.handle, recognition: { recognitionType: 'Ocr', roi: [1683, 1051, 234, 28].map(value => Math.round(value * scale)) } });
            const value = Number((result?.text?.match(/\d+/g) ?? []).join(''));
            return Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : 0;
          });
        } catch (error) { signal?.throwIfAborted(); this.host.log('error', `OCR 识别 UID 异常: ${error.message}`); return 0; }
      }
      case 'switchparty': return this.host.combatAdapter('switchParty', { name: args[0] }, signal);
      case 'switchcharacter': return this.host.combatAdapter('switchCharacter', { slots: Array.from({ length: 4 }, (_, index) => args[index] ?? ''), usePhysicalSlots: args[4] ?? true }, signal);
      case 'clearpartycache': return this.host.combatAdapter('clearPartyCache', {}, signal);
      case 'autofishing': return this.host.runTask('autoFishing', { config: { FishingTimePolicy: args[0] ?? 0 } }, signal);
      default: throw new UnsupportedNativeOperation(`genshin.${method}`);
    }
  }
}
