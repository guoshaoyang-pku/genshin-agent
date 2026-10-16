# 本地安装

已验证环境是 macOS、Node.js 26、Python 3.10 和 Chrome for Testing 140。准备 Node.js 22 或更新版本、Python 3.10 或更新版本、Git、curl，再在仓库根目录执行：

```sh
./setup.sh
```

需要指定 Python 时，可执行 `GENSHIN_PYTHON=python3.12 ./setup.sh`。

安装会创建项目内的 `venv`，安装 `package-lock.json` 和 `requirements-bettergi.txt` 中的依赖，并下载固定版本的 BetterGI 源码、脚本、路线、模型、地图与依赖源码。资源约 700 MB，下载缓存另占空间，建议至少预留 2 GB。下载失败可以重试；不会运行下载的原版脚本，也不会覆盖已有资源。只安装代码依赖可以执行 `./setup.sh --skip-resources`。

资源下载入口：

```sh
node scripts/bettergi/fetch-resources.mjs
node scripts/bettergi/fetch-resources.mjs --verify
```

下载器使用固定 Git 提交和 NuGet 包 SHA256，拒绝散列不符、目录穿越与归档链接，并在临时目录完成校验后整体安装到 `third_party/bettergi`。`--verify` 对该下载器生成的资源清单逐文件校验，不访问游戏。已有旧版手动导入目录不会自动迁移或删除；如需比较，可使用 `--destination /tmp/bettergi-check --cache /tmp/bettergi-downloads` 安装到独立目录。模型、脚本包和地图沿用各自的上游许可，见仓库 NOTICE。

浏览器需要单独准备。设置 Chrome for Testing 140 的可执行文件路径：

```sh
export GENSHIN_BROWSER="/path/to/Google Chrome for Testing"
bash scripts/launch-browser.sh
```

先在专用浏览器中完成云原神登录。浏览器关闭后，可执行 `bash scripts/launch-browser.sh --headless` 在后台启动。默认启动参数包含静音。登录态保存在本地 `profile/`，不要上传该目录。网页登录是否排队、畅玩卡状态和游戏角色权限由自己的账号决定。

核心 BetterGI 识别使用原版 PaddleOCR/ONNX 资源。旧版通用截图命令 `scripts/ocr.py` 使用 `rapidocr-onnxruntime`，安装程序只在 Python 3.10–3.12 环境安装这项依赖。Python 3.13 及更新版本可运行 BetterGI 核心入口；旧版 `probe.ocr` 等通用截图命令需改用 Python 3.10–3.12 环境。

离线回归命令：

```sh
node --test scripts/bettergi/*.test.mjs
venv/bin/python -m unittest discover -s tests
```

离线回归通过说明接口和资源能够加载，完整游戏流程仍应按网页中的“已实测 / 待实测”状态选择。
