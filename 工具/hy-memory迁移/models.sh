#!/bin/bash
set -euo pipefail
BASE="$HOME/.pi/agent/hy-memory"
source "$HOME/.pi/agent/pi-web-proxy.env"
export HY_BRIDGE_TOKEN_FILE="$BASE/bridge-token"
export HY_BRIDGE_PORT=30147
export QMD_EMBED_PARALLELISM=1
exec /opt/homebrew/bin/node "$BASE/runtime/bridge.mjs"
