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

版本源在本目录；下列外部文件为运行副本。修改源码不等于启用：只有另获同步/重载授权后才逐个核对、备份、同步并验证，不能只改快照就声称生效。本批仅源码待上线，不写 `~/.pi`、不重载：

| 本目录源文件 | 运行路径 |
| --- | --- |
| `APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` |
| `references/execution.md` | `~/.pi/agent/rules/execution.md` |
| `references/delegation.md` | `~/.pi/agent/rules/delegation.md` |
| `browser-harness/SKILL.md` | `~/.pi/agent/skills/browser-harness/SKILL.md` |
| `latex-homework/` | `~/.pi/agent/skills/latex-homework/` |
| `mcp-wiring/` | `~/.pi/agent/skills/mcp-wiring/` |

子代理 `worker`、`reviewer` 的版本源在 `../../../工具/pi-subagents-quiet/agents/`，运行副本为 `~/.pi/agent/agents/`；角色使用全工具，但任务仍可限定只读，MCP按需发现。其他角色本轮未改提示正文。

`password-fill` 的版本源在 `../../../工具/密码管理/当前页凭据填充/skill/SKILL.md`，运行副本为 `~/.pi/agent/skills/password-fill/SKILL.md`。只支持已经选用 agent-browser 的任务，不接管 Playwright/OpenCLI 登录流程。

`references/repositories.md` 由工作区根索引直接引用，不复制到全局目录。浏览器技能保留原有 `scripts/check.sh`，不覆盖其他文件。本机绝对路径用于全局规则在工作区外仍能定位参考；迁移用户名或工作区时须一起更新路径与验证。

## LaTeX 作业技能

`latex-homework/` 以用户提供的技能为基础，保留题目核对与正面表达流程，适配 Pi 的实际工具发现；英文视觉参照用户认可的 Termes／NewTX、深蓝标题作业 PDF。包含独立中英文模板与视觉验收参考。`agents/openai.yaml` 是原包的 Codex 入口元数据，保留用于兼容，Pi 以 `SKILL.md` 发现技能。

只调整排版时保留答案内容；编译工具、字体或宏包缺失时不自动安装。源码模板检查与实际 PDF 编译、逐页验收分别报告。维护后同步整个技能目录并检查一致性，已有会话需 `/reload` 或新建会话后重新发现。

## 当前规则的取舍

- 合并重复的表达、交付、验证和授权说明，不重复抄工具使用手册。核心约束仍常驻，操作细节下沉，不新增技能广告条目。
- 保留最小相关验证、依赖与系统操作确认、单写入者、仅提交任务文件等边界。
- 浏览器按用户本次授权：可通过 OpenCLI 扩展操作任务相关的现有标签页，无需重复确认连接权限；不允许无关标签页、日常 profile 远程调试或桌面控制。实际操作仍须在任务授权内。
- 委派规则强调独立分支尽早派、重要变更独立审查，主助手继续不同主线；不追求调用数量，也不机械套流水线。
- 本机静默通知由 `工具/pi-subagents-quiet` 统一适配工具描述、启动回执和最小系统提示，不在全局规则里另抄通知协议。
- notesoup负责会话笔记与换窗；当前记忆是 `工具/hy-memory迁移/index.ts` 的 Hy-Memory 六工具，不再沿用旧插件的七工具/答复后排队时序。`工具/pi-workflow-integrity/context-policy.test.mjs` 仅保留旧插件兼容回归。不改模型、依赖、技能发现配置，也不批量删除历史资料。
- 自动注入仍占上下文，不能把自定义常驻字数变化当作整个系统prompt缩减比例。

## 参考依据

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

- `--source` 复制四份版本源到临时无凭据agent目录，使用空内存settings、关闭扩展，只显式加载浏览器技能源。安装中的 Pi Web SDK 分别从工作区、子目录、独立临时目录构建提示词，确认继承范围与参考/技能正文不自动注入；结束清理临时目录。不证明运行副本、运行目录的覆盖文件/手动技能状态或已有会话加载。
- 默认模式保留运行副本逐字一致、禁止全局SYSTEM/AGENTS覆盖和手动技能等检查；按组汇总失败，不因首个长度/漂移失败漏跑后续SDK检查。源码与运行级结果必须分开报告，不能把 `--source` 通过当成启用。
- 两种模式均检查必要常驻边界、索引路径与分层预算；不调用模型、不重启服务，不代表真实插件组合、模型遵从度或性能测试。

### 长度预算与负样例

先对 pstack 常驻段清重，保留重要歧义、工程入口与授权约束；替换旧记忆说明而非删除保存确认边界。根 `AGENTS.md` 的确认与 Git 边界不为长度绿灯而删除。预算按 JavaScript UTF-16字符数计：**全局≤1100、工作区≤1250、合计≤2350**；工作区预算覆盖现有1195字符并留55字符维护余量，不是无限放宽。新增规则优先替换重复文字或下沉操作细节；超过任一上限必须重新审查。必要边界断言独立于长度断言，短不等于正确。

本批源码实际为全局1041＋工作区1195＝2236字符。旧1731/3958等是历史快照，不是当前结果；这些数字不含 Pi 内置、工具定义、技能元数据或记忆注入，不能推算整轮请求节省比例。`validators.test.mjs` 用临时无凭据fixture覆盖匹配副本、pending drift、精确预算上限、全局/工作区超限、删除必要边界、恢复旧时序、意外增加/减少自动技能及错误全局链接；没有删除断言来换绿灯。

### 其他现有回归与待启用

`configuration-repair.test.mjs` 是独立的本机配置修复回归，不是上述源码合同测试。它检查 shadcn 的 `env -i` 子进程隔离、密码填充副本、子代理并发及 MCP SDK命令/环境引用；不启动 shadcn、不读取钥匙串、不调用模型。设置 `PI_CONFIG_REPAIR_BASELINE` 才核对其他私有JSON字段未变，无baseline时相关项跳过。本批未改配置，不以该测试代替运行启用；备份不得入库，MCP边界见 `mcp-wiring/SKILL.md`。

本批停在源码已验证，运行APPEND仍应报pending drift。后续须获授权，先核对运行文件是否被其他会话修改并备份，只同步所需文件，再跑默认校验；新实例可读取，已有会话需 `/reload` 或重新创建后确认加载，不要求为此重启30141。回退时逐文件恢复本轮前备份并复验，禁止用旧快照整包覆盖；本轮未同步，无运行回退操作。

历史快照保留在原目录，不再作为现行规则或现行校验入口。恢复旧规则时须明确选择版本并检查后续修改；不能用旧验收脚本的失败自动回滚当前版本。
