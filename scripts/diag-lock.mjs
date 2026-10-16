// 指针锁失败深挖：video 元素连接状态、user activation、不同目标元素、iframe 情况。
import { out, withPage } from "./lib/core.mjs";

await withPage(async (page) => {
  // CDP 点击后立即读 userActivation
  await page.mouse.move(1028, 575);
  await page.mouse.down();
  await page.mouse.up();

  const state = await page.evaluate(() => {
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      isConnected: v.isConnected,
      sameDoc: v.ownerDocument === document,
      readyState: v.readyState,
      cls: v.className || null,
      parentTag: v.parentElement && v.parentElement.tagName,
    }));
    return {
      videos,
      iframes: [...document.querySelectorAll("iframe")].map((f) => ({
        src: (f.src || "").slice(0, 80),
        allow: f.allow || null,
        sandbox: f.getAttribute("sandbox"),
      })),
      userActivation: {
        isActive: navigator.userActivation.isActive,
        hasBeenActive: navigator.userActivation.hasBeenActive,
      },
      fullscreenElement: document.fullscreenElement
        ? document.fullscreenElement.tagName : null,
    };
  });

  // 依次尝试：video / body / documentElement，逐个报错详情
  const attempts = await page.evaluate(async () => {
    const results = [];
    const targets = {
      video: document.querySelector("video"),
      body: document.body,
      documentElement: document.documentElement,
    };
    for (const [name, el] of Object.entries(targets)) {
      if (!el) { results.push({ name, skip: true }); continue; }
      try {
        const p = el.requestPointerLock();
        if (p && p.then) await p;
        results.push({ name, ok: !!document.pointerLockElement });
        if (document.pointerLockElement) {
          document.exitPointerLock();
          break;
        }
      } catch (e) {
        results.push({ name, ok: false, error: `${e.name}: ${e.message}` });
      }
    }
    return results;
  });

  out(true, { state, attempts });
});
