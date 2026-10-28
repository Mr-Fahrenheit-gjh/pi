# Pi 工作流程与上下文协调

## 当前实现

扩展入口 `index.ts` 已链接到 `~/.pi/agent/extensions/workflow-integrity/`。2026-10-15经用户授权随合并发布重启30141，新Web SDK会话读取该扩展；其他已启动宿主仍需各自空闲重载。

- **notesoup加载时让位**：每次事件以公开 `getAllTools()` 中 `empty_brain` + `get_context_remaining` 能力对判断，不缓存工厂加载顺序、不用active tools或私有marker猜开关。此时不改原生压缩preparation、不代其取消压缩。notesoup负责换窗；最近20k原文的旧说明不适用其reset。
- 未加载notesoup时，split-turn压缩将历史与当前长任务前缀送入同一次原生迭代摘要；原生保留边界、模型阈值、usage、文件跟踪、取消和重试仍交SDK。
- 这是保守的**整个加载期互斥**，不是精确enabled检测。notesoup off后工具仍注册，有旧reset时仍可能接管压缩，所以继续让位；移除扩展并重载才回到旧原生路径。若其他插件复用同名能力对也会保守让位，需排查注册来源。
- 仅对外层 `bash/codemode/grep/find/ls/task_logs` 的非结构化长文本做短预览，超过16000字符时保存原返回文本到 `~/.pi/agent/tool-output/`，保留首尾及文件路径。结构化数据、嵌套调用、read和图片不受影响。保存失败保留原输出。
- 原生路径依赖SDK的 `session_before_compact` 共享preparation合同，现有测试使用安装中的SDK1.2.0；升级仍须重跑。未修改SDK安装包、模型窗口或压缩阈值。

## todo 与工具调用

`~/.config/rpiv-todo/config.json` 的原生 guidance 已更新：少量可验收交付项、真实当前阶段、create只创建pending、随后update开始、仅一个主阶段进行中、失败保持未完成、不在正式验收前完成、不频繁list。没有修改插件状态机或伪造完成状态。

`~/.pi/agent/APPEND_SYSTEM.md` 增补简短约束：按真实导出调用SDK、model-only工具直接调用、机器JSON本地解析、最新原始记录优先、指定subagent不能被后台CLI冒充、进程中断不等于用户取消。

Brave技能不再声称一定已配置Key；无Key时使用已可用默认搜索provider，不反复调用未配置入口。不打印密钥。

## 当前记忆合同与历史兼容范围

当前记忆入口为 `../hy-memory迁移/index.ts`：`memory_write/search/read/update/delete/status` 六工具。`memory_write` 只有 `content / target / scope`，成功代表同步落盘回读，不支持旧 `timing`；结果未确认时按请求编号查 `memory_status`，不要重发写操作。notesoup 负责会话笔记与换窗，长期偏好/决定与历史工作记录分别用 Hy-Memory 的 `long_term` / `daily`。

当前合同的便宜回归在 `../../项目/规则优化/运行规则/hy-memory-contract.test.mjs`：注册真实适配器核对 schema、用临时合成配置和 fetch stub 检查 completed/queued/丢失回执，不请求真实服务、不读真实密钥或记忆；不证明服务端持久化或已有会话加载。

以下两节保留 **旧 pi-memory-local 的历史兼容行为**，不是当前 Hy-Memory 使用说明。`context-policy.test.mjs` 导入的仍是旧实现，七工具、forget/restore、deferred write 只证明该兼容组合，不代表现行工具或保存时序。

### 历史：旧记忆与换窗分工

notesoup加载时，`pi-memory-local` 仅注入MEMORY稳定偏好；scratchpad/daily/自动检索结果不再成为重复会话交接。跳过旧before_compact handoff及退出自动摘要，保留终端输入订阅/定时器清理。7个显式记忆工具及原始数据完整保留，daily/scratchpad仍可主动读写。

