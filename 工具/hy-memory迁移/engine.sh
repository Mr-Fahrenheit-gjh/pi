#!/bin/bash
set -euo pipefail
BASE="$HOME/.pi/agent/hy-memory"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export HY_BRIDGE_TOKEN_FILE="$BASE/bridge-token"
export HY_MEMORY_HOME="${HY_MEMORY_HOME:-$BASE/data}"
export HY_MEMORY_PORT=30148
export PYTHONFAULTHANDLER=1
exec "$BASE/venv/bin/python" -u "$BASE/runtime/sdk_service.py"
