# 子代理编排与静默通知：当前维护入口

## 当前合同

- 用户已授权按需主动委派。独立分支尽早派发，主助手继续不同主线；简单或强顺序任务直接做，不以调用次数为目标。规则源见 `../../项目/规则优化/运行规则/references/delegation.md`。
- 7个本地角色使用现有完整工具与技能，MCP按需发现；工具可用不扩大本次任务权限。`agents/worker.md`、`agents/reviewer.md` 是对应 `~/.pi/agent/agents/` 运行文件的版本源；reviewer允许限定的只读shell，不要求不存在的watchdog_diff。
- 并发3、嵌套深度2、禁用外部CLI和定时任务等配置保持不变。本轮不调整模型、依赖版本或权限。
- `~/.pi/agent/extensions/subagent/config.json` 只保留当前实现消费的字段。旧 `parallel.maxTasks/concurrency` 块已移除；有效并发由 `globalConcurrencyLimit` 控制，单次派发总量另属 `maxSubagentSpawnsPerRun`，不能将旧值8直接迁移为新的运行预算。离线配置回归在 `../../项目/规则优化/运行规则/configuration-repair.test.mjs`。
- 普通完成/失败/暂停/分组通知只写非模型上下文记录，不触发新轮次。监督求助、基础设施错误和用户显式等待订阅不拦截。
- 主助手在依赖点用status或阻塞 `bg_wait` 收齐结果。不要循环轮询；正式交付前不遗留可唤醒模型的订阅。

根会话的 `quiet-api.ts` 代理上游API；`notification-contract.mjs` 适配subagent/bg_wait工具描述、参数说明和启动回执，避免文案继续声称自动唤醒。真实子代理使用独立上游factory，不能仅靠根代理包装：`child-shared-tools.ts` 加载 `child-notification-contract.ts`，在公开 `context_with_system` 中适配所有初始/后续 `system.toolsAdded`，并用 `tool_result` 适配派发回执。子代理registry仍保留上游定义，请求投影才是模型实际看到的合同。

本机适配层同时移除上游“仅在用户要求委派时调用”的门槛：根工具注册时清理描述、`promptSnippet` 和 `promptGuidelines`，子会话在请求投影中清理对应工具声明及系统正文/分段（含后续增量）。按需委派以现有本机规则为准，不再叠加显式请求门槛；用户消息和子代理报告不改写，不直接修改 npm 安装包。

调用形式由同一适配层统一：单个有界子任务优先直接 `{agent,task,async:true}`；多步骤/并行工作先将脚本写到 `/tmp` 或任务目录的唯一文件，再用 `workflow:文件路径` 启动一个异步工作流，结束后清理自己的临时脚本。根工具描述、promptSnippet、workflow参数说明和子会话初始/增量请求均使用此偏好。`workflow:true` 仍保留，但要求脚本块与调用在同一条assistant消息；遇到 `found 0` 后改用文件路径，不重复缺块调用。命名资源、执行权限和工作流守卫不变。

仅改文字，不改变schema语义、执行参数、错误、结构化数据、运行标识或状态；保留系统消息及工具增删顺序，不替换上游factory/执行器、不重写子代理报告。`index.ts` 补同合同提示，不另造相反规则。新增委派门槛清理只完成源码离线验证，尚待宿主重载；不代表 DeepSeek 主动委派行为已实测。

## 用户 steer 的本地中断合同

用户/父代理的 steer 使用共享 AgentSession 中断→完整 settled→自动续跑事务；follow_up、普通 custom 通知和内部预算控制不变。入口、消息状态、并发/失败/Stop合同与可审计激活步骤统一见 [`../pi-interrupt/README.md`](../pi-interrupt/README.md)。`index.ts` 只给核实1.3.0的本地 factory SDK class 安装策略；detached runner 必须同时重放 SDK core/bundle 与0.75.0 factory生命周期适配器，不能把修改此扩展文件说成全机已经激活。Herdr/native remote 不在已验证覆盖内。

## 宿主与工具加载

