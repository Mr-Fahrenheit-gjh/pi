---
name: project-scaffold
description: 在 ~/Documents/pi/项目 或 工具 下新建项目时使用，统一生成 README.md、AGENTS.md、.gitignore，避免每次重复搭建。
---
# 项目脚手架

`bash ~/.pi/agent/skills/project-scaffold/scripts/new.sh <项目|工具> <名称> "<一句话目标>"`

生成：
- `README.md`：目标、入口命令、目录说明
- `AGENTS.md`：只写本项目特有的规则（通用规则已在 ~/Documents/pi/AGENTS.md，不要复制）
- `.gitignore`：node_modules、.venv、.next、dist、缓存、.env、日志

规则：
- 不覆盖已存在的目录。
- 不自动 `git init`，不安装依赖。需要独立仓库时先问用户；默认用工作区根仓库。
- 数据、下载物、大文件放在项目内的 `data/` 并加入 .gitignore。