稳定快照在每次 **agent-run start** 按MEMORY内容指纹核对，外部同长度/同mtime改动也能更新；内容未变不改提示字节/时间戳，daily写入不扰动稳定前缀。能力负责方改变时失效重建。不谎称 `before_agent_start` 是每次模型请求或每次notesoup换窗：同一run内reset保留该快照，更新后的内容可用memory_read读取，下次run再核对。未加载notesoup时保留原快照/per-turn、handoff与显式退出摘要路径。

共享门控为 `context-policy.mjs`，未读notesoup私有状态，也未改其安装包。

### 历史：旧记忆答复后静默保存（不适用于 Hy-Memory）

现有 `pi-memory-local` 加入 `deferred-write.mjs`，默认 `memory_write` 返回queued，只保存私有待写队列，不先改MEMORY.md或daily。正式assistant回复完成且无工具调用后，由已有agent_end生命周期保存正文；索引维护不阻塞可见答复，不发送完成消息、不唤醒模型。

- 中断/失败不把排队意图算保存成功，队列保留到后续成功回复。
- 同一会话重开后能恢复队列，其他会话不会替它写。
- 保存失败保留待写项，错误进静默session entry。
- 重复触发不会重复追加同一请求；daily保留请求时日期。
- 只有明确要求立即保存或回复前必须读取更新，才用 `timing: now`。

源码：`../../项目/规则优化/agent-eval-20261002/packages/pi-memory-local/`，由已有settings包路径加载，不另加执行器。

## 部署与验收

唯一入口 `../pi-web维护/native-agent-switcher/upgrade_when_idle.py`。部署器独立核对正式证据的版本、构建、父会话、真实历史孩子及界面断言，不能只凭退出码写成功。未完成计划不能被新prepare覆盖，全维护目录共享部署锁。两个旧0.11独立入口已拒绝执行；历史原稿保留。

用户随后授权的合并发布已由唯一守卫完成，正式状态与真实验收一致；见 `../pi-web维护/子代理视图精简-20261015/README.md`。不是手工把旧回退状态改成成功。

## 验证

- 当前合同：`node --test 项目/规则优化/运行规则/hy-memory-contract.test.mjs`，无网络合成回归；不验收真实服务。
- 历史兼容：`node --test 工具/pi-workflow-integrity/context-policy.test.mjs`：7项旧 pi-memory-local/notesoup 组合回归，覆盖加载顺序/能力切换、stable/per-turn、外部内容指纹、显式写删恢复、daily写入不扰动、压缩让位和退出清理。使用实际SDK依赖加载两扩展，事件/notesoup能力为fixture；不声称真实模型reset质量已验收。
- `node --test 工具/pi-workflow-integrity/engine.test.mjs`：9项通过，含原历史案例的原生切点与原生compact调用。
- `python3 -m unittest discover -s 工具/pi-web维护/native-agent-switcher -p 'test_*.py' -q`：12项通过，含假通过、旧构建/错误会话、模拟数据、没有真实孩子及未完成计划的拒绝。
- 历史 deferred-write模块：当时6项通过，不是当前 Hy-Memory 测试。
- 历史 `项目/规则优化/agent-eval-20261002/test_memory.mjs`：旧7工具保留，默认排队、答复后写入、中断保留、重复flush及原读写/删除恢复通过。
- 使用正式Pi Web SDK真实loadExtensions加载两扩展成功；实际todo配置加载器接受新guidance。

不把fixture测试说成实际压缩模型质量已证明，也不把加载测试说成当前会话已重载。本轮用临时tsconfig显式映射正式SDK/Node类型：workflow-integrity及通知相关TS通过；完整记忆模块仍有既存deferred-write返回值字面量推断TS2322，基线与当前诊断相同，不宣称全模块类型通过。当时旧记忆行为由正式SDK加载与运行测试验证，不代表当前 Hy-Memory 合同，历史组合结果见 `../pi-subagents-quiet/验收-20261015.md`。

未处理连接失败、代理路由、模型额度或网络重试。
