// 端到端：关弹窗 → 进入游戏 → 等视频流 → 立即点击+请求指针锁 → 锁内走/转视角 diff。
// 用于验证「重启后首次锁可用」假设。
import { imgDiff, out, shot, withPage } from "./lib/core.mjs";

await withPage(async (page) => {
  const steps = {};

  // 1. 关掉可能的弹窗（保存网页地址等）：点右上角 X 区域；保守点两次空白外 X
  await page.mouse.click(1141, 287).catch(() => {});
  await page.waitForTimeout(500);

  // 2. 点「进入游戏」
  await page.mouse.click(1595, 656);
  steps.clickedEnter = true;

  // 3. 等视频流就绪（最长 150s，覆盖排队）
  let streamOk = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const v = await page.evaluate(() => {
      const el = document.querySelector("video");
      return el && el.readyState === 4 && !el.paused
        ? { w: el.videoWidth, h: el.videoHeight } : null;
    });
    if (v) { streamOk = true; steps.stream = v; break; }
    await page.waitForTimeout(2000);
  }
  if (!streamOk) {
    const s = await shot(page, "enter-timeout");
    out(false, { steps, screenshot: s.path }, "150s 内未见视频流（可能排队中）");
    return;
  }
  await page.waitForTimeout(3000); // 等游戏内加载

  // 4. 立即：点击中心 → 请求指针锁
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
  if (!lock.ok) { out(false, steps, "重启后首次请求指针锁仍失败"); return; }

  // 5. 锁内按住 w 3s
  const a1 = await shot(page, "fresh-walk-a");
  await page.keyboard.down("w");
  await page.waitForTimeout(3000);
  await page.keyboard.up("w");
  await page.waitForTimeout(400);
  const b1 = await shot(page, "fresh-walk-b");
  steps.walk = await imgDiff(a1.path, b1.path);
  steps.walkShots = [a1.path, b1.path];

  // 6. 锁内转视角 dx≈400
  const a2 = await shot(page, "fresh-look-a");
  let cx = 1028;
  for (let i = 0; i < 20; i++) { cx += 20; await page.mouse.move(cx, 575); await page.waitForTimeout(40); }
  await page.waitForTimeout(400);
  const b2 = await shot(page, "fresh-look-b");
  steps.look = await imgDiff(a2.path, b2.path);
  steps.lookShots = [a2.path, b2.path];

  // 注意：不退出指针锁，保持会话内锁定
  out(true, steps);
});
