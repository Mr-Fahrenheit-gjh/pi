---
name: proxy-env
description: 为命令设置 PandaFan 代理（HTTP 127.0.0.1:10080 / SOCKS5 10081）和 NO_PROXY 直连名单。用于网络请求失败、需要走代理或直连、配置新工具的代理时。
---
# 代理环境

唯一配置源：`~/Documents/pi/工具/代理分流管理/rules.yaml`，入口 `pi-route`（`~/.local/bin/pi-route`）。
`~/.pi/agent/pi-web-proxy.env` 由 pi-route 生成，不要手改。

## 用法
- 单条命令：`pi-route run auto|direct|proxy -- <命令>`（auto 按规则分流，国内模型 API、.cn、.sjtu.edu.cn、.qq.com 直连）。
- 在当前 shell 加载：`source ~/.pi/agent/pi-web-proxy.env`。
- 自检（只读）：`bash ~/.pi/agent/skills/proxy-env/scripts/check.sh`，检查代理端口是否在监听，以及直连和代理出口是否可达。

## 规则
- 新增直连或代理域名：改 rules.yaml，再用 pi-route 重新生成；不要把代理写进 ~/.zshrc（改 shell 配置需用户确认）。
- 不读取、修改或重载 Clash（已停用，见 `历史/Clash/`）。
- 排查网络问题时先跑 check.sh，不要反复重试同一请求。
