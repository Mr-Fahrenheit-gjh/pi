#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
WORK="$(mktemp -d "$ROOT/.offline-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
UPSTREAM="$HOME/.pi/agent/npm/node_modules/pi-agent-browser-native"
if [[ ! -f "$UPSTREAM/package.json" ]]; then
  echo "Missing test dependency: $UPSTREAM (expected Pi npm root)" >&2
  exit 1
fi
mkdir -p "$WORK/home" "$WORK/agent/npm/node_modules" "$WORK/tmp"
ln -s "$UPSTREAM" "$WORK/agent/npm/node_modules/pi-agent-browser-native"
cd "$WORK"
for HOST in /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent /opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent; do
  env -i HOME="$WORK/home" TMPDIR="$WORK/tmp" PI_CODING_AGENT_DIR="$WORK/agent" PI_OFFLINE=1 JITI_FS_CACHE=0 BROWSER_TEST_HOST="$HOST" "$NODE" "$ROOT/check.mjs"
done
