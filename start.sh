#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 22 LTS（包含 npm）：https://nodejs.org/' >&2
  exit 1
fi
exec node bin/start-custom.js "$@"
