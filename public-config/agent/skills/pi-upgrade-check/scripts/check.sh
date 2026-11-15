#!/bin/bash
# 只读：Pi 组件版本与升级前检查
for p in @earendil-works/pi-coding-agent @agegr/pi-web; do
  cur=$(node -p "require('/opt/homebrew/lib/node_modules/$p/package.json').version" 2>/dev/null)
  latest=$(npm view $p version 2>/dev/null)
  echo "$p: installed=${cur:-none} latest=${latest:-?}"
done
echo "== settings.json 本地包路径"
python3 - <<'P'
import json,os
s=json.load(open(os.path.expanduser('~/.pi/agent/settings.json')))
for x in s.get('packages',[]):
    src=x if isinstance(x,str) else x.get('source','')
    if src.startswith('/'): print(('OK  ' if os.path.exists(src) else 'MISSING ')+src)
P
ls -d ~/Documents/pi/工具/pi-web维护/pi-web-source* 2>/dev/null
