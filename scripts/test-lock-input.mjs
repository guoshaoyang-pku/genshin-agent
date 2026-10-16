// 锁+输入联动测试：JS 请求指针锁 → 按住 w 3s → CDP 鼠标增量转视角 → 各步截图 diff。
import { imgDiff, out, shot, withPage } from "./lib/core.mjs";

await withPage(async (page) => {
  // 0. 先 CDP 点击中心提供 user activation（请求指针锁的前提）
  await page.mouse.move(1028, 575);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);

  // 1. 请求指针锁
  const lock = await page.evaluate(async () => {
    const el = document.querySelector("video") || document.body;
    try {
      const p = el.requestPointerLock();
      if (p && p.then) await p;
      return { ok: !!document.pointerLockElement };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  if (!lock.ok) { out(false, lock, "指针锁获取失败"); return; }

  // 2. 锁内按住 w 3s
  const a1 = await shot(page, "lock-walk-a");
  await page.keyboard.down("w");
  await page.waitForTimeout(3000);
  await page.keyboard.up("w");
  await page.waitForTimeout(400);
  const b1 = await shot(page, "lock-walk-b");
  const walkDiff = await imgDiff(a1.path, b1.path);

  // 3. 锁内 CDP 鼠标增量转视角（向右约 400px）
  const a2 = await shot(page, "lock-look-a");
  let cx = 1028, cy = 575;
  for (let i = 0; i < 20; i++) {
    cx += 20;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(400);
  const b2 = await shot(page, "lock-look-b");
  const lookDiff = await imgDiff(a2.path, b2.path);

  // 4. 解锁
  await page.evaluate(() => document.exitPointerLock && document.exitPointerLock());

  out(true, {
    lock,
    walk: { ...walkDiff, a: a1.path, b: b1.path },
    look: { ...lookDiff, a: a2.path, b: b2.path },
  });
});
