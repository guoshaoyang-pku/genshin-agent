// 等视频流就绪 → 立即点击+请求指针锁 → 锁内走 3s / 转视角 400px，各步截图 diff。
import { imgDiff, out, shot, withPage } from "./lib/core.mjs";

await withPage(async (page) => {
  const steps = {};
  const t0 = Date.now();
  let streamOk = false;
  while (Date.now() - t0 < 240000) {
    const v = await page.evaluate(() => {
      const el = document.querySelector("video");
      return el && el.readyState === 4 && !el.paused
        ? { w: el.videoWidth, h: el.videoHeight } : null;
    });
    if (v) { streamOk = true; steps.stream = v; break; }
    await page.waitForTimeout(2000);
  }
  if (!streamOk) {
    const s = await shot(page, "stream-timeout");
    out(false, { steps, screenshot: s.path }, "240s 内未见视频流");
    return;
  }
  await page.waitForTimeout(3000);

  await page.mouse.move(1028, 575);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  const lock = await page.evaluate(async () => {
    const el = document.querySelector("video") || document.body;
    try {
      const p = el.requestPointerLock();
      if (p && p.then) await p;
      return { ok: !!document.pointerLockElement };
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  });
  steps.lock = lock;
  if (!lock.ok) { out(false, steps, "请求指针锁失败"); return; }

  const a1 = await shot(page, "fresh-walk-a");
  await page.keyboard.down("w");
  await page.waitForTimeout(3000);
  await page.keyboard.up("w");
  await page.waitForTimeout(400);
  const b1 = await shot(page, "fresh-walk-b");
  steps.walk = await imgDiff(a1.path, b1.path);
  steps.walkShots = [a1.path, b1.path];

  const a2 = await shot(page, "fresh-look-a");
  let cx = 1028;
  for (let i = 0; i < 20; i++) { cx += 20; await page.mouse.move(cx, 575); await page.waitForTimeout(40); }
  await page.waitForTimeout(400);
  const b2 = await shot(page, "fresh-look-b");
  steps.look = await imgDiff(a2.path, b2.path);
  steps.lookShots = [a2.path, b2.path];

  // 保持锁定，不 exit
  out(true, steps);
});
