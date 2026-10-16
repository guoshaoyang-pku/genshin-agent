# genshin-agent

该项目将 BetterGI 原版资源和任务逻辑适配到 macOS 云原神浏览器。优先复用已有脚本、模型、地图与源码，不重新实现已有资源。

- 本机依赖及资源安装：`./setup.sh`。不要提交生成的 `third_party/bettergi/`。
- Node 测试：`node --test scripts/bettergi/*.test.mjs`。
- Python 测试：`venv/bin/python -m unittest discover -s tests`。
- 上游校验：`python3 scripts/bettergi/audit-upstream.py --output data/bettergi/validation/upstream-audit.json`。
- 统一入口：`node scripts/harness.mjs --help`。
- 核心适配在 `scripts/bettergi/`，入口在 `scripts/ops/bettergi.mjs`，视觉桥在 `scripts/bettergi/vision.py`。
- 不修改下载的原版文件，适配代码与来源保持分离。保留原作者和许可。
- 游戏/CDP 输入只能有一个执行者持有，离线开发可以并行。
- 启动和连接浏览器必须静音。任务结束释放所有按键和鼠标键。
- `profile/` 与 `data/` 不得公开，勿打印或存储登录凭据。
- 区分已实现、离线通过和实机通过。资源目录存在不代表功能可用。
- 修改公开状态时同步 `docs/porting-status.md` 和 `docs/genshin-agent.html`。

当前限制和实测入口见 README 与 `docs/porting-status.md`。
