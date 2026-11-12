# Pi · 定制网页工作台

在浏览器里使用 Pi：选项目、与模型对话、让代理读写代码、查看子代理与产物，也可以同时打开文件、终端和第二段对话。

**这份 README 是安装与操作手册。** 可运行的网页端源码在 **`pi-web` 分支**；`main` 分支主要保存 Pi 扩展与本手册。只想使用网页端，不需要先 Fork GitHub 仓库，也不需要先安装 Pi CLI、MCP、Docker 或菜单栏应用。

公开版不包含 **Pi Meta、Feynman** 的实现、页面或运行入口，不需要作者机器上的私有服务。你的模型账号、API key、聊天和设置由你自己管理；仓库不附送模型额度，也不会恢复作者的配置。

## 目录

- [1. 下载并启动](#1-下载并启动)
- [2. 第一次进入：配模型、选项目、发消息](#2-第一次进入配模型选项目发消息)
- [3. 认识左栏、中间对话和右栏](#3-认识左栏中间对话和右栏)
- [4. Cmd/Ctrl+K 与 Cmd/Ctrl+J](#4-cmdctrlk-与-cmdctrlj)
- [5. Fork、从这里编辑与分屏](#5-fork从这里编辑与分屏)
- [6. 发送、Steer、Queue 与 Stop](#6-发送steerqueue-与-stop)
- [7. 文件、附件、Outputs 与终端](#7-文件附件outputs-与终端)
- [8. 常用快捷键](#8-常用快捷键)
- [9. 更新、备份与常见问题](#9-更新备份与常见问题)
- [10. 可选扩展与源码说明](#10-可选扩展与源码说明)

## 1. 下载并启动

### 先准备什么

| 项目 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js 与 npm | **必需** | 建议 Node.js **22 LTS，至少 22.19.0**。官方安装包自带 npm；安装后重新打开终端 |
| 浏览器 | **必需** | 使用较新的 Chrome、Edge、Firefox 或 Safari 即可 |
| 模型授权 | **要得到真实回复就必需** | 使用你自己的受支持账号或 API key，启动后在网页里配置 |
| Git | 推荐 | 用于下面的克隆、更新、Git diff 与 worktree；只下载 ZIP 不要求先装 Git |
| 本地编译工具 | 按需 | `node-pty` 没有适用预编译包时才需要，见后面的排障说明 |

**不用先配置的东西：** MCP、外部记忆服务、tmux 后台任务、独立 Chrome 自动化、Pi Bar。这些都不是打开网页和开始普通对话的前置条件。

### Windows：推荐下载后双击

1. 安装 [Node.js](https://nodejs.org/)，确认选择包含 npm 的安装方式。
2. [下载网页端 ZIP](https://github.com/Mr-Fahrenheit-gjh/pi/archive/refs/heads/pi-web.zip)，**先解压**，再进入解压后的目录。
3. 确认目录里有 `start.cmd`、`package.json`，然后双击 **`start.cmd`**。
4. 第一次会自动按锁文件安装本项目依赖、构建网页并启动；保持窗口打开，等待浏览器自动打开。

已安装 Git 的用户也可以在 PowerShell 执行：

```powershell
git clone --branch pi-web --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
cd pi-web-custom
.\start.cmd
```

之后仍然双击同一个 `start.cmd` 即可。PowerShell 若提示 `npm.ps1` 无法运行，不必修改系统执行策略：使用 `start.cmd`，或者运行 `npm.cmd start`。

> 不要直接下载默认 `main` 分支的 ZIP 来启动网页端。`main` 是扩展源码目录，不是网页应用；上面的 ZIP 链接已经选好了 `pi-web` 分支。

### Linux / macOS：克隆后启动

```sh
git clone --branch pi-web --single-branch https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
cd pi-web-custom
bash start.sh
```

下次进入同一目录执行 `bash start.sh`，或 `npm start`。Linux 建议使用 Ubuntu/Debian 等 glibc 发行版；Alpine/musl 不在本次验证范围。

### 启动入口会做什么

- 首次运行用 `npm ci` 按 `package-lock.json` 安装**本项目**依赖，再构建和启动；第一次需要联网，可能花几分钟。
- 再次启动会复用已经准备好的依赖与构建，不会每次重新下载、重新编译。
- 更新源码后，按需要重建；锁文件、平台或 Node 原生模块 ABI 变化时，重新准备项目依赖。
- **不全局安装包，不安装 Node、系统编译工具或开机服务，不修改系统配置，不代填模型授权。**
- 首次准备会重建本目录的 `node_modules`。请在独立的解压/克隆目录使用，不要把它接到另一份安装的 `node_modules` 或 `.next` 链接目录上。

默认打开 **http://127.0.0.1:30141**。没有自动打开浏览器时，手动访问此地址即可。启动窗口就是服务进程，使用期间保持打开；关闭网页标签不等于停止服务。

已有程序占用端口时，换一个端口，不要直接结束不明进程：

```powershell
# Windows
.\start.cmd --port 30142
```

```sh
# Linux / macOS
bash start.sh --port 30142
```

要停止服务，先停止正在进行的任务，再在启动窗口按 **Ctrl+C**。下次运行相同入口即可继续使用保存的会话。

## 2. 第一次进入：配模型、选项目、发消息

### 第一步：配置自己的模型

1. 打开左下角 **Settings → Models**。
2. 点 **Add provider**，选择实际使用的模型提供商。
3. 按该提供商支持的方式授权：
   - **账号 / OAuth**：点 **Login**，按提示在提供商网页批准。有的流程需要设备码，有的需要把回跳地址或代码粘回网页。
   - **API key**：输入自己的 key 后点 **Save**，确认出现 **Saved** 或相应已授权状态。
4. 回到对话页，在输入框下方的模型按钮里选择可用模型。

不是每家提供商都支持订阅登录；聊天订阅和 API 额度也不是一回事。网页能打开但没有回复时，先确认这里的授权、启用模型和额度，而不是反复重装网页端。

如果页面先要求 `Password / Log in`，那是这台 Web 服务设置的**访问密码**，不是模型 API key；没有配置 `PI_WEB_PASSWORD` 的默认本机实例不需要这一步。

### 第二步：选择工作目录

在新会话输入框下方打开项目选择器，使用 **Open another project… / Custom path…** 选择目录；不确定时可先选默认目录。目录是代理读写文件、运行命令的工作位置。

- 运行 Web 和浏览器在同一台电脑时，选本机项目目录。
- 如果浏览器连接的是另一台服务器，选择的是**服务器上的目录**，不是浏览器这台电脑的文件夹。
- 新会话切换项目会带上当前草稿；已有会话仍属于原来的工作目录，不是靠切一下项目选择器就迁移它。

若出现 **Restricted mode / Trust project**，先核对目录和项目声明的 MCP、扩展等资源。只信任你了解的项目；不信任也可以先保持受限模式。

### 第三步：发第一条消息

先试一句不需要工具的话，确认授权正常；再让代理做项目工作，例如：

```text
先阅读这个项目的 README 和入口文件，解释项目如何启动。
不要修改文件，先列出你确认过的步骤。
```

模型按钮旁边可以选择工具范围。`chat-only` 只聊天，`read-only` 适合先检查项目，`default / full` 可以包含写文件、执行命令等能力。**工具选择不是操作系统沙箱**，不要把高权限运行的服务交给不信任的输入或项目。

## 3. 认识左栏、中间对话和右栏

| 区域 | 主要用途 | 怎么打开 |
| --- | --- | --- |
| 左栏 | 项目、历史会话、New、Search，以及可选的 Document 文件树 | 左上角侧栏按钮 |
| 中间 | 当前对话、消息、输入框、模型与发送控制 | 点击左栏会话或新建 |
| 右栏 | Tasks、Sub-agents、Outputs、打开的文件和终端 | 右上角文件面板按钮，或点开文件/终端 |

### 左栏怎么用

- **New**：新建空白对话，不会自动复制当前上下文。
- **Search**：搜索会话与文件，相当于 Cmd/Ctrl+J。
- 点项目组末尾的箭头：展开/收起该项目的会话。
- 点会话：打开历史；会话行的 pin 和 `⋯` 菜单可用于固定、改名、Fork、归档等操作。
- 会话 pin 会把它放进 **Pinned**；这与“让整个左栏固定展开”不是一回事。

桌面上，左栏折叠时把鼠标移到左上角开关，可临时预览；点击开关才会固定展开或取消固定。临时预览移出后关闭。触屏设备直接点击，不依赖 hover。

### Document 文件树在哪里

在 **Settings → General → File browser** 选择：

- **Below sessions**：文件树放在会话列表下面。
- **Separate tab**：文件树独立成标签。
- **Hidden**：隐藏文件树。

所以“找不到 Document”可能只是设置成了 Hidden。**Document 是左侧文件入口；点开的文件显示在右栏，不是把 Document 当成右栏第四个永久标签。**

### 右栏怎么看

选中会话后，右栏有三个常驻入口：

- **Tasks**：看当前会话通过任务工具记录的清单；没有记录时为空。
- **Sub-agents**：看当前会话的子代理及具体运行记录。这里用于查看，不会把主输入框变成给子代理发消息的输入框。
- **Outputs**：看本分支记录到的写入/编辑文件与交付链接；不是整个项目文件夹，也不保证收集了所有 Bash 生成物。

点文件后会出现文档标签，打开终端也会出现终端标签。可拖动边界调节右栏宽度，并使用顶部的全宽/还原控制。

右上角开关同样支持桌面临时 hover 预览与点击固定。**右栏和“双对话分屏”是两种功能**，打开右栏并不会自动打开第二个对话。

## 4. Cmd/Ctrl+K 与 Cmd/Ctrl+J

这里的 **Cmd** 用于 macOS，Windows/Linux 用 **Ctrl**。先让焦点位于网页内；终端和已经打开的弹窗会保留自己的快捷键。

### Cmd/Ctrl+K：找操作

打开的是 **Command / Search commands…**，不是聊天全文搜索。可以搜索并执行当前状态下可用的动作，例如：

- `New conversation in this project`：在当前项目新建对话。
- `Open project terminal`：打开活动对话目录下的终端。
- `Files from this conversation`：直接打开当前会话的 Outputs。
- `Rename this conversation`：改名。
- `Fork this conversation`：复制为独立会话。
- `Split conversation / Close split`：打开/关闭桌面双对话分屏。

某些操作需要已选择项目或已保存会话；条件不满足时，不会出现或不能执行。命令面板不会把你输入的任意文字当成 shell 命令交给系统执行。

### Cmd/Ctrl+J：找历史和文件

打开的是 **Chat / Search conversations and files…**。

- 空查询时看近期会话；输入关键字可查会话标题、正文和具体消息命中。
- 会话搜索可跨项目并包含归档，不仅仅查当前对话。
- 文件搜索范围是当前项目目录，不是扫描整台电脑。
- 选中会话/消息结果会跳转到对应位置；选中文件会打开右侧查看器。

### 面板里怎么选

上下箭头移动，**Enter** 打开，**Esc** 关闭。每页最多 9 项；PageUp/PageDown 翻页，查询为空时也可用左右箭头翻页。

- 查询框完全为空时，按 **1–9** 直接选当前页对应项。
- 已输入查询（包括空格）时，数字保留作输入；要直选，用 **Alt/Option+1–9**。

这些数字快捷键只在搜索面板里生效，不是整个页面随时按数字就切会话。

## 5. Fork、从这里编辑与分屏

### 整段上下文换个方向：Fork 当前对话

1. 在左栏找到会话，点 `⋯ → Fork`；或者在当前对话按 Cmd/Ctrl+K，选 **Fork this conversation**。
2. 等待新会话打开；名字会带一个短后缀，方便与来源区分。
3. 在新会话继续尝试另一种思路，来源会话保持不变。

它复制当前会话分支到**独立会话**，不会自动发新消息，也不会复制 pin/归档状态。

### 从某一条消息开始：New session

把鼠标移到某条用户消息上，点 **New session**。它从该消息位置复制为一个新的独立会话，不一定包含来源后面的整段对话。未保存或当前状态不允许时，先等待会话稳定再操作。

### 修改之前一句话：Edit from here

在用户消息上点 **Edit from here**，文本会回到输入框。修改后发送，会在**同一个会话的历史树**内建立另一条分支；旧记录保留，不是直接覆写原消息。分支导航用于查看同一会话的不同路径。

| 操作 | 是否新会话 | 是否复制/回退项目文件 |
| --- | --- | --- |
| 左栏 Fork / K 中 Fork | 是，复制当前分支 | 否 |
| 消息上的 New session | 是，从该处开始 | 否 |
| Edit from here | 否，同一会话树内分支 | 否 |
| Split conversation | 只是并排显示两段对话 | 否 |

**分叉聊天不会撤销已经执行的命令或改过的文件。** 要让两种实现使用不同代码目录，应另用 Git 分支/worktree，而不是只 Fork 会话。

### 桌面双对话分屏

1. 打开一段对话，按 Cmd/Ctrl+K → **Split conversation**。
2. 右半边出现 **Open a conversation alongside**。
3. 点 **New conversation**，或从 **Previous conversations** 搜索并选择另一段历史。
4. 想让左栏/搜索作用于哪一半，先点击那一半，让它成为活动对话。
5. 拖中间分隔线调比例，双击可等分；按 K → **Close split** 关闭。

不是 Shift+点击会话，也不是把会话拖到右栏。此功能面向桌面布局，手机上不提供同样的并排界面。

## 6. 发送、Steer、Queue 与 Stop

- **发送**：点输入框内的发送箭头。桌面可在 Settings → General 选择 Enter 或 Cmd/Ctrl+Enter 发送；Shift+Enter 换行。手机通常用 Enter 换行，再点发送按钮。
- **Steer**：运行中给当前任务补充要求、调整方向。实际插入/中断时机受宿主与扩展实现影响，不要把它当成必然立即撤回正在执行的命令。
- **Queue / follow-up**：先排队，等当前轮结束后再处理，适合“做完这一件，再做下一件”。不是定时任务，也不会另建会话。
- **Stop**：明确停止当前工作。Esc 没有被菜单、输入法或其他控件占用时也可停止；有弹窗时通常先关弹窗。

输入法确认候选字、`@` 补全或 slash 菜单可能先消费 Enter，这是正常的，不应连续多按导致重复发送。运行中先看输入框当前显示的发送模式，再决定是调整本轮还是排下一轮。

## 7. 文件、附件、Outputs 与终端

### 引用项目已有文件：用 @

在输入框输入 `@`，选择匹配的文件/目录，使用上下键和 Tab/Enter 完成引用。例如：

```text
请阅读 @src/main.ts ，先解释调用关系，不要修改。
```

手动 `@` 引用告诉模型文件位置，**不会上传或复制文件**。模型能否读取、如何解析文件，还取决于当前工具和格式支持。

### 从电脑加入聊天：用 + 或拖放

点输入框 **+ → Upload or add files**，或把文件拖到聊天区域：

- 图片作为图片附件；需要所选模型支持图片。
- 非图片保存到运行 Web 那台机器的私有聊天附件目录，显示为附件卡片，不自动写进项目根目录。
- 单文件上限 **25 MB**，一次选择总计 **100 MB**。

浏览器不能凭上传恢复你电脑上原文件的绝对路径。预览支持某种格式，也不等于所有模型都能直接理解该格式。

### 真正上传到项目：用文件栏的 Upload files

Document 文件区的 **Upload files** 才是项目上传。它与聊天附件分开；遇到同名文件按提示处理。成功上传后，如要让模型使用，可再点 **Add uploaded file to chat / Add all uploaded files to chat**。

### 在右栏阅读文件和产物

点左侧文件、聊天中的文件链接或 Outputs 中的文件，会在右栏打开。按格式提供预览、源码、下载等入口；不是每种文件都能直接编辑。文件不存在或超出允许范围时会提示错误，不要把 Outputs 中有一个路径理解成一定能打开它。

### 打开真实终端

- 点左下角 Settings 右侧的终端图标，打开当前侧栏工作目录的终端。
- 或按 Cmd/Ctrl+K → **Open project terminal**，打开活动对话目录的终端。

终端是实际 shell，输入的是系统命令，不是发给模型的提示词。快捷键由终端优先处理。

Windows 网页终端默认使用系统 `ComSpec`；代理执行 Bash 工具需要 Git for Windows 的 Bash，也可在设置的 **Shell 工具** 中选择 PowerShell。直接输入的 `!` / `!!` 仍需 Bash。Linux 使用 `$SHELL`，缺省 `/bin/sh`。

## 8. 常用快捷键

| 场景 | macOS | Windows / Linux |
| --- | --- | --- |
| 命令面板 | Cmd+K | Ctrl+K |
| 会话/消息/项目文件搜索 | Cmd+J | Ctrl+J |
| 当前项目新建会话 | Ctrl+Alt+N | Ctrl+Alt+N |
| 搜索面板移动 / 打开 | ↑↓ / Enter | ↑↓ / Enter |
| 搜索面板空查询直选 | 1–9 | 1–9 |
| 搜索面板有查询时直选 | Option+1–9 | Alt+1–9 |
| 搜索结果翻页 | PageUp / PageDown | PageUp / PageDown |
| 输入框换行 | Shift+Enter | Shift+Enter |
| 按设置发送 | Enter 或 Cmd+Enter | Enter 或 Ctrl+Enter |
| 关闭最近菜单/弹窗，未被占用时停止任务 | Esc | Esc |

终端、已有对话框和输入法有各自的键盘处理。若 K/J 没打开面板，先点击普通对话区域再试，不要在浏览器地址栏或另一个弹窗里按。

## 9. 更新、备份与常见问题

### 如何更新

Git 克隆的用户先停止当前服务，再在源码目录运行：

```sh
git pull --ff-only
```

然后照常用 `start.cmd`、`bash start.sh` 或 `npm start` 启动，入口会按需要准备依赖、重建。若 Git 提示本地有修改，先保存自己的改动，不要用强制 reset 清空。

ZIP 用户重新下载 `pi-web` ZIP，解压到新的独立目录后启动。默认会话与授权不在源码目录里；使用自定义数据目录的，更新时继续指定同一目录。

**不要用 `npm update`、`npx @agegr/pi-web@latest` 或 `pi-web update` 更新这份定制版**，那不是这里的源码更新方式。便捷入口默认关闭上游 npm 版本检查。

### 数据在哪里，怎么备份

默认在当前用户的 `~/.pi/agent`，Windows 对应用户主目录下的 `.pi\agent`。这里可能含授权与私密会话，备份到你自己信任的本地位置，**不要上传到 GitHub 或当排障附件公开发出**。

`PI_CODING_AGENT_DIR` 可指定独立数据目录。仅更换 HTTP 端口不会自动隔离会话数据；不要让不同版本同时操作同一段活跃会话。

### 常见问题

| 现象 | 先这样处理 |
| --- | --- |
| 下载后没有 start.cmd / package.json | 检查是否下载了 `pi-web` 分支，而不是默认 `main`；先解压，不在 ZIP 内直接运行 |
| 找不到 node，或版本过旧 | 安装/选择 Node.js 22 LTS，至少 22.19.0；重新打开终端，用 `node --version`、`npm --version` 检查 |
| npm.ps1 被 PowerShell 限制 | 使用 `start.cmd` 或 `npm.cmd start`，不必调整系统执行策略 |
| 第一次安装卡住 / npm 网络报错 | 看启动窗口最先出现的错误；确认可访问 npm/GitHub。网络恢复后重跑同一入口，不必删除会话数据 |
| node-pty 原生模块编译失败 | Windows 按错误准备 Python 3 与 Visual Studio C++ Build Tools；Debian/Ubuntu 通常需 Python 3、make、C/C++ 编译器。准备好后重跑；入口不会替你安装系统工具 |
| 提示初始化锁被占用 | 先确认另一个启动窗口是否仍在安装/构建；若此前强制中断，确认相关进程已停止后，才删除源码目录的 `.pi-web-setup.lock` 再试 |
| 30141 被占用 | 使用 `--port 30142`，或在你确认身份的旧启动窗口停止旧实例；不要随便杀进程 |
| 页面能开但没有模型回复 | 检查 Settings → Models 的授权、启用模型及提供商额度；Web 密码不是模型 key |
| K 搜不到说过的话 | K 找命令，J 找历史消息和项目文件 |
| Fork 后文件没有回到旧状态 | Fork 只分叉会话，不回退代码；文件版本用 Git 管理 |
| 找不到文件栏 | Settings → General → File browser，检查是否选了 Hidden |
| 聊天上传后项目目录没出现文件 | 聊天附件不写项目根目录；项目上传走 Document 的 Upload files |
| Steer / Queue 没马上执行 | 先确认发送模式；需要明确中止用 Stop，不要连续重复发送 |
| 改源码后怀疑构建没更新 | 用 `start.cmd --rebuild` 或 `bash start.sh --rebuild` 强制重建后启动，不必重装全局包 |

只读检查准备状态，不安装、不构建：

```sh
node bin/start-custom.js --doctor
```

只准备依赖与构建，暂不启动服务：

```sh
node bin/start-custom.js --prepare
```

默认只监听本机。不要为了“方便访问”直接把无密码、可执行工具的代理开放到公网；远程使用应先安排 HTTPS / 可信 VPN 与访问鉴权。

## 10. 可选扩展与源码说明

### GitHub Fork 与对话 Fork 不是一回事

**只想使用，无需先 Fork GitHub。** 上面的克隆或 ZIP 即可。

想在自己的 GitHub 保存改动时，点仓库右上角 **Fork**。创建时不要只复制 `main`，要让自己的仓库包含 **`pi-web` 分支**；创建后先确认该分支存在，再把安装命令中的仓库地址换成自己的地址。网页里的对话 Fork 只创建聊天分支，不会创建 GitHub 仓库，也不会提交代码。

### 可选功能

- **MCP**：Settings → MCP → Add MCP。按需要单独准备服务器/程序、配置范围及授权；stdio 服务在运行 Web 的主机执行，不是聊天前置依赖。
- **Git worktree**：在 Git 项目的工作树菜单选 New worktree…，用于让不同实现操作不同 checkout；普通目录不要求使用它。
- **Pi 终端扩展**：在 [`main/工具`](https://github.com/Mr-Fahrenheit-gjh/pi/tree/main/工具) 按组件 README 逐项安装/启用。网页能运行不代表作者的记忆、后台终端、所有插件已经随包启用。
- **Pi Bar**：[`main/工具/pi-menubar`](https://github.com/Mr-Fahrenheit-gjh/pi/tree/main/工具/pi-menubar)，现有 macOS 菜单栏应用；Windows/Linux 使用网页即可，不依赖它。
- **独立浏览器能力**：需要运行 Web 的机器已安装 Chrome/Chromium；普通聊天不需要。非标准安装可用 `PI_WEB_CHROME_EXECUTABLE` 指定可执行文件。

### 验证与许可

[Windows and Linux](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/platforms.yml) 工作流在两个原生系统上检查公开版边界、便捷初始化、定向测试和真实 HTTP 启动；[扩展平台检查](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/extensions.yml) 检查所列扩展的路径/加载合成用例。以对应提交的运行结果为准，不把源码检出、模拟路径或单次构建当成所有外部服务都已验证。

上游：[Pi](https://github.com/earendil-works/pi) · [Pi Web](https://github.com/agegr/pi-web)。本仓库保存个人定制；第三方代码、字体与资源的许可按对应文件和来源声明执行。
