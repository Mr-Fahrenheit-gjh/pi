---
name: mcp-wiring
description: 新增、移除或检查 Pi 的 MCP 服务（~/.pi/agent/mcp.json）。用于接入新 MCP、排查 MCP 不可用、重复或进程遗留。
---
# MCP 接入

配置：`~/.pi/agent/mcp.json`（权限 600）；服务清单以该文件为准，不把历史列表当成当前状态。技能版本源为工作区 `项目/规则优化/运行规则/mcp-wiring/`，修改后同步运行副本。

## 新增服务
1. 先备份：`cp -p mcp.json backups/mcp.json.$(date +%Y%m%d-%H%M%S)`。
2. 优先 stdio；长期常驻的服务用 launchd 托管 HTTP，只绑 127.0.0.1。
3. 固定版本号（如 `pkg@1.2.3`），不用 `@latest`。
4. 密钥不写进 mcp.json：用 `"${ENV_NAME}"`、完整值的 `"!command"` 引用，或放 mcp-auth.json。检查器不执行引用命令，不能代替对命令本身是否内嵌秘密的审查。
5. 不和已有能力重复（例如浏览器只用 playwright，见 browser-harness）。
6. 修改后运行 `python3 ~/.pi/agent/skills/mcp-wiring/scripts/check.py`。
7. 配置变更与现有连接生效分开核对；不把文件检查通过当成已有 MCP 连接已重建。正式 pi-web 若需重启，必须先取得用户确认。

## shadcn 的环境边界

当前 SDK 不消费 MCP 条目的 `inheritEnv` 字段。此服务器以 `/usr/bin/env -i` 包住原来固定版本的 `npx shadcn` 命令，显式设置 PATH、HOME、TMPDIR、LANG；不继承提供商密钥及任意宿主变量。基本路径以本机配置为准，迁移机器时核对。

不修改 SDK 或正式 Web 安装包，也不把整个宿主环境重新传入。若之后确需代理等变量，应单独确认必要的白名单。保留 HOME 方便正常使用 npm 缓存；这只是环境隔离，不阻止同用户的文件或钥匙串访问，不是进程沙箱。

离线回归见工作区 `项目/规则优化/运行规则/configuration-repair.test.mjs`，仅用合成环境启动 Node 探针，不启动 npx/shadcn 或读取真实凭据。

## 移除服务
从 mcp.json 删除对应条目，停掉它的进程（先核对 PID 和父进程，确认属于 Pi），再跑 check.py。
