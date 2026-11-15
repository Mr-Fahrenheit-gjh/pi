# TUI 会话切换后台保活

修复 Pi TUI 在 `/new`、快捷键新建、`/resume` 切换时主动 abort/shutdown/dispose 原会话的问题。**已获明确授权并启用到全局 CLI，独立真实 PTY 验收通过；已有窗口不会热更新，正常重开后生效。**

## 行为

- 切换只停靠前台视图。原模型请求、工具、重试、压缩与队列继续运行，写回原会话。
- 返回时复用同一 AgentSession、services 和扩展 runtime，不重新执行工具，不重复 `session_start` 或 MCP 发现。
- 各会话拥有独立草稿、流式状态、待完成工具、扩展状态和输入监听；后台 UI 不写入其他会话。
- 后台确认/选择/自定义弹窗等用户操作等待回到所属会话；不自动授权。已有活动弹窗、交互式 `!` shell 或 reload 时拒绝切换，不销毁交互。**模型调用的 bash 工具可以后台运行**。
- 退出整个 TUI 才取消所有驻留会话。先解除交互等待，再并行执行 abort/shutdown；不配合的清理最多等待 2 秒，随后 dispose 并报告错误。
- `/fork`、导入仍采用原有破坏性生命周期；非 TUI 的 SDK/Web runtime 不启用此适配器。

## 文件

- `background.mjs`：TUI 专属会话槽位、UI/快捷键隔离、停靠/恢复、reload 和退出清理。
- `install.mjs`：精确支持 `@earendil-works/pi-coding-agent@1.4.0` / `1.5.0`，同步适配 SDK TUI 与实际 CLI bundle；拒绝未知输入形状，幂等安装、保存校验备份、受保护回退。
- `background.test.mjs`：实际 AgentSession/SessionManager/runtime、faux 模型、工具和临时候选验证。
- `smoke.mjs` / `activation.json`：实际已安装 bundle 的真实独立 PTY、faux provider 验收脚本与脱敏结果。
- `verification.md`：本次验证与边界。

不替换整个 SDK，不新增依赖，不升级版本。不依赖工作区绝对路径运行：激活时把适配器复制到目标 SDK 的 `dist/`。保留现有 interrupt adapter 的首尾形状，并有共存回归检查。

## 验证

从工作区根目录运行：

```sh
node --test 工具/pi-tui-session-background/background.test.mjs 工具/pi-tui-session-background/composition.test.mjs
node --check 工具/pi-tui-session-background/background.mjs
node --check 工具/pi-tui-session-background/install.mjs
```

`composition.test.mjs` 在独立副本中按恢复 → interrupt → 附件 → TUI 后台重放两遍，并对普通模块 / 真实 CLI chunks 做最终验真和未知字节拒绝测试；附件原件已由后装后台补丁改变时，仍要求精确组合字节。TUI 安装检查从带指纹备份完整重建当前文件，不以 marker 存在冒充验证。后台 faux 测试也覆盖 A 停靠后 steer 的完整 settled 与 B 隔离。

1.5 的测试证据仅针对独立临时副本，不代表当前全局 CLI、Web 或既有进程已升级。编辑器测试需要 CLI 的 nested pi-tui 布局；不会让附件安装器写到 SDK 外的 hoisted 包。

测试复制 SDK `dist/` 到 `/tmp`，只读取现有依赖，在临时目录安装/检查/回退并于结束清理；不会改全局安装，也不访问真实模型或凭据。`PI_TUI_TEST_SDK` 可指定同版本 SDK 根目录。

## 激活 / 重放（须有当轮用户确认）

先重新确认实际 `pi` 的安装路径、版本和并行维护状态，再运行：

```sh
node 工具/pi-tui-session-background/install.mjs \
  --sdk /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  --apply --allow-external
node 工具/pi-tui-session-background/install.mjs \
  --sdk /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent --check
```

这只修改磁盘上的 TUI 代码，**不会热更新已打开的 TUI，也不重启 30141**。现有任务结束后正常重新打开 `pi`；在新的 TUI 验收“运行 A → 新建 B 并执行任务 → 返回 A”。不得强制关闭尚有任务的旧进程来加载补丁。

实际独立终端验收（无真实模型，需自己的 PTY，不占用用户现有终端）：

```sh
node 工具/pi-tui-session-background/smoke.mjs
```

脚本先核实实际安装与源码相符，结果路径打印到终端；可用 `PI_TUI_SMOKE_RESULT` 指定结果文件。既有补丁的安装后回归会仅在临时副本中恢复首次激活备份，再测试安装/回退，绝不回退真实安装；若最新回执只含增量更新，使用 `PI_TUI_TEST_SDK` 指定未打本补丁的同版本 SDK。

## 回退

获得确认后，对同一 SDK 运行：

```sh
node 工具/pi-tui-session-background/install.mjs \
  --sdk /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  --rollback --allow-external
```

备份和校验回执在目标 SDK 的 `dist/pi-tui-session-background-backup/`。回退只接受与最后激活回执完全一致的文件；若其他对话后来补丁改动了同一文件，会拒绝覆盖，必须先协调维护，不可硬拷旧文件。幂等重复 apply 不覆盖回退回执。回退后同样需要正常重新打开 TUI。

## 边界

- 保活限于同一存活进程；关闭终端/退出 Pi 不是持久后台守护服务。
- 保留已打开会话会增加内存、连接和扩展资源占用；不静默淘汰运行中的会话。同目录任务也不是工作树隔离。
- scoped UI 保护正常 `ctx.ui` 与快捷键上下文，不是第三方扩展沙箱。直接保存裸 TUI、操作 stdout/process 全局变量或模块单例的扩展仍需单独验证；未宣称本机所有扩展透明兼容。
- 目前按精确版本适配部分内部接口；升级或源形状改变须重新验证，不能直接重放到新版本。
