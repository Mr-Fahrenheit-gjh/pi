#!/bin/bash
# 只读：检查当前档位的本地代理与出口。
# 端口从 pi-route 的生成物读，脚本里不写死。
ENV_FILE="${PI_ROUTE_ENV:-$HOME/pi-route/generated/proxy.env}"

PORT=""
if [[ -r "$ENV_FILE" ]]; then
  PORT="$(sed -n 's|^export http_proxy=http://[^:]*:\([0-9][0-9]*\)$|\1|p' "$ENV_FILE" | head -1)"
fi

if [[ -z "$PORT" ]]; then
  echo "warn: 读不到 $ENV_FILE 里的代理端口" >&2
else
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "port $PORT: listening"
  else
    echo "port $PORT: DOWN"
  fi
  echo -n "proxy  -> google: "
  curl -s -o /dev/null -m 8 -w "%{http_code}\n" -x "http://127.0.0.1:$PORT" https://www.google.com || echo fail
fi

echo -n "direct -> baidu:  "
curl -s -o /dev/null -m 8 -w "%{http_code}\n" --noproxy '*' https://www.baidu.com || echo fail

[[ -f "$ENV_FILE" ]] && echo "env file: $ENV_FILE ($(grep -c '^export' "$ENV_FILE") exports)"
echo -n "当前档位: "
grep -m1 '^  active:' "$HOME/pi-route/rules.yaml" 2>/dev/null | awk '{print $2}' || echo unknown
