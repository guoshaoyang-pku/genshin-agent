// 基础输入 ops：点击、按键、长按、输入文本。M0 阶段保持原子化，不沉淀场景逻辑。
import { click, hold, out, press, typeText, withPage } from "../lib/core.mjs";

export const ops = {
  click: (page, a) => click(page, a.x ?? 960, a.y ?? 540, { waitAfter: a.waitAfter ?? 300 })
    .then((r) => out(true, r)),
  press: (page, a) => press(page, a.key || "Escape", { waitAfter: a.waitAfter ?? 300 })
    .then((r) => out(true, r)),
  hold: (page, a) => hold(page, a.key || "w", a.ms ?? 1000)
    .then((r) => out(true, r)),
  type: (page, a) => typeText(page, a.text || "", {})
    .then((r) => out(true, r)),
};

export async function run(name, args) {
  await withPage(async (page) => {
    const fn = ops[name];
    if (!fn) throw new Error(`nav 无此操作: ${name}`);
    await fn(page, args || {});
  });
}
