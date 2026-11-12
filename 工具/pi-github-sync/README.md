# Pi 定制源码 GitHub 同步

这是**维护者工具，不是用户安装入口**。它仅允许已批准的可写私有目标；`Mr-Fahrenheit-gjh/pi` 当前公开，因此原每日同步安全停止，私有守卫不会放开。公开版由 `工具/pi-platform-compat` / `工具/pi-platform-web` 隔离维护，不把本机正式发布树直接覆盖到公开分支。

原流程的 `main` 是已提交源码白名单快照（含 Pi Bar），`pi-web` 保留完整 Git 历史；工作区其他项目、未提交改动、聊天、凭据和运行记录都不在范围内。不是整机备份。

用户级 LaunchAgent 每天本地时间 10:00 和登录时执行；休眠错过时在唤醒后补跑，关机或未登录时不运行。任务不会唤醒电脑或重启 Pi Web。联网、Keychain/GitHub 授权及仓库保持私有是同步前提。

入口：`/opt/homebrew/bin/python3 -B 工具/pi-github-sync/sync.py`。脚本本身须先提交；同步不改现有仓库的暂存区、分支或 Web 共享 Git 数据。浅克隆缺失的官方上游历史只在 `data/web-mirror.git` 补齐。

仓库首页的维护源是 [`GITHUB-README.md`](GITHUB-README.md)，按远端仓库根目录布局编写链接。提交后同步，脚本在 `main` 同时保留该源文件并导出根 `README.md`；两处均经过对应路径的内容检查。不读取或替换原工作区的根 `README.md`。不要直接修改 GitHub 生成的首页，以免与本地同步记录分歧。

公开导出边界：`main` 白名单另外排除专属 Pi Meta/Feynman 路径；Web **当前已提交树**一旦包含它们的实现/路由，则在两个分支任何推送前拒绝，不能只删文件而留下坏 import。已有公开历史不重写，仍接受完整历史的凭据扫描。本机正式发布树继续保留这些功能，不修改其发布源配置；若日后恢复自动同步，需另行核对隔离导出源与远端分歧，不删除同步状态或强推。

安全检查覆盖白名单源码及完整 Web 历史的文件、提交信息、敏感路径、常见凭据模式和会话记录；仅对经过核对的合成测试值按路径及内容指纹放行。扫描不是无泄露的证明。远端分歧、私有状态无法确认、疑似敏感数据或 Git URL 重写时停止；推送时再由专用 pre-push 检查旧引用，不强推；失败尝试发送系统通知。

本地状态为 `data/status.json`，任务输出在 `data/launch.stdout.log`、`data/launch.stderr.log`。首次启用 LaunchAgent 前必须先创建权限为 0700 的 `data/`，否则 launchd 无法打开日志；手动运行一次脚本也会创建该目录。`data/` 不入库；其中的镜像和快照引用用于判断远端是否被改写，不要随意删除。源码白名单在 `sync.py` 的 `PI_SOURCE_ROOTS` 和 `pi_source()`；新的定制目录需审核后加入。

离线验证：`cd 工具/pi-github-sync && python3 -B -m unittest -v test_sync`。首次同步、定时任务加载和 GitHub 远端状态需分别核实。
