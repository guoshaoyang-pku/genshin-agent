#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" != "" && "${1:-}" != "--skip-resources" ]] || (( $# > 1 )); then
  echo "Usage: ./setup.sh [--skip-resources]" >&2
  exit 1
fi
PYTHON="${GENSHIN_PYTHON:-python3}"
for executable in node npm "$PYTHON" git curl; do
  command -v "$executable" >/dev/null || { echo "Missing prerequisite: $executable" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required")'
npm ci
if [[ ! -x venv/bin/python ]]; then
  "$PYTHON" -m venv venv
fi
venv/bin/python -m pip install -r requirements-bettergi.txt
if [[ "${1:-}" != "--skip-resources" ]]; then
  GENSHIN_PYTHON="$PWD/venv/bin/python" node scripts/bettergi/fetch-resources.mjs
fi
echo "Setup complete. Configure GENSHIN_BROWSER with Chrome for Testing 140; see docs/setup.md."
