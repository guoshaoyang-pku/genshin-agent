#!/usr/bin/env node
// 自进化回路：失败记录 → 建议沉淀 → 应用进 buttons.json → 重建 affordance 宝库。
//
// 用法:
//   node scripts/evolve.mjs record op=dialogue.advance screenshot=data/shots/x.jpg observation=... fix=...
//   node scripts/evolve.mjs suggest
//   node scripts/evolve.mjs apply
//   node scripts/evolve.mjs list [N]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FAIL = path.join(ROOT, "memory/failures.jsonl");
const BUTTONS = path.join(ROOT, "skills/buttons.json");

fs.mkdirSync(path.dirname(FAIL), { recursive: true });

const [cmd, ...rest] = process.argv.slice(2);
const parse = (s) => {
  const idx = s.indexOf("=");
  return idx === -1 ? [s, true] : [s.slice(0, idx), s.slice(idx + 1)];
};
const args = Object.fromEntries(rest.map(parse));

if (cmd === "record") {
  const entry = {
    ts: new Date().toISOString(),
    op: args.op || "",
    screenshot: args.screenshot || "",
    observation: args.observation || "",
    fix: args.fix || "",
    suggestedButton: args.suggestedButton ? JSON.parse(args.suggestedButton) : null,
    applied: false,
  };
  fs.appendFileSync(FAIL, JSON.stringify(entry) + "\n");
  const count = fs.readFileSync(FAIL, "utf8").trim().split("\n").filter(Boolean).length;
  console.log(`已记录失败/经验 → memory/failures.jsonl（共 ${count} 条）`);
}

else if (cmd === "suggest") {
  const lines = fs.existsSync(FAIL) ? fs.readFileSync(FAIL, "utf8").trim().split("\n").filter(Boolean) : [];
  const pending = lines.map((l) => JSON.parse(l)).filter((e) => !e.applied);
  const byOp = {};
  for (const e of pending) (byOp[e.op] = byOp[e.op] || []).push(e);
  console.log(`待复盘失败/经验：${pending.length} 条`);
  for (const [op, es] of Object.entries(byOp)) {
    console.log(`\n## ${op}（${es.length} 次）`);
    for (const e of es) {
      console.log(`- ${e.ts} 截图:${e.screenshot || "-"}`);
      console.log(`  观察: ${e.observation}`);
      console.log(`  修复: ${e.fix}`);
      if (e.suggestedButton) console.log(`  建议按钮: ${JSON.stringify(e.suggestedButton)}`);
    }
  }
  const suggestions = pending.filter((e) => e.suggestedButton);
  if (suggestions.length) {
    console.log(`\n共 ${suggestions.length} 条按钮建议可应用（node scripts/evolve.mjs apply）`);
  }
}

else if (cmd === "apply") {
  if (!fs.existsSync(FAIL)) { console.log("没有失败记录"); process.exit(0); }
  const lines = fs.readFileSync(FAIL, "utf8").trim().split("\n").filter(Boolean);
  const buttons = JSON.parse(fs.readFileSync(BUTTONS, "utf8"));
  let added = 0, skipped = 0;
  const out = [];
  for (const line of lines) {
    const e = JSON.parse(line);
    if (!e.applied && e.suggestedButton && Array.isArray(e.suggestedButton.center)) {
      const { name, center } = e.suggestedButton;
      if (name && center.every((v) => typeof v === "number") && (center[0] !== 0 || center[1] !== 0)) {
        if (buttons.buttons[name] && JSON.stringify(buttons.buttons[name]) === JSON.stringify(center)) {
          skipped++;
        } else {
          buttons.buttons[name] = center;
          added++;
        }
      } else skipped++;
      e.applied = true;
    }
    out.push(JSON.stringify(e));
  }
  fs.writeFileSync(BUTTONS, JSON.stringify(buttons, null, 2) + "\n");
  fs.writeFileSync(FAIL, out.join("\n") + "\n");
  console.log(`已应用 ${added} 个新按钮（跳过 ${skipped}），buttons.json 已更新`);
}

else if (cmd === "list") {
  const n = Number(args[0] || 10);
  const lines = fs.existsSync(FAIL) ? fs.readFileSync(FAIL, "utf8").trim().split("\n").filter(Boolean) : [];
  for (const line of lines.slice(-n)) {
    const e = JSON.parse(line);
    console.log(`[${e.applied ? "已应用" : "待复盘"}] ${e.ts} ${e.op} ${e.observation} ${e.fix}`);
  }
}

else {
  console.log("用法: record | suggest | apply | list");
  process.exit(1);
}
