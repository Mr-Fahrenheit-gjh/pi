# Windows / Linux：运行本仓库的定制 Pi Web

同一份 `pi-web` 分支源码用于 macOS、**原生 Windows** 和 Linux，不另做界面分叉，也不升级依赖。本仓库不提供独立 `.exe`、AppImage 或打包好的 `node_modules`；必须在目标系统用锁文件安装，不能复制 macOS 的原生模块。

## 准备条件

- Node.js **>=22.19.0**、npm、Git。首次建议使用 Node.js 22 LTS。
- Windows：支持 ConPTY 的 Windows 10/11，使用 PowerShell 或 cmd，无需 WSL。Pi 的默认 `bash` 工具需要 Git for Windows 的 Bash；可在设置的「Shell 工具」中选择已有的 PowerShell 工具（直接输入的 `!` / `!!` 命令仍需 Bash）。网页终端默认使用系统 `ComSpec`，与代理的工具设置是两件事。
- Linux：建议 Ubuntu/Debian 等 glibc 发行版；网页终端使用 `$SHELL`，缺省 `/bin/sh`。本次不覆盖 Alpine/musl。
- `node-pty` 若没有适用的预编译包，Linux 需要 Python 3、make、C/C++ 编译器；Windows 需要 Python 及 Visual Studio C++ Build Tools。安装这些系统工具需由使用者另行确认，以下命令不会代装。

## Windows（PowerShell）

```powershell
git clone --branch pi-web --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
cd pi-web-custom
npm.cmd ci
npm.cmd run build
node bin/pi-web.js --no-open
```

## Linux（bash/sh）

```sh
git clone --branch pi-web --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
cd pi-web-custom
npm ci
npm run build
node bin/pi-web.js --no-open
```

打开 `http://127.0.0.1:30141`，在 Models 中单独登录或配置授权。若端口已被占用，用 `node bin/pi-web.js --port 30142 --no-open`，不要停止不明进程。按 Ctrl+C 停止前台实例；本指南不安装系统服务或开机启动项。

不要使用 `npx @agegr/pi-web@latest` 或全局安装官方整包来替代本仓库的定制源码。更新时先保存自己的改动，再拉取本分支，按锁文件重新执行 `npm ci` 和构建；无需更改依赖版本。

## 平台差异与边界

| 能力 | Windows / Linux |
| --- | --- |
| Pi 会话、模型、文件预览、分屏、附件、网页终端 | 使用同一份实现；路径保持目标系统的原生格式 |
| 文件管理器 | Windows Explorer / Linux `xdg-open`；无桌面的 Linux 可直接使用网页文件栏 |
| 内置 Chrome 浏览器 | 使用目标机器已安装的 Chrome/Chromium；自动检查 Windows 系统/用户安装目录与常见 Linux 路径 |
| Chrome 路径覆盖 | `PI_WEB_CHROME_EXECUTABLE` 指向可执行文件本身，不加引号、不附带命令行参数 |
| Pi Bar | 仍为 macOS 应用，不移植 |
| Pi Meta、正式服务重启/部署守卫 | 现有实现依赖 macOS 的私有 socket、进程组与 launchd，**不属于 Windows/Linux 支持范围**；不绕过安全检查 |
| Feynman、Hy-Memory、tmux 后台任务等外接能力 | 不随 Web 克隆自动安装，需各自满足组件运行条件；不能据 Web 可运行推断所有本机插件已可用 |

Chrome 仍由 Web 以独立私有 profile 启动，不连接用户日常浏览器。没有安装 Chrome 不影响普通聊天、文件和终端；无需为了运行 Web 自动安装浏览器。

`PI_CODING_AGENT_DIR` 可选择独立的代理数据目录，默认是当前用户的 `~/.pi/agent`（Windows 为用户主目录下的 `.pi/agent`）。不要复制作者机器的绝对路径、模型授权、会话或系统配置。浏览器若在另一台机器，文件路径仍以运行 Web 的主机为准。

## 定向验证

```sh
npm run test:platform
```

Windows PowerShell 可改用 `npm.cmd run test:platform`。该测试覆盖路径/UNC、附件往返、Chrome 定位、终端、命令环境、CLI 参数与进程退出；GitHub 的 **Windows and Linux** 工作流在两个原生 runner 上分别安装锁定依赖、测试、构建。纯函数中的 Windows fixture 不等于 Windows 实机测试，工作流结果以对应提交的 Actions 状态为准。Pi Meta、外部服务和所有浏览器交互不在该工作流验收范围。
