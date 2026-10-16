import path from 'node:path';

// BetterGI Common/Job/{ScanPickTask,LinneaMiningTask}.cs, c9db8b8291fe4ac25a600aee1582298005919eb2, GPL-3.0.
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const area = rect => rect.width * rect.height;
const distance2 = (left, right) => (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
function bounds(detection) {
  const rect = detection.bounds;
  if (!rect || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(rect[key]))) throw new TypeError('YOLO detection has invalid bounds');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.trunc(rect[key])]));
}
function detectionName(detection) { return typeof detection.name === 'string' ? detection.name : detection.name?.name; }
function sourceInt(value) {
  const text = String(value).trim(), number = Number(text);
  return /^[+-]?\d+$/.test(text) && Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null;
}

export function parseLinneaParams(value) {
  let mineCount = -1, scanRounds = -1;
  const clamp = number => Math.max(1, Math.min(999, number));
  for (const part of (value ?? '').split(',')) {
    const text = part.trim(), named = /^(mines|rounds)=(.*)$/i.exec(text);
    const number = sourceInt(named ? named[2] : text);
    if (number === null) continue;
    if (named?.[1].toLowerCase() === 'mines') mineCount = clamp(number);
    else if (named?.[1].toLowerCase() === 'rounds') scanRounds = clamp(number);
    else if (mineCount === -1) mineCount = clamp(number);
    else if (scanRounds === -1) scanRounds = clamp(number);
  }
  if (mineCount === -1) mineCount = 1;
  if (scanRounds === -1) scanRounds = 1;
  return { mineCount, scanRounds: Math.max(mineCount, scanRounds) };
}

function recalculate(cluster, preferRight) {
  cluster.center = { x: cluster.rects.reduce((sum, rect) => sum + center(rect).x, 0) / cluster.rects.length,
    y: cluster.rects.reduce((sum, rect) => sum + center(rect).y, 0) / cluster.rects.length };
  const sorted = cluster.rects.map(rect => ({ rect, center: center(rect) })).sort((a, b) => distance2(a.center, cluster.center) - distance2(b.center, cluster.center));
  cluster.target = (preferRight && sorted.length >= 2 ? sorted.slice(0, 2).sort((a, b) => b.center.x - a.center.x) : sorted)[0].rect;
}

export function clusterMinerals(rects, { widthScale = 1, preferRight = true } = {}) {
  if (!(widthScale > 0)) throw new RangeError('widthScale must be positive');
  const clusters = [], referenceArea = Math.max(1, 1800 * widthScale * widthScale);
  for (const rect of rects) {
    const point = center(rect);
    let nearest = null, nearestDistance = Infinity;
    for (const cluster of clusters) {
      const distance = Math.sqrt(distance2(point, cluster.center));
      if (distance < nearestDistance) { nearest = cluster; nearestDistance = distance; }
    }
    if (nearest) {
      const averageArea = nearest.rects.reduce((sum, box) => sum + area(box), 0) / nearest.rects.length, newArea = area(rect);
      const combinedAverage = (averageArea * nearest.rects.length + newArea) / (nearest.rects.length + 1);
      const threshold = 400 * widthScale * Math.sqrt(combinedAverage / referenceArea);
      if (nearestDistance < threshold && newArea <= averageArea * 4 && newArea >= averageArea / 4) {
        nearest.rects.push(rect); recalculate(nearest, preferRight); continue;
      }
    }
    const cluster = { rects: [rect] }; recalculate(cluster, preferRight); clusters.push(cluster);
  }
  return clusters;
}

export function nearestMineralCluster(detections, { width, height, preferRight = false }) {
  const widthScale = width / 1920, edge = 200 * widthScale;
  const rects = detections.filter(box => detectionName(box) === 'ore' && box.confidence >= Math.fround(0.70)).map(bounds);
  const clusters = clusterMinerals(rects, { widthScale, preferRight });
  const central = clusters.filter(cluster => cluster.center.x >= edge && cluster.center.x <= width - edge && cluster.center.y >= edge && cluster.center.y <= height - edge);
  const candidates = central.length ? central : clusters, screenCenter = { x: width / 2, y: height / 2 };
  return { cluster: candidates.sort((a, b) => distance2(a.center, screenCenter) - distance2(b.center, screenCenter))[0] ?? null, center: screenCenter };
}

