#!/bin/bash
set -euo pipefail
BASE="$HOME/.pi/agent/hy-memory"
source "$HOME/.pi/agent/pi-web-proxy.env"
# This launcher belongs to the existing macOS deployment, not portable discovery.
export HY_BRIDGE_PI_SDK_ROOT="${HY_BRIDGE_PI_SDK_ROOT:-/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent}"
export HY_BRIDGE_QMD_ROOT="${HY_BRIDGE_QMD_ROOT:-/opt/homebrew/lib/node_modules/@tobilu/qmd}"
export HY_BRIDGE_TOKEN_FILE="$BASE/bridge-token"
export HY_BRIDGE_PORT=30147
export QMD_EMBED_PARALLELISM=1
exec /opt/homebrew/bin/node "$BASE/runtime/bridge.mjs"
