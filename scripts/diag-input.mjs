// 输入诊断：定位「键盘/视角不生效」发生在哪一层。
// 1) 注入事件监听（keydown/mousedown/mousemove/pointerlockchange/pointerlockerror）
// 2) CDP 合成点击画面中心，观察 pointer lock 相关事件
// 3) 主动 requestPointerLock() 试探错因
// 4) CDP 按住 w 2s，统计页面收到的 keydown 次数（判断事件是否到达页面）
import { out, withPage } from "./lib/core.mjs";

await withPage(async (page) => {
  // 注入监听
  await page.evaluate(() => {
    window.__diag = { keydown: 0, mousedown: 0, mousemove: 0, plchange: 0, plerror: [], keys: [] };
    window.addEventListener("keydown", (e) => {
      window.__diag.keydown++;
      if (window.__diag.keys.length < 10) window.__diag.keys.push(e.key || e.code);
    }, true);
    window.addEventListener("mousedown", () => window.__diag.mousedown++, true);
    window.addEventListener("mousemove", () => window.__diag.mousemove++, true);
    document.addEventListener("pointerlockchange", () => window.__diag.plchange++);
    document.addEventListener("pointerlockerror", (e) => window.__diag.plerror.push(String(e.type)));
  });

  const before = await page.evaluate(() => ({
    hasFocus: document.hasFocus(),
    activeElement: document.activeElement && document.activeElement.tagName,
    visibility: document.visibilityState,
  }));

  // CDP 合成点击中心（视频是 1920x1080，窗口约 2056x1150，取窗口中心即可）
  const { innerWidth: w, innerHeight: h } = await page.evaluate(() => ({
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  }));
  await page.mouse.move(w / 2, h / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);

  const afterClick = await page.evaluate(() => ({
    ...window.__diag,
    pointerLockElement: document.pointerLockElement
      ? document.pointerLockElement.tagName : null,
    hasFocus: document.hasFocus(),
  }));

  // 主动请求指针锁
  const lockTry = await page.evaluate(async () => {
    const el = document.querySelector("video") || document.body;
    try {
      const p = el.requestPointerLock();
      if (p && p.then) await p;
      return { ok: !!document.pointerLockElement, target: el.tagName };
    } catch (e) {
      return { ok: false, target: el.tagName, error: String(e) };
    }
  });

  const lockState = await page.evaluate(() => ({
    pointerLockElement: document.pointerLockElement
      ? document.pointerLockElement.tagName : null,
    plchange: window.__diag.plchange, plerror: window.__diag.plerror,
  }));

  // CDP 按住 w 2s
  await page.keyboard.down("w");
  await page.waitForTimeout(2000);
  await page.keyboard.up("w");
  await page.waitForTimeout(200);

  const afterKeys = await page.evaluate(() => ({
    keydown: window.__diag.keydown, keys: window.__diag.keys,
    mousemove: window.__diag.mousemove,
  }));

  // 收尾：解锁
  await page.evaluate(() => document.exitPointerLock && document.exitPointerLock());

  out(true, { before, afterClick, lockTry, lockState, afterKeys });
});
