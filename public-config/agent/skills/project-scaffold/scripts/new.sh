#!/bin/bash
# 新建项目骨架（不覆盖、不 git init、不安装依赖）
set -e
KIND=${1:?项目或工具}; NAME=${2:?名称}; GOAL=${3:-待补充}
ROOT=${PI_WORKSPACE:-$HOME/Documents/pi}
case "$KIND" in 项目|工具) ;; *) echo "第一个参数须为 项目 或 工具"; exit 1;; esac
D="$ROOT/$KIND/$NAME"
[ -e "$D" ] && { echo "已存在：$D"; exit 1; }
mkdir -p "$D"
printf '# %s\n\n目标：%s\n\n## 入口\n\n（待补充）\n\n## 目录\n\n- data/：数据与下载物（不入库）\n' "$NAME" "$GOAL" > "$D/README.md"
printf '# %s 项目规则\n\n只写本项目特有的约定；通用规则见 ~/Documents/pi/AGENTS.md。\n' "$NAME" > "$D/AGENTS.md"
printf 'node_modules/\n.venv/\n__pycache__/\n.next/\ndist/\nbuild/\n.cache/\n*.log\n.env\n.env.*\n!.env.example\ndata/\n.DS_Store\n' > "$D/.gitignore"
echo "created $D"; ls -A "$D"
