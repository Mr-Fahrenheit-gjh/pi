---
name: browser-harness
description: 浏览器操作入口：默认独立无头 Playwright；现有标签页或登录态用 OpenCLI 扩展。打开、读取、点击、填写、截图和网页验证时读取。
---

# 浏览器后端与授权

## 选择后端

- **普通网页与 UI 验证**：使用 playwright-mcp，独立 profile、无头 Chrome。当前服务入口为 `http://localhost:8931/mcp`，只监听本机；不要连接用户日常 Chrome。
- **用户现有标签页、登录态或本地存储**：用户已允许通过 OpenCLI 扩展连接正在使用的浏览器，不需每次重复询问连接权限。只绑定当前任务明确涉及的标签页，不遍历、读取或改动无关标签页。先读 `opencli-usage`；实际驱动前读 `opencli-browser`，按实时帮助使用绑定命令。
- **Pi Web 内置浏览器**：profile 为 `~/.pi/agent/browser/chrome-profile`，只用于 Pi Web 自身功能，不等于用户当前浏览器。

连接授权不等于任意操作授权。登录、提交、发布、支付、删除和安全设置仍遵守任务本身的授权；只询问新增或不明确的范围，不重复询问已经批准的操作。

## 最小检查

- OpenCLI 操作前运行 `opencli doctor` 检查扩展桥接；同一任务内已确认连接且未失效时可复用。扩展未连接时明确报告，不偷偷改用远程调试或桌面控制。
- Playwright 排障时按需运行 `bash ~/.pi/agent/skills/browser-harness/scripts/check.sh`；不要对每个浏览器任务做无关的全量检查。
- 核对绑定页面确为任务目标，再读取或操作。只访问需要的数据，不输出密码、令牌、Cookie 等凭据。

## 禁止与收尾

- 禁止 osascript、AppleScript、System Events、cliclick 等桌面按键或点击自动化。
- 禁止用 `--autoConnect`、remote-debugging 或日常 Chrome profile 绕过扩展接入；本次授权仅开放 OpenCLI 扩展路径。
- 不导航、关闭或重载无关标签页；用户原有浏览器和标签页不属于临时进程，任务结束时不能关闭它们。
- 自己启动的临时浏览器和进程在任务结束时关闭，保留验证所需的最终证据。
