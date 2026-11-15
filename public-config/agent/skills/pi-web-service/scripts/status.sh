#!/bin/bash
# 只读：查看正式 pi-web 服务状态
PORT=${1:-30141}
echo "== launchd"; launchctl list | awk '$3=="cn.pi.web"' || true
echo "== listen"; lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1,$2,$9}'
for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do ps -o pid,ppid,etime,%cpu,%mem,command -p $pid | tail -1 | cut -c1-120; done
echo "== http"; curl -s -o /dev/null -m 5 -w "%{http_code}\n" --noproxy '*' http://127.0.0.1:$PORT/ || echo down
echo "== version"; node -p "require('/opt/homebrew/lib/node_modules/@agegr/pi-web/package.json').version" 2>/dev/null
echo "== restarts in log"; grep -c 'Ready in' ~/.pi/agent/pi-web.log 2>/dev/null
