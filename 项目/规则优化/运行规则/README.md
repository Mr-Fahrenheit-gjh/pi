# 提示词与规则：当前维护入口

采用“短常驻入口 → 按任务读取 → 专项技能/证据”的分层方式。不要把所有文件自动导入，也不要求每次读完本目录。规则只写与工具默认行为不同、会影响取舍的约束。

## 层级与权威来源

| 层级 | 内容 | 加载方式 |
| --- | --- | --- |
| Pi 内置与工具插件 | 基础工具协议、SDK、安全约束、工具定义 | 运行时提供；不修改安装包或复制整套说明 |
| 全局 `APPEND_SYSTEM.md` | 表达、执行边界、委派授权、按需索引 | 常驻；本目录文件为版本源 |
| 工作区根 `AGENTS.md` | 本地确认边界、Git、项目入口 | 工作区及子目录常驻；直接在根文件维护 |
| `references/` | 实施恢复、委派细则、独立仓库 | 命中短入口的触发条件时，操作前读取 |
| 现有技能 | 浏览器、Pi Web 维护等专项操作 | 只常驻名称/描述/路径，正文按需读取 |
| 项目记录/会话笔记 | 当前状态、验收、待办与证据 | 恢复或核实任务时读取，不当成永久规则 |

普通 Markdown 链接只是索引，Pi 不会自动按链接导入。这里采用模型按触发条件调用 read 的方式，不声称具备 Claude 的路径规则引擎；不得为了“模块化”改成递归全量读取。

## 文件映射

版本源在本目录；下列外部文件为运行副本。修改源码与同步运行副本分开：获得同步授权后逐个核对、备份、同步并验证。当前规则及五个自维护角色已按授权同步；已有会话需 `/reload` 或新建后加载，不把磁盘同步当作会话重载。

| 本目录源文件 | 运行路径 |
| --- | --- |
| `APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` |
| `references/communication.md` | `~/.pi/agent/rules/communication.md` |
| `references/execution.md` | `~/.pi/agent/rules/execution.md` |
| `references/delegation.md` | `~/.pi/agent/rules/delegation.md` |
| `browser-harness/SKILL.md` | `~/.pi/agent/skills/browser-harness/SKILL.md` |
| `latex-homework/` | `~/.pi/agent/skills/latex-homework/` |
| `mcp-wiring/` | `~/.pi/agent/skills/mcp-wiring/` |

子代理 `worker`、`reviewer`、`oracle`、`researcher`、`evidence-auditor` 的版本源在 `../../../工具/pi-subagents-quiet/agents/`，运行副本为 `~/.pi/agent/agents/`；后面三个角色从原运行文件纳入版本管理，元数据保持不变。角色使用全工具，但任务仍可限定只读，MCP按需发现。`delegate`、`scout` 正文未改。

`password-fill` 的版本源在 `../../../工具/密码管理/当前页凭据填充/skill/SKILL.md`，运行副本为 `~/.pi/agent/skills/password-fill/SKILL.md`。只支持已经选用 agent-browser 的任务，不接管 Playwright/OpenCLI 登录流程。

`references/repositories.md` 由工作区根索引直接引用，不复制到全局目录。浏览器技能保留原有 `scripts/check.sh`，不覆盖其他文件。全局规则通过 `~/.pi/agent/rules/` 在工作区外定位参考；版本源中的工作区路径迁移时须一起核对与验证。

## LaTeX 作业技能

`latex-homework/` 以用户提供的技能为基础，保留题目核对与正面表达流程，适配 Pi 的实际工具发现；英文视觉参照用户认可的 Termes／NewTX、深蓝标题作业 PDF。包含独立中英文模板与视觉验收参考。`agents/openai.yaml` 是原包的 Codex 入口元数据，保留用于兼容，Pi 以 `SKILL.md` 发现技能。

只调整排版时保留答案内容；编译工具、字体或宏包缺失时不自动安装。源码模板检查与实际 PDF 编译、逐页验收分别报告。维护后同步整个技能目录并检查一致性，已有会话需 `/reload` 或新建会话后重新发现。

## 当前规则的取舍

- 合并重复的表达、交付、验证和授权说明，不重复抄工具使用手册。核心约束仍常驻，操作细节下沉，不新增技能广告条目。
- 表达先给易懂的结论，按需补准确术语与证据；最终答复不用翻进度消息也能看懂。核查和润色分开，不新增假想反驳或无依据弱化。示例、OpenAI 与 Tibo 的来源见 `references/communication.md`。
- 授权内的低风险、可逆细节直接处理；简单任务走最短可靠路径。核验和补查的触发条件放 `references/execution.md`，不在常驻入口展开。保留工程确认、最小相关验证、依赖与系统操作确认、单写入者、仅提交任务文件等边界。
- 浏览器按用户本次授权：可通过 OpenCLI 扩展操作任务相关的现有标签页，无需重复确认连接权限；不允许无关标签页、日常 profile 远程调试或桌面控制。实际操作仍须在任务授权内。
- 委派规则强调独立分支尽早派、重要变更独立审查，主助手继续不同主线；不追求调用数量，也不机械套流水线。
- 本机静默通知由 `工具/pi-subagents-quiet` 统一适配工具描述、启动回执和最小系统提示，不在全局规则里另抄通知协议。
- notesoup负责会话笔记与换窗；当前记忆是 `工具/hy-memory迁移/index.ts` 的 Hy-Memory 六工具，不再沿用旧插件的七工具/答复后排队时序。`工具/pi-workflow-integrity/context-policy.test.mjs` 仅保留旧插件兼容回归。不改模型、依赖、技能发现配置，也不批量删除历史资料。
- 自动注入仍占上下文，不能把自定义常驻字数变化当作整个系统prompt缩减比例。

