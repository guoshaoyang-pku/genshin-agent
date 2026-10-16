// 探测 ops：页面信息、截图、OCR、图像差异。模型驱动时先用这些了解当前画面。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imgDiff, ocr, out, pageInfo, shot, withPage } from "../lib/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

async function info(page) {
  return out(true, await pageInfo(page));
}

async function screenshot(page, args) {
  const s = await shot(page, args.name || `probe-${Date.now()}`, { dir: path.join(ROOT, "data/shots") });
  return out(true, s);
}

async function ocrProbe(page, args) {
  const s = await shot(page, `ocr-${Date.now()}`);
  const items = await ocr(s.path, args.minScore ?? 0.5);
  return out(true, { screenshot: s.path, items: items.slice(0, args.limit || 30) });
}

// diff: 连拍两张（间隔 interval ms）或与指定旧图对比，判断画面是否变化。
async function diff(page, args) {
  const interval = args.interval ?? 800;
  const a = await shot(page, `diff-a-${Date.now()}`);
  await page.waitForTimeout(interval);
  const b = await shot(page, `diff-b-${Date.now()}`);
  const crop = args.crop ? String(args.crop).split(",").map(Number) : [];
  const r = await imgDiff(a.path, b.path, ...(crop.length === 4 ? crop : []));
  return out(true, { a: a.path, b: b.path, ...r });
}

export const ops = {
  info: (page) => info(page),
  shot: (page, a) => screenshot(page, a),
  ocr: (page, a) => ocrProbe(page, a),
  diff: (page, a) => diff(page, a),
};

export async function run(name, args) {
  await withPage(async (page) => {
    const fn = ops[name];
    if (!fn) throw new Error(`probe 无此操作: ${name}`);
    await fn(page, args || {});
  });
}