class ModelJob {
  constructor(actions) { this.actions = actions; }
  async create(model) {
    this.actions.checkAbort();
    const result = await this.actions.host.vision('yolo.create', { path: path.join(this.actions.modelRoot, model, model === 'World' ? 'bgi_world.onnx' : 'bgi_mine.onnx'), requireDetection: true });
    if (!result?.predictor) throw new Error('YOLO adapter did not create a predictor');
    return result.predictor;
  }
  async detect(predictor, body) {
    return this.actions.captured(async frame => body(await this.actions.host.vision('yolo.predict', { predictor, handle: frame.handle }), frame));
  }
  async dispose(predictor) { await this.actions.host.vision('yolo.dispose', { predictor }); }
}

export class ScanPickJob extends ModelJob {
  async resetCamera() {
    await this.actions.input('middleButtonClick'); await this.actions.sleep(500);
    await this.actions.input('moveMouseBy', [0, Math.trunc(500 * this.actions.dpi)]); await this.actions.sleep(100);
  }
  async items(predictor) {
    return this.detect(predictor, detections => {
      // BgiYoloPredictor.Detect groups detections by first-seen class before flattening.
      const groups = new Map();
      for (const detection of detections) {
        const name = detectionName(detection);
        if (!['drops', 'ore'].includes(name)) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(bounds(detection));
      }
      return [...groups.values()].flat();
    });
  }
  async towards(rect) {
    const a = this.actions, point = center(rect), bottom = rect.y + rect.height;
    if (point.x < 880) { await a.input('keyUp', ['VK_D']); await a.input('keyDown', ['VK_A']); }
    else if (point.x > 1040) { await a.input('keyUp', ['VK_A']); await a.input('keyDown', ['VK_D']); }
    else { await a.input('keyUp', ['VK_A']); await a.input('keyUp', ['VK_D']); }
    if (bottom < 770) { await a.input('keyUp', ['VK_S']); await a.input('keyDown', ['VK_W']); }
    else if (bottom > 900) { await a.input('keyUp', ['VK_W']); await a.input('keyDown', ['VK_S']); }
    else { await a.input('keyUp', ['VK_W']); await a.input('keyUp', ['VK_S']); }
  }
  async run(seconds = 15) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Scan duration must be nonnegative seconds');
    const a = this.actions;
    return a.released(async () => {
      const predictor = await this.create('World'), start = a.now();
      let targets = 0, scans = 0;
      try {
        await a.input('keyPress', ['VK_X']); await this.resetCamera();
        while (a.now() - start < seconds * 1000) {
          a.checkAbort(); let items = await this.items(predictor); scans++;
          if (!items.length) {
            await a.input('releaseAll'); await this.resetCamera();
            for (let i = 0; i < 10 && a.now() - start < seconds * 1000; i++) {
              await a.input('moveMouseBy', [400, 0]);
              if (i > 5) await a.held('keyDown', ['VK_W'], 100, 'keyUp');
              await a.input('keyPress', ['VK_X']); await a.sleep(300);
              items = await this.items(predictor); scans++; if (items.length) break;
            }
          }
          if (!items.length) continue;
          items.sort((left, right) => ((left.x - 960) ** 2 + 14 * (left.y + left.height - 888.88) ** 2)
            - ((right.x - 960) ** 2 + 14 * (right.y + right.height - 888.88) ** 2));
          await this.towards(items[0]); targets++; await a.sleep(200); await a.input('keyPress', ['VK_X']);
        }
        await a.input('releaseAll'); await a.input('keyPress', ['VK_X']);
        return { scans, targets, elapsedMs: a.now() - start, outcomeVerified: false };
      } finally { await this.dispose(predictor); }
    });
  }
}

