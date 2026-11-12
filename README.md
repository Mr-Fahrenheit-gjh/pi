# Pi · Pi Web · Pi Bar

个人使用的 Pi 定制源码仓库：保存终端侧扩展、定制网页端和 macOS 菜单栏应用，便于追踪改动、查阅实现和迁移定制能力。

**这是源码同步仓库，不是完整的本机配置备份，也不是一键安装包。** 模型授权、私有设置、聊天记录和运行数据需要另外管理；仓库中的源码也不等于已经在所有宿主中启用。

## Windows / Linux

Pi 与定制 Pi Web 共用源码，现已补充原生 Windows 和 Linux 的路径、附件及扩展加载适配；不重做界面、不升级依赖。运行步骤、组件条件和仍属 macOS 的能力见[跨平台说明](工具/pi-local-runtime/packages/PLATFORMS.md)；Web 的原生系统测试与构建见 [Windows and Linux 工作流](https://github.com/Mr-Fahrenheit-gjh/pi/actions/workflows/platforms.yml)。源码适配不等于所有外接服务或插件已安装、已验证。

Pi Bar、现有 Pi Meta / launchd 部署集成仍仅用于 macOS。仓库当前公开，原「仅私有仓库」每日同步因此停止；本次仅更新公开源码，不放开同步守卫。

## 三个组件

| 组件 | 用途 | 源码入口 |
| --- | --- | --- |
| **Pi** | 终端与代理运行时的本地扩展、工具适配和工程技能 | [`main` 的 `工具/`](工具/) 与 [`.pi/skills/`](.pi/skills/) |
| **Pi Web** | 与 Pi 配合使用的本地浏览器工作台，保留本地界面和交互定制 | [`pi-web` 分支](https://github.com/Mr-Fahrenheit-gjh/pi/tree/pi-web) |
| **Pi Bar** | macOS 菜单栏应用，源码目录名为 `pi-menubar`，应用名为 Pi Menu Bar | [`工具/pi-menubar/`](工具/pi-menubar/) |

日常 Web 入口为 `http://127.0.0.1:30141`。Pi Bar 默认连接同一地址，复用已经打开的 Chrome Pi Web 标签页。

## 分支与目录

### `main`：定制源码快照

从原始工作区的**已提交内容**中按白名单生成，不是原始工作区的完整 Git 历史。每个同步提交会注明对应的工作区提交，便于溯源。

```text
.
├── README.md                         # 由首页文档源同步生成
├── .pi/skills/
│   ├── pi-web-maintenance/            # 定制 Web 维护与发布约束
│   ├── proxy-management/              # 本机代理管理技能
│   └── pstack/                        # 工程技能入口与上游技能
└── 工具/
    ├── pi-menubar/                    # Pi Bar：Swift 源码、协议、测试与图标
    ├── pi-github-sync/                # 本仓库的同步脚本、测试与首页文档源
    ├── pi-local-runtime/packages/     # 浏览器、LSP、记忆及工具配置相关包
    ├── pi-web维护/native-agent-switcher/
    │                                  # 白名单内的维护脚本与源码选择配置
    └── …                              # 其他 Pi 定制扩展，见下表
```

### `pi-web`：定制 Web 源码与历史

保存本机维护配置选中的 Web 工作树的已提交完整历史；此分支根目录就是 Web 项目，不位于 `main/工具/` 下。它不是所有实验工作树或待上线改动的汇总。

两个分支是不同用途的源码树，**不要把 `pi-web` 直接合并进 `main`**。获取源码时建议分目录检出。

## Pi 定制内容导航

| 方向 | 入口与说明 |
| --- | --- |
| 会话标题 | [`pi-auto-title`](工具/pi-auto-title/README.md)：独立标题生成、手动改名保护 |
| 模型请求档位 | [`pi-codex-speed`](工具/pi-codex-speed/README.md)：OpenAI / Codex Fast 开关、请求档位与用量元数据；不保证服务端加速，费用以实际账单为准 |
| 附件与输入 | [`pi-attachment-presentation`](工具/pi-attachment-presentation/README.md)、[`pi-prompt-suggestions`](工具/pi-prompt-suggestions/README.md) |
| 中断与后台会话 | [`pi-interrupt`](工具/pi-interrupt/README.md)、[`pi-tui-session-background`](工具/pi-tui-session-background/README.md)、[`pi-background-task-quiet`](工具/pi-background-task-quiet/README.md) |
| 子代理与恢复 | [`pi-subagents-quiet`](工具/pi-subagents-quiet/README.md)、[`pi-task-recovery`](工具/pi-task-recovery/README.md) |
| 上下文与记忆适配 | [`pi-workflow-integrity`](工具/pi-workflow-integrity/README.md)、[`hy-memory迁移`](工具/hy-memory迁移/README.md) |
| 工程技能 | [`pstack`](.pi/skills/pstack/README.md) |

各目录 README 说明具体加载方式、兼容条件与测试。部分目录保留历史或未启用候选，例如 [`pi-context-cache`](工具/pi-context-cache/README.md)；**不要把“仓库里有代码”当成“当前正在使用”**。旧记录中的版本号和绝对路径也不能直接作为新机器的安装参数。

## Pi Web 定制版

Web 源码保留本地主题与字体、Ghostty 终端、会话分屏、主/子代理会话入口、文件预览，以及 OpenAI API 工作台等定制。功能实现与测试以 [`pi-web` 分支](https://github.com/Mr-Fahrenheit-gjh/pi/tree/pi-web) 为准。

维护原则：

- **Pi 核心和 Pi Web 分开核对、分开升级**；不能用官方最新版整包覆盖本地定制版。
- 优先复用现有设置、组件和扩展接口，迁移上游改动时保留本地合同。
- 源码修改、候选预览、正式发布是不同阶段；提交或同步源码不会自动重建、重载或重启正式服务。
- 当前源码要求 Node.js `>=22.19.0`；依赖版本以 Web 的 `package.json` 与锁文件为准，不因迁移自动升级。

维护约束见 [Pi Web 维护技能](.pi/skills/pi-web-maintenance/SKILL.md)。`main` 仅同步白名单内的维护材料，不包含原工作区全部候选、发布记录和支持文件；技能中提到的本机路径不保证在单独克隆后齐全。

## Pi Bar

Pi Bar 使用系统 Swift / AppKit / SwiftUI 等框架，无第三方包依赖；当前构建目标为 **Apple Silicon、macOS 14+**。

- 查看进行中、待审批、未读会话，并在空余位置补充少量最近会话。
- 与 Web 共用未读状态；点击会话复用已有 Chrome 标签，不另开一个聊天页面。
- 支持 Web 标准审批，以及单独加载终端桥后的 `ask_user_question`；不自动替用户批准。
- 题目无法完整原生呈现、登录不可用或连接失效时，回到网页或终端处理，不猜测答案或自动重发。
- 首次使用通知及 Chrome 控制时，按系统提示确认相应权限。终端桥信任本机同一账户，不提供同账户进程之间的身份隔离。

在已具备系统开发工具的独立检出目录中，可按组件说明做离线测试和候选构建：

```sh
cd pi-custom/工具/pi-menubar
bash test.sh
bash build.sh 'build/Pi Menu Bar.next.app'
```

这只生成候选，不安装终端扩展、不注册开机启动，也不替换正在运行的应用。实际启用前先阅读 [Pi Bar 使用说明](工具/pi-menubar/README.md)、[导航协议](工具/pi-menubar/NavigationProtocol.md)和[未读协议](工具/pi-menubar/UnreadProtocol.md)。

## 获取源码与迁移

以下命令只获取当前公开仓库的源码，不恢复私有配置或运行数据：

```sh
git clone --branch main --single-branch \
  https://github.com/Mr-Fahrenheit-gjh/pi.git pi-custom

git clone --branch pi-web --single-branch \
  https://github.com/Mr-Fahrenheit-gjh/pi.git pi-web-custom
```

迁移到新环境时，按以下顺序核对：

1. **先确认版本和平台。** 分别检查 Pi、Web 的 SDK / 依赖要求，以及 Pi Bar 的 macOS 条件；旧目录名不代表当前安装版本。
2. **逐项恢复所需扩展。** 阅读组件 README，调整本机路径与加载配置；不要整目录覆盖已有 `~/.pi/agent/`。
3. **另行恢复私有配置与授权。** 本仓库不恢复模型密钥、OAuth 登录、MCP 私有配置、系统钥匙串、聊天或记忆数据库。
4. **先做最小测试，再启用。** 已加载的扩展是否需要 `/reload`、新开会话或重建宿主，按该组件说明判断；不把源码检出视为已激活。
5. **Web 单独走定制维护流程。** 先准备独立候选与验证，再按维护守卫发布；不要直接覆盖正式安装或占用已有正式端口。

仅克隆这两个分支，不能恢复原始完整工作区，也不能直接接管原机器的同步任务。原机器的本地快照引用、镜像和调度配置需要另行核对。

## 日常 GitHub 同步

### 手动执行

**当前仓库为公开状态，下面的原私有同步命令会安全停止，不是当前公开跨平台更新的推送入口。** 保留其私有目标和敏感数据守卫；不要直接重试、删除状态或关闭检查。

在**原始完整工作区根目录**执行，不是在上述只用于取源码的克隆目录中执行：

```sh
/opt/homebrew/bin/python3 -B 工具/pi-github-sync/sync.py
```

现有本机用户级 LaunchAgent 在每天本地时间 **10:00** 和登录时触发；休眠错过后由系统补跑，关机或未登录时不运行。仓库包含调度模板，但克隆不会安装任务，也不会唤醒电脑或重启 Web。

同步只读取原仓库已提交内容，不自动暂存其他改动、不切换原分支、不推送标签，也不强推。Web 浅克隆缺失的上游历史只在隔离镜像中补齐，不修改原 Web 共享 Git 数据。

### 查看结果

本地文件位于 `工具/pi-github-sync/data/`：

| 文件 | 用途 |
| --- | --- |
| `status.json` | 最近一次尝试、是否成功、上次成功时间与对应提交 |
| `launch.stdout.log` / `launch.stderr.log` | 定时任务输出 |
| `snapshot.git` / `web-mirror.git` | 本地快照引用、远端一致性检查与完整 Web 历史镜像 |

`data/` 不入库。**不要为了重试同步删除这些引用或清空目录**；它们用于检测远端被改写、分歧或上次中断后的状态。失败时先查具体原因，不能用强推、跳过扫描或关闭私有检查来“修复”。两个分支分别推送，中途失败可能只完成其中一个，应结合状态文件和远端分支核对。

### 更新本页

首页的本地维护源是 [`工具/pi-github-sync/GITHUB-README.md`](工具/pi-github-sync/GITHUB-README.md)。在原始工作区编辑并提交此文件，然后运行同步脚本；脚本会把同一份已提交内容同时保留在工具目录和远端根目录 `README.md`。

不要直接在 GitHub 修改生成的首页，否则会造成远端与本地同步记录不一致。原始工作区自己的根 `README.md` 不会被替换或上传。

离线同步回归测试：

```sh
cd 工具/pi-github-sync
python3 -B -m unittest -v test_sync
```

完整机制见 [同步工具说明](工具/pi-github-sync/README.md)。

## 同步与安全边界

同步范围由脚本白名单决定，不是整个主目录或工作区：

- 仅同步选定的已提交定制源码与 Web 历史；未提交改动、其他项目、候选构建和本地运行记录不纳入快照。
- 不主动采集 `~/.pi/agent/` 下的授权与私有运行配置，也不上传会话 JSONL、记忆数据库、缓存或凭据文件。
- 推送前检查目标仍为指定的可写私有仓库，并扫描源码、Web 历史及提交信息中的敏感路径和常见密钥模式。
- 合成测试值只按经过核验的**精确文件路径与值指纹**放行，不整文件跳过检查；扫描不能证明检出了所有秘密。
- 私有身份无法确认、检测到敏感内容、Git URL 重写或远端历史分歧时停止。首次在新机器启用调度、安装依赖、升级或修改系统配置都需要单独处理。

## 上游与许可

- [Pi](https://github.com/earendil-works/pi)
- [Pi Web](https://github.com/agegr/pi-web)
- Pi Bar 图标原形来自 [pi.dev](https://pi.dev/logo-auto.svg)。

本仓库保存个人定制，不替代上游项目。复用第三方源码、技能或资源时保留原有版权声明，具体许可按对应目录和源文件核对。
