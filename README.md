# genshin-agent

在 macOS 的云原神网页版中，复用 [BetterGI](https://github.com/babalae/better-genshin-impact) 的原版云输入 SDK、脚本、路线、地图、模型和任务逻辑。浏览器可在后台无窗口运行，默认静音。

**核心输入已实测，完整功能迁移仍在进行。** 行走、转视角、菜单往返、原版「取消任务追踪」脚本和背包物品统计已通过实机验收。完整采集路线、Boss、副本、钓鱼等流程还没有完成实机验收。原版资源数量不代表可用功能数量。

[功能选择与哥伦比娅材料计划](https://guoshaoyang-pku.github.io/blogs/genshin-agent.html) · [迁移范围](docs/porting-status.md) · [验收记录](docs/validation.json) · [来源与许可](NOTICE.md)

## 安装

需要 Node.js 22+、Python 3.10+、Git、curl，以及自行安装的 Chrome for Testing 140。当前实测平台为 Apple Silicon macOS。

```sh
git clone https://github.com/guoshaoyang-pku/genshin-agent.git
cd genshin-agent
./setup.sh
```

安装会下载固定版本的上游资源，首次需要数百 MB。资源及逐文件校验清单保留在忽略的 `third_party/bettergi/`，不将第三方脚本集合改称本项目作品。资源包下载校验基于锁定的本地 SHA256，尚未独立比对 NuGet 上游 catalog。详细说明见 [安装说明](docs/setup.md)。

## 连接自己的游戏

用浏览器可执行文件的实际路径设置 `GENSHIN_BROWSER`。先在有窗口模式完成本人账号登录，再关闭该专用浏览器并以无窗口模式重启。同一个 profile 不能同时由两个浏览器使用。

```sh
export GENSHIN_BROWSER="/path/to/Google Chrome for Testing"
bash scripts/launch-browser.sh
# 完成登录并关闭专用浏览器后：
bash scripts/launch-browser.sh --headless
node scripts/harness.mjs bettergi.status
node scripts/harness.mjs bettergi.enter timeoutMs=180000
```

`bettergi.enter` 使用已有登录态，等到游戏主界面后返回。它不负责登录或处理未知弹窗。连接端口默认仅为本机 `127.0.0.1:9222`。浏览器启动带 `--mute-audio`，BetterGI 连接同时持续将音视频元素静音、音量设为零。

## 先运行已实测的操作

在正常游戏主界面执行：

```sh
node scripts/harness.mjs bettergi.script package=取消任务追踪
node scripts/harness.mjs bettergi.task task=CountInventoryItem --json '{"taskConfig":{"ItemNames":["清水玉"]},"detailed":true}'
```

背包统计使用原版物品识别资源和文字识别。实机样本识别了清水玉数量并返回主界面，尚不能保证任意材料、任意背包布局都可靠。未识别到的材料返回 missing，不能直接按零库存处理。

`node scripts/bettergi/validate-live.mjs` 会实操短距离后退、转视角、菜单和原版脚本，并保存截图及输入追踪。运行前把角色放在安全空地。`bettergi.catalog` 仅列出已下载脚本，不表示每个脚本都受支持。

网页可选择材料和功能、填写库存、复制需求或下载计划。网页仅在本地浏览器保存选择，不连接游戏。后续应按「核对库存 → 选缺口 → 验证短路线 → 复核获得数量」执行。Boss、副本的完整流程仍待实测，不能把计划导出理解为自动刷取已经完成。

## 开发与验证

```sh
node --test scripts/bettergi/*.test.mjs
venv/bin/python -m unittest discover -s tests
python3 scripts/bettergi/audit-upstream.py --output data/bettergi/validation/upstream-audit.json
```

测试覆盖适配接口、原版数据及视觉算法。离线测试通过不等于游戏任务端到端通过。云客户端更新可能导致原版输入 SDK 失效，需要重新运行实机验收。默认任务超时 120 秒，可传 `timeoutMs`。脚本结束会释放按键和宿主连接，但游戏会话独立存在，仍可因空闲断开。

`profile/` 保存本人登录态。`data/` 保存截图、日志和运行结果。二者都被 Git 忽略，请勿将它们上传至 issue。

使用 Codex 或 Claude Code 时，项目约束及入口见 [AGENTS.md](AGENTS.md)。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

本项目主要代码遵循 GPL-3.0-only。`scripts/bettergi/yolo_vision.py` 的 YoloSharp 派生部分遵循 AGPL-3.0-or-later。原版脚本、模型及资产保留各自作者与许可，详见 [NOTICE.md](NOTICE.md)。
