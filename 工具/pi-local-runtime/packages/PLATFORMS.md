# Windows / Linux 使用说明

本仓库按**共用源码 + 少量平台适配**维护，不复制三套界面，不升级依赖，也不包含作者的私有设置和授权。Windows 指原生 Windows，不要求 WSL；这不是独立 `.exe` / AppImage 安装包。

## Pi Web

使用 [`pi-web` 分支的平台指南](https://github.com/Mr-Fahrenheit-gjh/pi/blob/pi-web/docs/platforms.md)。简要步骤：

```sh
git clone --branch pi-web --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
cd pi-web-custom
npm ci
npm run build
node bin/pi-web.js --no-open
```

Windows PowerShell 中把 `npm` 换成 `npm.cmd` 即可。需要 Node.js >=22.19.0、Git，以及目标系统适用的原生终端模块；不要从 macOS 复制 `node_modules`。启动后访问 `http://127.0.0.1:30141`，单独配置模型授权。默认只监听本机，不安装全局包、服务或开机启动项。

## Pi 终端扩展

```sh
git clone --branch main --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-custom
```

源码克隆不等于扩展已经启用。先准备兼容版本的 Pi，再按各组件 README 在目标机器配置所需扩展路径；不要整份覆盖已有 `~/.pi/agent/settings.json`。Windows 配置中的反斜杠必须按 JSON 规则转义，或使用 `C:/Users/...` 形式。

- 普通聊天、附件、会话与 UI 扩展优先复用宿主能力。Windows 的 Bash 工具需要 Git for Windows；PowerShell 工具按宿主设置选择。
- quiet 包装器需要另外已经安装的 `pi-background-task` / `pi-subagents`，版本合同不因迁移放宽。工具包可定位不代表其后端已经可用：例如 tmux 后端需要 tmux，不能据此宣称能在原生 Windows 跑完整后台终端工作流。
- 子代理的 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` 必须指向**实际宿主**的 coding-agent 包根；不要照抄 Homebrew 路径，也不要为绕过校验换另一份 SDK。
- LSP 仍需预先安装所用语言服务器；Windows 的 npm CLI 用 Node 入口启动，不把 POSIX shim 当可执行程序。未安装服务器时不会自动全局安装。
- Hy-Memory 需要单独准备它自己的服务、已有模型及授权。组件中的 launchd 安装/迁移脚本仍仅用于原 macOS 环境；不在 Windows/Linux 执行。参见[记忆组件说明](../../hy-memory迁移/README.md)。

## 不移植的本机附加项

| 组件 | 边界 |
| --- | --- |
| Pi Bar | macOS 14+ / Apple Silicon 的现有应用 |
| Pi Meta 与正式部署/重启守卫 | 现有 macOS 进程组、私有 socket、launchd 合同；不绕过守卫 |
| Feynman / Hy-Memory | 外部运行时与私有数据不包含在克隆中，必须分别准备 |
| GitHub 每日同步 | 原作者 macOS 的维护任务，不是跨平台安装器；私有目标守卫保留 |

GitHub 仓库当前为公开仓库。原每日同步脚本要求私有仓库，因此会安全停止；不要删除状态、强推、关闭扫描或改用全工作区上传来恢复它。当前跨平台更新只提交公开源码与合成测试数据，不恢复任何聊天、密钥、数据库或系统配置。

## 验证边界

Web 提供 `npm run test:platform`，并在 `pi-web` 推送时用 GitHub Actions 的原生 Windows/Linux runner 安装锁定依赖、运行定向测试及构建。终端扩展的无依赖路径/加载/LSP/桥接 fixture 由 [Extension platform checks](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/extensions.yml) 在两个原生 runner 上检查；完整宿主集成测试仍见各组件 README。查看对应提交的 Actions 结果，不把 macOS 上的 Windows 路径 fixture 当成 Windows 实机验收，也不把源码提交当成已在你的另一台机器安装。