`host-sdk.mjs` 在导入pi-subagents之前校验SDK包名、1.3.0/1.4.0/1.5.0稳定版本和入口，并配置进程内 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`。显式根优先，否则只从运行中 argv 入口识别CLI自身或Web自身的内嵌SDK；未知启动器须显式配置，不能退回另一个安装的SDK。无效根直接拒绝；可识别当前宿主时，若显式根与它冲突也拒绝，避免上游argv优先规则令runner暗用另一个SDK。上游包从 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下 `npm/node_modules/pi-subagents` 加载，也可用 `PI_SUBAGENTS_PACKAGE_ROOT` 指定包根。`interrupt-steer.mjs` 为本目录自包含的原样MIT副本（许可见同名 `.LICENSE`），不要求另克隆Web源码。此处只修加载路径，不保证上游外部执行器已支持所有原生Windows功能。上游实际优先级为argv宿主、显式环境路径、npm安装包回退。**npm peer软链接不是健康判据**，不再自动补建或删除它。

当前Web内嵌SDK与CLI均为Pi 1.3.0，Web为本地定制0.12.1，pi-subagents仍为0.75.0；实际安装身份以Web维护记录为准。后台移除chord的兼容补丁精确允许已核实的稳定1.2.0/1.3.0，未知/预发布/声明chord的宿主仍严格检查。runner重放器可从旧1.2专用补丁幂等迁移，不新增废弃chord依赖。2026-10-16已随Web内核升级完成正式重载，见[`内核升级记录`](../pi-web维护/core-1.3.0-20261016/README.md)。

现有兼容脚本（重新安装或升级后先检查上游；需在相应授权内运行）：

```sh
node 工具/pi-subagents-quiet/apply-core-1.2-compat.mjs
node 工具/pi-subagents-quiet/apply-runner-1.2-compat.mjs
```

runner脚本先核验显式宿主再补丁，不修改安装链接；两脚本对未知源码拒绝覆盖。不要为了让旧断言变绿恢复不必要的peer链接。

`child-shared-tools.ts` 为后台子会话补官方MCP/tool-search入口，codemode由SDK提供。MCP复用已有配置/授权，不复制凭据，不把工具目录数量当成常驻prompt数量。

## 加载与生效边界

- `~/.pi/agent/extensions/subagents-quiet` 链接本目录；settings中 `npm:pi-subagents@0.75.0` 的 `extensions: []` 避免重复加载。
- Web内置Agent仍关闭；`subagents-terminal.ts` 不再重复注册插件。
- 外部规则与角色副本已同步；源码改动由新实例读取，已加载扩展需空闲重载。2026-10-15 15:50经用户授权，合并Web发布已重启30141，新SDK会话重新加载磁盘扩展；其他独立CLI宿主不因此自动重载。
- 调用形式偏好已通过根工具包装、实际子会话SDK初始/增量请求及notesoup换窗顺序的定向回归；未重载已有宿主。新的宿主实例读取磁盘文件；已有实例需空闲 `/reload` 或重新创建，不能仅凭磁盘修改声称现有会话已生效。回归不等于真实模型遵从度验证，不保证模型永不漏参。
- 本轮未安装/升级依赖、未改MCP配置。正式发布结果与已验证/未验证范围见 [本轮验收](验收-20261015.md)。

## 验证

```sh
node --test 工具/pi-subagents-quiet/*.test.mjs
node 项目/规则优化/运行规则/validate.mjs
node 工具/pi-subagents-quiet/check-child-tools.mjs --output /tmp/pi-child-tools.json
```

- 角色测试核对7份配置及两个角色源/运行副本；这不是所有工具逐项执行验收。
- 通知测试调用已安装上游notifier、工具定义与启动回执；child接线测试加载真实child factory及配置扩展入口，经过实际SDK请求转换，验证初始/后续定义、notesoup投影两种顺序及结构化字段保留。仍不等同于真实嵌套派发/换窗全链路验收。
- 宿主测试执行实际上游解析函数，覆盖无peer时显式宿主成功、argv优先、可选安装回退及缺失宿主；兼容版本边界仍逐项验证。
- 工具检查使用新进程和实际SDK、全部配置扩展及child-shared-tools，检查核心工具、notesoup、MCP发现与本机通知文案。`check-child-tools.mjs`遵守显式宿主环境变量，输出实际sdkRoot/sdkVersion，候选验证不得误用旧正式SDK。不发模型请求，不冒充真实孩子。默认只输出stdout；可选 `--output`，不再覆盖历史验收记录。
- 本轮真实fresh reviewer已启动并执行只读shell；全量审查发现的child通知漏接已修复，恢复后的真实后台reviewer确认请求可见bg_wait说明及4个参数已统一，独立复核通过。组合验证与未覆盖项见 [本轮验收](验收-20261015.md)。

notesoup上下文负责权与稳定记忆注入见 `../pi-workflow-integrity/README.md`。当前任务进度放会话notes/todo，长期MEMORY只留稳定偏好，不保存过期故障与待重载结论。

## 历史、回退与维护

[历史记录](history-20261015.md) 保留此前版本、失败、重启与恢复证据，仅供追溯，不是当前操作清单。早期缓存/SDK解析故障已在真实原生后台调用中恢复，不应继续当作当前阻碍。

角色/规则回退按单文件差异同步；settings只恢复本次字段，不整份覆盖后来更新。迁移时按上述环境变量指定现有安装，不复制本机配置。上游通知类型或文本改变时，复核适配匹配与测试，不扩大拦截范围。
