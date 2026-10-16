#!/bin/bash
# 启动 genshin-agent 专用 Chrome（持久化 profile + CDP 9222）。
# 用法: scripts/launch-browser.sh [--headless]
set -e
cd "$(dirname "$0")/.."
PROFILE_DIR="$PWD/profile"
URL="https://ys.mihoyo.com/cloud/"

HEADLESS_ARG=""
if [ "$1" = "--headless" ]; then
  HEADLESS_ARG="--headless=new"
fi

# 浏览器选择顺序：环境变量 > 项目内 3rdparty > hsr-agent 三月七同款 CfT > 系统 Chrome。
# 注意：系统 Chrome 155 与 playwright-core CDP 握手不兼容（Browser.setDownloadBehavior 报错），
# 需要 Chrome for Testing 140 系列。
HSR_CFT="$(dirname "$PWD")/hsr-agent/March7thAssistant/3rdparty/WebBrowser/chrome/mac-arm64/140.0.7339.207/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
LOCAL_CFT_DIR="$PWD/3rdparty/WebBrowser/chrome/mac-arm64"
CHROME="${GENSHIN_BROWSER:-}"
if [ -z "$CHROME" ]; then
  if [ -d "$LOCAL_CFT_DIR" ]; then
    CHROME=$(find "$LOCAL_CFT_DIR" -name "Google Chrome for Testing" -perm +111 -type f | head -1)
  fi
fi
if [ -z "$CHROME" ] && [ -x "$HSR_CFT" ]; then
  CHROME="$HSR_CFT"
fi
if [ -z "$CHROME" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  echo "警告：使用系统 Chrome，CDP 连接可能不兼容，建议安装 Chrome for Testing 140" >&2
fi
if [ ! -x "$CHROME" ]; then
  echo "未找到浏览器: $CHROME" >&2
  exit 1
fi
echo "使用浏览器: $CHROME"

# 已在运行的实例不重复启动
if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "CDP 9222 已有浏览器在运行，直接复用。"
  exit 0
fi

"$CHROME" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --window-size=1920,1080 \
  --force-device-scale-factor=1 \
  --mute-audio \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-first-run --no-default-browser-check \
  $HEADLESS_ARG \
  "$URL" >/dev/null 2>&1 &

echo "Chrome 已启动（pid $!），等待 CDP 就绪..."
for i in $(seq 1 20); do
  if curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "CDP 就绪: http://127.0.0.1:9222"
    exit 0
  fi
  sleep 0.5
done
echo "CDP 未就绪，请检查 Chrome 是否启动成功。" >&2
exit 1
