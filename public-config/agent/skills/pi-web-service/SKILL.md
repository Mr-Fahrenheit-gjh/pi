---
name: pi-web-service
description: 查看或管理 launchd 托管的正式 pi-web 服务（cn.pi.web，127.0.0.1:30141）。用于查状态、看日志和任务内服务重启。
---
# pi-web 正式服务

- launchd 标签 `cn.pi.web`，plist 在 `~/Library/LaunchAgents/cn.pi.web.plist`，运行的是全局包 `/opt/homebrew/lib/node_modules/@agegr/pi-web`。
- 日志：`~/.pi/agent/pi-web.log`、`~/.pi/agent/pi-web-restart.log`。

## 只读状态（随时可用）
`bash ~/.pi/agent/skills/pi-web-service/scripts/status.sh`
输出：launchd 状态、监听地址、进程运行时长、HTTP 探活、版本、最近重启次数。

## 重启
任务内需要时执行：`launchctl kickstart -k gui/$(id -u)/cn.pi.web`，然后再跑一遍 status.sh 确认 HTTP 200。
禁止用 pkill/kill 杀 next-server。测试候选版本请用 pi-web-candidate 技能，不要碰 30141。
