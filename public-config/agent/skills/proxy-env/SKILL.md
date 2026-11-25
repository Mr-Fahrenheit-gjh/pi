---
name: proxy-env
description: 为命令设置当前代理档位的本地代理（端口由 ~/pi-route/rules.yaml 决定，不写死）和 NO_PROXY 直连名单。用于网络请求失败、需要走代理或直连、配置新工具的代理时。
---
# 代理环境

唯一配置源：`~/pi-route/rules.yaml`（独立项目，已从工作区迁出），入口 `pi-route`（`~/.local/bin/pi-route`）。
档位（`profiles`）决定当前端口，`pi-route profile list` 可看；不要在任何地方写死端口。
`~/pi-route/generated/proxy.env` 由 pi-route 生成；`~/.pi/agent/pi-web-proxy.env` 是它的后台副本，不要手改。

## 用法
- 单条命令：`pi-route run auto|direct|proxy -- <命令>`（auto 按规则分流，国内模型 API、.cn、.sjtu.edu.cn、.qq.com 直连）。
- 在当前 shell 加载：`source ~/pi-route/generated/proxy.env`。
- 切档：`pi-route profile use <档名>`（会同时改系统代理、生成物与后台副本）。
- 自检（只读）：`bash ~/.pi/agent/skills/proxy-env/scripts/check.sh`，端口从生成物读，检查监听与直连/代理出口。

## 规则
- 新增直连或代理域名：改 rules.yaml，再用 pi-route 重新生成；不要把代理写进 ~/.zshrc（改 shell 配置需用户确认）。
- 不读取、修改或重载 Clash（已停用，见 `历史/Clash/`）。
- 排查网络问题时先跑 check.sh，不要反复重试同一请求。
