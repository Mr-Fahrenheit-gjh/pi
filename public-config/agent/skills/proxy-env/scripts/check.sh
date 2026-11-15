#!/bin/bash
# 只读：检查 PandaFan 代理与出口
for p in 10080 10081; do
  if nc -z 127.0.0.1 $p 2>/dev/null; then echo "port $p: listening"; else echo "port $p: DOWN"; fi
done
echo -n "proxy  -> google: "; curl -s -o /dev/null -m 8 -w "%{http_code}\n" -x http://127.0.0.1:10080 https://www.google.com || echo fail
echo -n "direct -> baidu:  "; curl -s -o /dev/null -m 8 -w "%{http_code}\n" --noproxy '*' https://www.baidu.com || echo fail
[ -f ~/.pi/agent/pi-web-proxy.env ] && echo "env file: $(grep -c '^export' ~/.pi/agent/pi-web-proxy.env) exports"
