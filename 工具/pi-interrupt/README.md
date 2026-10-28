# 用户 steer：中断、完整 settled、自动续跑

> 当前状态（2026-10-19补核）：已完成本机统一激活并补齐清单。正式Web、全局CLI、独立Feynman的SDK core/bundle/vendored engine，以及两处npm factory适配只读检查均通过；正式30141已重启并验收通过。激活备份见 `.evidence/unified-activation-backup.json`。以下“未启用”指原候选交付阶段；不据此宣称未重开的旧CLI进程或Herdr/外部runner已加载。

## 范围与当前激活边界

用户/父代理发出的 `steer()`、`prompt(..., {streamingBehavior:'steer'})` 和 extension `sendUserMessage(..., {deliverAs:'steer'})` 共用一个 AgentSession 事务。Web 父会话、内置孩子在各自 SDK class 上安装；`pi-subagents-quiet/index.ts` 给进程内 npm child factory 使用的 SDK class 安装同一策略。

**源码实现不等于正式进程已经加载。** 本轮没有改全局 node_modules、外部配置、依赖版本或正式30141。全局 CLI/TUI/RPC、Web 内嵌 SDK 和 detached npm runner 必须按下述步骤分别确认安装身份与激活。Herdr/外部 native runner 没有经过本机协议验证，仍在覆盖边界之外；不能称为“全机已启用”。

`follow_up` / `followUp` 原样排队。普通 custom 通知、低层 `agent.steer` 和内部预算指令不硬中断。显式 Stop、deadline、dispose 仍结束任务，不自动复活。新用户输入不撤销工具已经造成的外部副作用。

## 当前候选（未启用）

候选保存在本目录 `.candidate/package`，只包含定制源码基线与本任务改动，不混入其他未提交功能。证据在 `.evidence/validation.json`，构建为 `bIZGE5b_otFAyQdYP0cTk`。两目录均不入库。

- 全量测试2882项通过、1项跳过、0失败；core及实际bundle各30项专项通过。
- TypeScript、构建通过；lint无错误，保留1项既有e2e警告。安装器及扩展23项、维护脚本46项通过。
- 独立审查最终为OK。1440px桌面实包验证通过，输入发送为steer；浏览器传输为模拟，真正的引擎行为由SDK假provider测试验证，未调用真实模型。
- 本任务无版本或依赖变更。CLI、全局factory及正式30141仍未切换，后续须确认激活及重启授权，并沿正式发布守卫完成上线验收。
- 已登记共享[待上线条目](../pi-web维护/待上线/99bff5f4-6b2b-4a7a-b7e7-3482573afaec.json)。登记不是上线授权，本轮停在待上线。

## 数据结构与设计取舍

- `InterruptState`：`phase`（idle/cancelling/submitting/running/stopped/disposed）、取消 `epoch`、按到达顺序的 `pending`、当前 `batch`、逻辑 `task`、物理 settled `boundary` 和有界请求记录。
- `InterruptRequest`：独立 `id`、`epoch`、`source`、原始 `original`、只预处理一次的 `payload`（完整 text/images）、状态和错误。状态区分 preparing / accepted / delivered / handled / failed / cancelled。
- 非模型 `pi-interrupt` session custom entry 保存 accepted/失败/取消的完整 payload；`get_state.interruptSteer` 只返回最近50条状态、输入长度/附件数量和 `recoveryEntryId`，不返回正文或图片。终结请求释放事务中的 original/payload，恢复资料留在 session entries。加载历史**不**自动重放旧请求；失败/取消由用户核对后重发，避免副作用重复。admission journal 写入失败则拒绝、不取消旧 run，此时调用方须保留原输入；后续落盘失败在状态中保留 `journalError`，不能阻止 Stop。

入口各自实现容易漏掉 SDK prompt 的直接 `_queueSteer`、extension user-message 和孩子生命周期；直接替换全部 `agent.steer` 又会打断内部控制。故采用最小共享边界：原 SDK 完成命令分派、input handler、skill/template 展开后，只替换用户 `_queueSteer` 与 idle steer 的 `_startRun` admission；保留原输入、角色、附件和 slash-command 规则。普通 prompt 增加取消 epoch，避免 Stop 后异步 preflight 又启动旧输入。

同一次取消尚未 settled 时到达的输入按顺序收集，在一次新 run 中以**独立 user messages**提交；不合并文本、不丢附件。等待原 agent/tool 结束及 awaited extension `agent_settled` 完成，而非只等 `agent_end` 或表面 `isIdle`。在 before_agent_start 准备期间到达的输入仍加入同一批。新 run 开始后再来的 steer 会再次取消。未 settled 不另起并发 run，也不以超时冒充工具取消完成。

## 生命周期接点

权威 engine 是 Web 源码 `../pi-web维护/pi-web-source-0.12.1-custom/lib/interrupt-steer.mjs`（带 `.d.mts`）。安装器把实际字节复制到目标 SDK `dist/pi-interrupt-engine.mjs`，core 和 bundled CLI 同时导入该副本；运行时不依赖工作区绝对路径。双份模块共享进程 registry，避免 Web 源码与 vendored SDK 各自持有不同状态。