## 参考依据

- [OpenAI GPT-6.2 提示词建议](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)与 [GPT-6.2 Codex 指南](https://learn.chatgpt.com/guides/prompting-gpt-6-2-astra)：写清完成标准，授权内主动做到交付，把模型不能自行推断的项目约束留在对应层。不改 Pi 的请求组装、模型设置或授权边界。
- [Agent Skills 规范](https://agentskills.io/specification)：元数据、技能正文、资源三层渐进加载；避免深层引用链。
- [Claude Code memory](https://code.claude.com/docs/en/memory)：短且具体、一致的常驻指令；自动导入只是拆文件，不减少启动上下文，条件规则才按需加载。
- 本机 Pi `docs/configuration.md` 与 `docs/skills.md`：全局补充提示、工作区上下文与技能的实际加载机制。Pi 的项目 `.pi/APPEND_SYSTEM.md` 会替代同名全局文件，不能误当成叠加；本次未新增它，也未恢复全局 `AGENTS.md`。

在线规范是设计依据，不是额外授权或本机自动加载入口。Pi 文档以当前安装 SDK 所带文档为准。

## 当前记忆合同

权威实现为工作区 `工具/hy-memory迁移/index.ts`，注册 `memory_write/search/read/update/delete/status` 六工具。`memory_write` 仅有 `content / target / scope`：`target` 为 `long_term` 或 `daily`，`scope` 为 `global` 或 `project`；daily 在适配器映射为 archive。成功回执表示同步落盘回读，不接受旧 `timing`，也不先返回 queued 再在正式答复后保存。更新/删除前先搜索确认 `memory_id`；结果不确定时用 `request_id` 查 `memory_status`，不要重发写操作。历史检索不覆盖当前指令或实际状态。

`hy-memory-contract.test.mjs` 注册当前适配器检查完整工具名和字段、写入枚举与说明，并用合成配置/token和 fetch stub 验证等待 completed、拒绝 queued、丢失回执保留请求编号。不读取真实配置/密钥/记忆，不发送网络请求，不证明真实服务端持久化。旧插件七工具、forget/restore及deferred-write测试的历史范围见 `工具/pi-workflow-integrity/README.md`。

## 验证与生效

```bash
node --check 项目/规则优化/运行规则/validate.mjs
node 项目/规则优化/运行规则/validate.mjs --source
node --test 项目/规则优化/运行规则/hy-memory-contract.test.mjs 项目/规则优化/运行规则/validators.test.mjs
node 项目/规则优化/运行规则/validate.mjs # 默认严格运行一致性；未同步时应失败并报告pending drift
```

- `--source` 复制五份版本源到临时无凭据agent目录，使用空内存settings、关闭扩展，只显式加载浏览器技能源。安装中的 Pi Web SDK 分别从工作区、子目录、独立临时目录构建提示词，确认继承范围与参考/技能正文不自动注入；结束清理临时目录。不证明运行副本、运行目录的覆盖文件/手动技能状态或已有会话加载。
- 默认模式保留运行副本逐字一致、禁止全局SYSTEM/AGENTS覆盖和手动技能等检查；按组汇总失败，不因首个长度/漂移失败漏跑后续SDK检查。源码与运行级结果必须分开报告，不能把 `--source` 通过当成启用。
- 两种模式均检查必要常驻边界、索引路径与分层预算；不调用模型、不重启服务，不代表真实插件组合、模型遵从度或性能测试。

### 长度预算与负样例

先对 pstack 常驻段清重，保留重要歧义、工程入口与授权约束；替换旧记忆说明而非删除保存确认边界。根 `AGENTS.md` 的确认与 Git 边界不为长度绿灯而删除。预算按 JavaScript UTF-16字符数计：**全局≤1100、工作区≤1250、合计≤2350**；两层分别受限，不通过扩大阈值吸收新增规则。新增规则优先替换重复文字或下沉操作细节；超过任一上限必须重新审查。必要边界断言独立于长度断言，短不等于正确。

当前源码为全局1088＋工作区1066＝2154字符；以校验器实际输出为准。旧数字是历史快照，不含 Pi 内置、工具定义、技能元数据或记忆注入，不能推算整轮请求节省比例。`validators.test.mjs` 用临时无凭据fixture覆盖匹配副本、APPEND与表达参考的pending drift、精确预算上限、全局/工作区超限、删除必要边界或主张保留规则、恢复旧时序、意外增加/减少自动技能及错误全局链接；没有删除断言来换绿灯。

### 其他现有回归与待启用

`configuration-repair.test.mjs` 是独立的本机配置修复回归，不是上述源码合同测试。它检查 shadcn 的 `env -i` 子进程隔离、密码填充副本、子代理并发及 MCP SDK命令/环境引用；不启动 shadcn、不读取钥匙串、不调用模型。设置 `PI_CONFIG_REPAIR_BASELINE` 才核对其他私有JSON字段未变，无baseline时相关项跳过。本批未改配置，不以该测试代替运行启用；备份不得入库，MCP边界见 `mcp-wiring/SKILL.md`。

当前源码与运行副本已同步，默认校验通过；已有会话尚需 `/reload` 或重新创建后加载，不要求为此重启30141。后续维护仍先确认同步授权、核对并备份运行文件，只同步所需差异后复验。回退时逐文件恢复对应备份并复验，避免旧快照整包覆盖后续修改。

历史快照保留在原目录，不再作为现行规则或现行校验入口。恢复旧规则时须明确选择版本并检查后续修改；不能用旧验收脚本的失败自动回滚当前版本。