export class LinneaMiningJob extends ModelJob {
  async nearest(predictor, preferRight) {
    return this.detect(predictor, (detections, frame) => ({ ...nearestMineralCluster(detections, { width: frame.width, height: frame.height, preferRight }), width: frame.width, height: frame.height }));
  }
  async sight() {
    await this.actions.input('middleButtonDown'); await this.actions.sleep(1500); this.lastRefresh = this.actions.now();
  }
  async align(predictor, observed, preferRight) {
    const a = this.actions, widthScale = this.widthScale, heightScale = this.heightScale;
    let dx = 0, dy = 0;
    for (let retry = 0; retry < 7; retry++) {
      if (a.now() - this.lastRefresh >= 3000) { await a.input('middleButtonUp'); await a.sleep(100); await this.sight(); }
      const rect = observed.cluster.target, point = center(rect), offsetX = point.x - observed.center.x, offsetY = point.y - observed.center.y;
      const aligned = Math.abs(offsetX) <= (rect.width + 6 * widthScale) / 2 && Math.abs(offsetY) <= (rect.height + 6 * widthScale) / 2;
      if (aligned || retry === 6) {
        await a.input('middleButtonUp'); await a.sleep(300);
        if (dy < 0) { await a.input('moveMouseBy', [0, -25]); await a.sleep(10); }
        await a.input('leftButtonClick'); await a.sleep(2000);
        return { fired: true, aligned, dx: 0, dy: 0 };
      }
      const moveX = Math.trunc(offsetX * a.dpi * 0.45 / widthScale), moveY = Math.trunc(offsetY * a.dpi * 0.8 / heightScale);
      await a.input('moveMouseBy', [moveX, moveY]); dx += moveX; dy += moveY; await a.sleep(150);
      observed = await this.nearest(predictor, preferRight);
      if (!observed.cluster) return { fired: false, aligned: false, dx, dy };
    }
    return { fired: false, aligned: false, dx, dy };
  }
  async run({ mineCount = 1, scanRounds = 1 } = {}) {
    if (![mineCount, scanRounds].every(value => Number.isInteger(value) && value >= 1 && value <= 999)) throw new RangeError('Mining counts must be 1..999');
    const a = this.actions;
    return a.released(async () => {
      const predictor = await this.create('Mine'); let aiming = false, shots = 0, alignedShots = 0, rounds = 0;
      try {
        await a.captured(frame => { this.widthScale = frame.width / 1920; this.heightScale = frame.height / 1080; });
        await a.input('keyPress', ['VK_R']); aiming = true; await a.sleep(400);
        for (let round = 0; round < scanRounds; round++) {
          a.checkAbort(); rounds++; await this.sight();
          const observed = await this.nearest(predictor, scanRounds > 1);
          if (observed.cluster) {
            const result = await this.align(predictor, observed, scanRounds > 1);
            if (result.fired) {
              shots++; if (result.aligned) alignedShots++;
              if (alignedShots >= mineCount) break;
              continue;
            }
            await a.input('middleButtonUp'); await a.sleep(300);
            if (result.dx || result.dy) {
              await this.sight(); await a.input('moveMouseBy', [-result.dx, -result.dy]); await a.sleep(800);
              await a.input('middleButtonUp'); await a.sleep(300);
            }
            if (round < scanRounds - 1) { await a.input('moveMouseBy', [Math.trunc(-250 * a.dpi * this.widthScale), 0]); await a.sleep(800); }
            continue;
          }
          await a.input('middleButtonUp'); await a.sleep(300);
          if (round < scanRounds - 1) await a.input('moveMouseBy', [Math.trunc(-250 * a.dpi * this.widthScale), 0]);
          await a.sleep(800);
        }
        await a.input('keyPress', ['VK_R']); aiming = false;
        return { shots, alignedShots, rounds, mineCount, scanRounds, quotaReached: alignedShots >= mineCount, outcomeVerified: false };
      } finally {
        try { if (aiming) await a.host.input('keyPress', ['VK_R']); }
        finally { try { await a.host.input('middleButtonUp', []); } finally { await this.dispose(predictor); } }
      }
    });
  }
}
