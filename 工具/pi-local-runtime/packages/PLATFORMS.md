# Windows / Linux 入口

完整的下载、首次模型授权与操作手册在仓库根 [README](../../../README.md)。默认 `main` 与兼容分支 `pi-web` 均包含相同的网页应用、扩展源码和公开配置。

- [直接下载网页端 ZIP](https://github.com/Mr-Fahrenheit-gjh/pi/archive/refs/heads/main.zip)，解压后 Windows 双击 `start.cmd`；Linux/macOS 执行 `bash start.sh`。
- 需要 Node.js >=22.19.0（建议22 LTS，包含npm）；入口按锁文件准备项目依赖并构建，后续复用，不做全局安装或系统服务注册。
- [详细平台与启动说明](https://github.com/Mr-Fahrenheit-gjh/pi/blob/pi-web/docs/platforms.md)。

## 当前目录的终端扩展

公开提示词、规则、技能、角色和插件声明集中在根目录 `public-config`。先运行 `node bin/configure-agent.mjs --target <新agent目录> --with-extensions` 预览，确认后追加 `--apply`。不复制作者账号或记忆，不覆盖已有不同内容。插件声明会在下次SDK启动时尝试准备对应npm依赖，外部服务仍按各组件README自行配置。

quiet 包装器需要已安装的上游工具包，子代理 SDK 必须是实际宿主的版本；LSP 需要对应语言服务器；tmux 后台工具和 Hy-Memory 等外接服务有各自运行条件。路径适配通过不等于这些完整外部环境均已部署，不能以此宣称所有工具在原生 Windows 上完整可用。

公开网页端不包含 Pi Meta/Feynman 或原机器部署控制。Pi Bar 仍为可选 macOS 应用，不是 Windows/Linux 前置依赖。

## 验证

[Web 双平台工作流](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/platforms.yml) 覆盖准备、构建和真实 HTTP 启动；[扩展平台工作流](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/extensions.yml) 仅覆盖所列纯 fixture 回归。完整插件启用情况按组件文档和目标机器实际环境判断。
