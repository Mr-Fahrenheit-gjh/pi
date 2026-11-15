#!/bin/bash
# 在独立端口启动 pi-web 候选版本（拒绝使用 30141）
set -e
DIR=${1:?候选目录}; PORT=${2:-30150}
[ "$PORT" = 30141 ] && { echo "拒绝：30141 是正式服务"; exit 1; }
lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && { echo "端口 $PORT 已被占用"; exit 1; }
LOG=/tmp/pi-web-candidate-$PORT.log
cd "$DIR"
nohup node bin/pi-web.js --no-open --port $PORT >"$LOG" 2>&1 &
PID=$!
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" --noproxy '*' http://127.0.0.1:$PORT/ || true)
  [ "$code" = 200 ] && { echo "READY pid=$PID port=$PORT log=$LOG"; exit 0; }
  kill -0 $PID 2>/dev/null || { echo "进程已退出，见 $LOG"; exit 1; }
  sleep 1
done
echo "超时未就绪 pid=$PID log=$LOG"; exit 1
