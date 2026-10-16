#!/usr/bin/env node
// 统一 harness CLI：模型通过它调用任意脚本化操作。
// 用法:
//   node scripts/harness.mjs probe.ocr minScore=0.5
//   node scripts/harness.mjs explore.walk ms=2000
//   node scripts/harness.mjs --help
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(`统一操作入口：

用法: node scripts/harness.mjs <group.op> [key=value ...] [--json '<json>']

分组（scripts/ops/*.mjs）：
  probe    info | shot | ocr | diff
  nav      click | press | hold | type
  explore  walk | look | lookJs | unlock
  menu     mail [claim=true] | commissions（需已进入游戏）
  bettergi catalog | status | enter | capture | walk | look | main | mail | rewards | script
           task | pathing | genshin | combat | macro

示例：
  node scripts/harness.mjs probe.info
  node scripts/harness.mjs probe.ocr minScore=0.5
  node scripts/harness.mjs nav.click x=960 y=540
  node scripts/harness.mjs explore.walk ms=2000
  node scripts/harness.mjs explore.look dx=400 dy=0 steps=10
  node scripts/harness.mjs bettergi.script package=取消任务追踪
  node scripts/harness.mjs bettergi.enter
  node scripts/harness.mjs bettergi.task task=CountInventoryItem --json '{"taskConfig":{"ItemNames":["清水玉"]},"detailed":true}'
  node scripts/harness.mjs bettergi.pathing filename=/absolute/path/route.json
  node scripts/harness.mjs bettergi.genshin method=ReturnMainUi
`);
  process.exit(0);
}

const [target, ...rest] = args;
const [group, name] = target.split(".");
if (!group || !name) {
  console.error("格式应为 <group.op>，例如 probe.ocr");
  process.exit(2);
}

// 解析参数：key=value 与 --json
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--json") {
    Object.assign(opts, JSON.parse(rest[++i]));
  } else if (a.includes("=")) {
    const [k, v] = a.split(/=(.*)/s);
    opts[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  }
}

const mod = await import(`./ops/${group}.mjs`);
if (!mod.run) {
  console.error(`未知分组: ${group}`);
  process.exit(2);
}
try {
  await mod.run(name, opts);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
