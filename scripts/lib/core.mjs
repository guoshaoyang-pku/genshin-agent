#!/usr/bin/env node
// harness 核心库：CDP 连接、页面选择、截图、点击、按键、OCR、模板匹配、等待。
// 坐标空间 = 浏览器视口(截图) = 点击空间。默认 1920x1080（dpr=1），
// 以 S2 实测云原神 canvas 分辨率为准，确认后改这里。
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
export const VIEWPORT = [1920, 1080];

export function now() {
  return new Date().toISOString();
}

// ---------- CDP 连接 ----------
export async function connect(cdpUrl = "http://127.0.0.1:9222") {
  return chromium.connectOverCDP(cdpUrl);
}

export function pickPage(ctx) {
  const real = ctx
    .pages()
    .filter((p) => p.url() && p.url() !== "about:blank" && !p.isClosed());
  // 优先选云原神页面
  const ys = real.filter((p) => p.url().includes("ys.mihoyo.com"));
  if (ys.length) return ys[ys.length - 1];
  return (real.length ? real[real.length - 1] : ctx.pages()[0]) || null;
}

export async function withPage(fn, opts = {}) {
  const browser = await connect(opts.cdpUrl);
  try {
    const ctx = browser.contexts()[0];
    const page = pickPage(ctx);
    if (!page) throw new Error("没有可用页面（CDP 连接正常但没有游戏页面）");
    return await fn(page, ctx);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 页面信息 ----------
export async function pageInfo(page) {
  const url = page.url();
  const viewport = page.viewportSize();
  const dom = await page.evaluate(() => {
    const cvs = [...document.querySelectorAll("canvas")].map((c) => ({
      w: c.width, h: c.height,
      cssW: Math.round(c.getBoundingClientRect().width),
      cssH: Math.round(c.getBoundingClientRect().height),
      id: c.id || null, cls: c.className || null,
    }));
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, paused: v.paused,
    }));
    return {
      title: document.title,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      canvases: cvs, videos,
      pointerLockElement: document.pointerLockElement
        ? (document.pointerLockElement.id || document.pointerLockElement.tagName)
        : null,
    };
  });
  return { url, viewport, ...dom };
}

// ---------- 截图 ----------
export async function shot(page, name = "latest", { dir = path.join(ROOT, "data/shots"), quality = 70 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.jpg`);
  const buf = await page.screenshot({ type: "jpeg", quality });
  fs.writeFileSync(out, buf);
  return { path: out, bytes: buf.length, url: page.url() };
}

// ---------- 鼠标 ----------
export async function click(page, x, y, { waitAfter = 0, holdMs = 60 } = {}) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
  if (waitAfter > 0) await page.waitForTimeout(waitAfter);
  return { x, y };
}

export async function blankClick(page, { x = 150, y = 500 } = {}) {
  return click(page, x, y, { waitAfter: 600 });
}

// ---------- 键盘 ----------
// key 用 Playwright 键名（"f"、"e"、"m"、"Escape"、"Shift" 等）。
export async function press(page, key, { waitAfter = 0, delay = 60 } = {}) {
  await page.keyboard.press(key);
  if (delay > 0) await page.waitForTimeout(delay);
  if (waitAfter > 0) await page.waitForTimeout(waitAfter);
  return { key };
}

export async function tap(page, key, times = 1, { interval = 400 } = {}) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    if (i < times - 1) await page.waitForTimeout(interval);
  }
  return { key, times };
}

export async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  return { key, ms };
}

export async function typeText(page, text, { delay = 20 } = {}) {
  await page.keyboard.type(text, { delay });
  return { text };
}

// ---------- OCR ----------
export function ocr(imagePath, minScore = 0.5) {
  const py = path.join(ROOT, "venv/bin/python");
  return new Promise((resolve, reject) => {
    execFile(py, [path.join(ROOT, "scripts/ocr.py"), imagePath, String(minScore)],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`OCR 失败: ${stderr || err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`OCR 输出解析失败: ${stdout.slice(0, 200)}`)); }
      });
  });
}

export async function ocrFind(page, keywords, { crop = null, minScore = 0.5 } = {}) {
  const s = await shot(page, "ocr-probe");
  const items = crop
    ? (await ocr(s.path, minScore)).filter((it) => inCrop(it, crop))
    : await ocr(s.path, minScore);
  const kw = Array.isArray(keywords) ? keywords : [keywords];
  const hit = items.find((it) => kw.some((k) => it.text.includes(k)));
  return hit ? { ...hit, center: [(hit.x1 + hit.x2) / 2, (hit.y1 + hit.y2) / 2] } : null;
}

function inCrop(item, crop) {
  const [x1, y1, x2, y2] = crop;
  return item.x1 >= x1 && item.x2 <= x2 && item.y1 >= y1 && item.y2 <= y2;
}

// ---------- 模板匹配（OpenCV，venv） ----------
// template: 相对于 assets/templates/ 的 png 路径；crop: [x1,y1,x2,y2] 视口像素（可选）。
export function templateMatch(imagePath, template, { crop = null, threshold = 0.85 } = {}) {
  const py = path.join(ROOT, "venv/bin/python");
  const args = [path.join(ROOT, "scripts/template-match.py"), imagePath, template, String(threshold)];
  if (crop) args.push(...crop.map(String));
  return new Promise((resolve, reject) => {
    execFile(py, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`模板匹配失败: ${stderr || err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`模板匹配输出解析失败: ${stdout.slice(0, 200)}`)); }
      });
  });
}

export async function findOnScreen(page, template, { crop = null, threshold = 0.85 } = {}) {
  const s = await shot(page, "tmpl-probe");
  return templateMatch(s.path, path.join(ROOT, "assets/templates", template), { crop, threshold });
}

// ---------- 图像差异（检测画面变化） ----------
export function imgDiff(pathA, pathB) {
  const py = path.join(ROOT, "venv/bin/python");
  return new Promise((resolve, reject) => {
    execFile(py, [path.join(ROOT, "scripts/img-diff.py"), pathA, pathB],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`图像对比失败: ${stderr || err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`图像对比输出解析失败: ${stdout.slice(0, 200)}`)); }
      });
  });
}

// ---------- 等待 ----------
export async function waitFor(fn, { timeout = 15000, interval = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ---------- 结果输出 ----------
export function out(ok, data = {}, note = "") {
  console.log(JSON.stringify({ ok, ...data, note }));
  return { ok, ...data, note };
}
