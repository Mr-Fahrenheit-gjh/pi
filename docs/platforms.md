# 平台与启动细节

完整安装与操作手册见 [README](../README.md)，包含 Windows 双击启动、首次模型授权、Fork、快捷键与左右栏。不要使用上游 npm 最新版替代这个定制分支。

## 推荐入口

| 系统 | 下载后运行 | 需要准备 |
| --- | --- | --- |
| Windows 10/11（原生） | 双击 `start.cmd`，或 PowerShell 中 `.\start.cmd` | Node.js >=22.19.0（含 npm）；代理 Bash 工具另需 Git for Windows，或按设置选择 PowerShell |
| Linux（glibc） | `bash start.sh` | Node.js >=22.19.0（含 npm）；终端使用 `$SHELL` / `/bin/sh` |
| macOS | `bash start.sh` | Node.js >=22.19.0（含 npm）；Pi Bar 是可选组件，不影响网页启动 |

启动入口会按锁文件准备本目录依赖、构建并启动；第二次复用准备结果。源码变化重建，锁文件/平台/Node原生ABI变化重新准备依赖。依赖与构建保存在当前克隆目录，npm 也会使用自己的用户缓存；不做全局安装，不安装系统服务。

直接从这里下载的 ZIP 已选中正确分支：

https://github.com/Mr-Fahrenheit-gjh/pi/archive/refs/heads/pi-web.zip

解压后应看见 `package.json`、`start.cmd` 与 `start.sh`。默认 `main` 是扩展源码，不是可运行的网页目录。

## 入口参数

```sh
# 默认启动并打开浏览器
npm start
# Windows PowerShell 可用 npm.cmd start

# 换端口，不替换已有服务
node bin/start-custom.js --port 30142

# 不自动打开浏览器
node bin/start-custom.js --no-open

# 只读检查，不安装/构建
node bin/start-custom.js --doctor

# 只准备依赖与生产构建
node bin/start-custom.js --prepare

# 强制重建后启动，不无条件重装依赖
node bin/start-custom.js --rebuild
```

`start.cmd`、`start.sh` 都可转交这些参数。初始化信息只存在本目录被 Git 忽略的 `.pi-web-start.json`；初始化锁为 `.pi-web-setup.lock`，不能在另一个安装/构建仍运行时删除。依赖或 `.next` 是链接目录时，便捷入口会拒绝改写，以免损坏其他安装。

首次准备失败先处理输出中的实际问题，再重跑入口；不要删除 `~/.pi/agent` 的授权或聊天来重试构建。默认只监听 `127.0.0.1`，浏览器关闭并不会停止服务，结束使用前在启动窗口 Ctrl+C。

## 原生依赖与可选功能

`node_modules` 含目标系统的原生模块，不能从 macOS 整包复制到 Windows/Linux。安装缺少适用的 `node-pty` 预编译包时，可能需要本机构建工具：Windows 为 Python 3 + Visual Studio C++ Build Tools；Ubuntu/Debian 为 Python 3、make、C/C++ 编译器。由用户自行安装系统工具，本入口不会自动代装。

没有桌面的 Linux 仍可用网页文件栏；`xdg-open` 文件管理器功能需要桌面环境。普通聊天无需 Chrome；独立浏览器功能才需要本机 Chrome/Chromium，非标准路径用 `PI_WEB_CHROME_EXECUTABLE` 指定可执行文件本身。

公开版只提供 Pi 主运行时，不包含 Pi Meta / Feynman、原机器 launchd 部署控制或它们的私有环境。MCP、Hy-Memory、tmux 后台终端与其他插件不自动安装，也不是首次使用的前置条件。不会复制作者模型、密钥、代理地址或系统配置。

模型数据默认位于当前用户 `~/.pi/agent`，Windows 位于用户主目录的 `.pi/agent`。可用 `PI_CODING_AGENT_DIR` 选择独立数据目录。服务跑在哪台机器，工作目录和文件路径就属于哪台机器。

## 验证入口

```sh
node --test lib/start-custom.test.mjs lib/public-distribution.test.mjs
npm run test:platform
node e2e/public-start.mjs
```

最后一项需先完成 `--prepare`；它用独立临时代理目录，通过 `start.cmd` / `start.sh` 启动已有构建，访问首页与会话 API，确认不包含的运行时路由为 404，随后停止自己的进程树，不调用模型。GitHub 的 [Windows and Linux](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/platforms.yml) 在两个原生 runner 执行；以对应提交的实际结果为准。
