// 探索 ops（M0 验证原语）：行走、视角转动（CDP 路径 / JS 路径）、解除指针锁。
// 每个操作都返回前后截图 diff，用于判定输入是否真的生效。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hold, imgDiff, out, shot, withPage } from "../lib/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

async function shootPair(page, fn, { settle = 500 } = {}) {
  const a = await shot(page, `io-a-${Date.now()}`);
  await fn();
  await page.waitForTimeout(settle);
  const b = await shot(page, `io-b-${Date.now()}`);
  const d = await imgDiff(a.path, b.path);
  return { a: a.path, b: b.path, ...d };
}

// walk: 按住 key（默认 w）ms 毫秒，返回画面差异。
async function walk(page, args) {
  const r = await shootPair(page, () => hold(page, args.key || "w", args.ms ?? 2000));
  return out(!r.same, r, r.same ? "画面无变化，键盘输入可能未生效" : "画面有变化");
}

// look（CDP 路径）: 先点画面中心触发游戏 Pointer Lock，再用 mouse.move 增量转视角。
// dx/dy 为总位移（像素），分 steps 步走完。
async function look(page, args) {
  const dx = args.dx ?? 400, dy = args.dy ?? 0, steps = args.steps ?? 10;
  const [vw, vh] = [1920, 1080];
  const r = await shootPair(page, async () => {
    // 点击中心：合成点击通常算 user gesture，游戏客户端会据此 requestPointerLock
    await page.mouse.move(vw / 2, vh / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const locked = await page.evaluate(() => !!document.pointerLockElement);
    let cx = vw / 2, cy = vh / 2;
    for (let i = 0; i < steps; i++) {
      cx += dx / steps;
      cy += dy / steps;
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(50);
    }
    return { locked };
  });
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  return out(!r.same, { ...r, pointerLock: locked },
    r.same ? "画面无变化，CDP 视角路径可能未生效" : "画面有变化");
}

// lookJs（JS 路径）: 页面内手动 requestPointerLock，再合成带 movementX/Y 的 mousemove。
async function lookJs(page, args) {
  const dx = args.dx ?? 400, dy = args.dy ?? 0, steps = args.steps ?? 10;
  const r = await shootPair(page, async () => {
    return page.evaluate(async ({ dx, dy, steps }) => {
      const el = document.querySelector("canvas") || document.body;
      try {
        await el.requestPointerLock();
      } catch (e) {
        return { lockError: String(e) };
      }
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      for (let i = 0; i < steps; i++) {
        el.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy,
          movementX: dx / steps, movementY: dy / steps,
        }));
        await new Promise((r2) => setTimeout(r2, 50));
      }
      return { locked: !!document.pointerLockElement };
    }, { dx, dy, steps });
  });
  return out(!r.same, r, r.same ? "画面无变化，JS 视角路径可能未生效" : "画面有变化");
}

// unlock: 退出指针锁（Esc + document.exitPointerLock 双保险）。
async function unlock(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.evaluate(() => document.exitPointerLock && document.exitPointerLock());
  return out(true, { unlocked: true });
}

export const ops = {
  walk: (page, a) => walk(page, a),
  look: (page, a) => look(page, a),
  lookJs: (page, a) => lookJs(page, a),
  unlock: (page) => unlock(page),
};

export async function run(name, args) {
  if ((name === "walk" || name === "look") && args?.backend !== "cdp") {
    const bettergi = await import("./bettergi.mjs");
    return bettergi.run(name, args || {});
  }
  await withPage(async (page) => {
    const fn = ops[name];
    if (!fn) throw new Error(`explore 无此操作: ${name}`);
    await fn(page, args || {});
  });
}