- 旧物理 run 的完整扩展 settled 回调仍执行；有待替换输入时，暂不向公开 subscribers 发布终局 `agent_settled`。最终物理 run 才发布终局；原始 prompt promise 一直持有同一个逻辑任务，所以 child 不会在中途生成 receipt/结算或 dispose。最终 `interrupt_steer_end` 让 Web 在事务忙标记解除后检查通知和 idle cleanup。
- 取消/准备阶段原 steering/follow-up queue 的 `drain()` 暂停，原消息对象保留在原队列；不做 text-only 清空重建，重启后的 steer 在 follow-up 之前。
- `apply-subagents.mjs` 给已核实0.75.0 child factory 的 `hasQueuedMessages` 增加事务忙状态，防止 foreground/background 的 final-drain grace timer 提前处置尚在 input/preflight 的 steer。初始 prompt promise 延长与队列观察必须成对存在。
- Web MCP/UI 尚未进入 SDK 的等待先撤回；旧未发送 draft 返回拒绝，新输入重新走 admission/MCP。Stop epoch 撤销仍在等待 admission 的请求；没有绕过 MCP 或将旧输入自动恢复。
- Web 内置 child 累计 turn limit 保留在逻辑任务上；替换提交前检查同一累计预算，内部 wrap-up 指令走 `queueInternalSteer`，不能用硬中断重置/绕过限制。限额未发送输入仍在错误/事务记录中，不跨 resume 偷偷投递。
- 替换取消复用1.3.0 abort primitives，但不调用 public `abort()` 的 task-recovery Stop 标记；显式 Stop 仍调用原 public abort。Stop/dispose 的最后检查放在 SDK 清理 try/finally 内的 agent.prompt 边界，不能从未受保护的 onStarted 回调抛错。
- settled 中启动的嵌套物理 follow-up 不等待自己的祖先逻辑事务；有待替换用户输入时，已预处理的 follow-up 留在原队列，等 steer 先提交。外层仍等待完整回调。
- manual compaction 中的 prompt-steer 先保留 command/input-handler 语义，再取消并等待完整 compaction 操作及其失败回调。取消票据覆盖 controller 尚未创建的启动窗口，controller 赋值时立即应用已有取消。compact 自身的首次 abort 豁免只消费一次，之后的 Stop 仍能取消。

## 可审计安装与检查（先确认授权，再执行外部 apply）

仅支持精确 SDK **1.3.0** 与 npm **pi-subagents0.75.0**；未知版本/源码形状/半补丁拒绝。先验证所有文件，再写 core+bundle；保存首次原始文件备份，重复 apply 幂等。脚本不改 settings，不装包，不重启。路径必须来自本次安装身份检查，不能凭版本相同假定字节相同。

```sh
# 独立候选；不得把源码目录旧1.2依赖当作1.3证据
node 工具/pi-interrupt/install.mjs --sdk "$CANDIDATE/node_modules/@earendil-works/pi-coding-agent" --apply --allow-external
node 工具/pi-interrupt/install.mjs --sdk "$CANDIDATE/node_modules/@earendil-works/pi-coding-agent" --check

# 以下是待授权激活步骤，未在本轮执行：
# 1. 对 CLI 与 Web 各自 SDK root 逐一执行 apply/check（双形态同时覆盖）。
# 2. 对 ~/.pi/agent/npm/node_modules/pi-subagents 执行配对 factory adapter：
node 工具/pi-interrupt/apply-subagents.mjs --package "$SUBAGENTS_ROOT" --apply --allow-external
node 工具/pi-interrupt/apply-subagents.mjs --package "$SUBAGENTS_ROOT" --check
# 3. 已运行CLI/TUI/runner进程须在许可窗口重开；Web只沿统一守卫发布/重启。
```

全局 TUI 的 bin 使用 bundle，单靠本地扩展安装 SDK prototype 无法可靠拦截它。不要用一个只改 Web 或只改 SDK core 的入口声称覆盖所有 Pi。升级后先重放候选并检查，未知版本必须重新验证适配。

维护 `preflight.py` 要求候选 core/bundle/vendored engine 与权威源码匹配；`flow.py` 把外部 replay adapter 纳入 identity，engine 源码与 vendored 字节分别参与源码/依赖指纹。改 engine 不会复用旧验证/构建缓存。npm factory adapter 仍需单独确认/检查，不能以候选 SDK 通过代替其激活。

## 离线验证

所有行为测试使用 faux provider、假工具和临时 session，不访问真实模型。

```sh
node --test 工具/pi-interrupt/install.test.mjs
# 在真实1.3.0独立候选内执行
node --test lib/interrupt-steer.integration.test.mjs lib/subagent-runtime.integration.test.mjs \
  lib/rpc-manager-lifecycle.test.mjs lib/rpc-manager-shutdown.test.mjs lib/rpc-manager-extension-ui.test.mjs lib/subagent-extension.integration.test.mjs
# 对安装器发现的真实 bundle chunk 再跑同一专项（不要抄旧chunk名）
PI_INTERRUPT_TEST_BUNDLE="file://$BUNDLED_CHUNK" node --test lib/interrupt-steer.integration.test.mjs
node_modules/.bin/tsc --noEmit
# 维护缓存/门禁回归
(cd 工具/pi-web维护/native-agent-switcher && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest test_flow test_local_update)
```

专项包括工具/stream取消、完整settled和嵌套follow-up、连续batch、后续新run再打断、附件/followup顺序、idle/input race、Stop/销毁尾窗、manual compaction完整生命周期、command/handled、custom通知对照、失败落盘与有界状态、实际npm后台runner及Web prompt/explicit-steer MCP admission。`subagent-runtime.integration.test.mjs` 另验内置孩子身份/结果只结算一次及原turn-limit回归。没有真实模型与正式部署证据时，只交付实现/候选验证，不说已全机启用。
