# Local tool profiles（保守显式版）

## 已交付与边界

只使用官方 ExtensionAPI：`registerCommand`、`getActiveTools`、`getAllTools`、`setActiveTools`、`ctx.isIdle`、`ctx.ui.notify`。无模型工具、无启动提示、无常驻 widget、无系统提示注入；运行时不写 settings。2026-09-15 主侧已接入全局配置，旧进程须正常重启；统一验收见[总入口](../../README.md)。

**默认 full = 原样保留当前能力，不是激活所有注册工具。** 没有可靠的官方主/子 Agent 身份及显式 allowlist 来源查询 API；`ctx.mode`、parentSession、环境变量、工具名字均不作为身份判断依据。没有上线 CU/HTTP 启发式自动过滤。CU 去重仅在用户显式执行 general/coding 命令时，或通过下方显式启动参数完成，不声称默认已去重。

已全文阅读 Web host 的 `docs/extensions.md`、`sdk.md`、`packages.md`、`session-format.md`，及相关官方示例 `examples/extensions/tools.ts`、`dynamic-tools.ts`、`examples/sdk/05-tools.ts`、`06-extensions.ts`。没有照搬官方 tools 示例的“恢复所有已保存工具”逻辑。

## 命令

临时加载（不安装、不写 settings）：

```sh
P='/Users/guojiahang/Documents/pi/工具/pi-local-runtime/packages/tool-profiles'
pi -e "$P/index.ts"
```

| 命令 | 行为 |
|---|---|
| `/tool-profile general` | 隐藏当前 active 的已知 6 个 LSP 工具、chatgpt_computer_use、credential_login；保留基础读写/bash、memory、Agent/browser、CU status 等当前能力 |
| `/tool-profile coding` | 恢复本包曾隐藏且身份仍匹配的 LSP；隐藏当前 active 的直接 CU 执行与旧 HTTP 工具 |
| `/tool-profile full` | 只恢复本包曾隐藏、仍在 host registry 且身份匹配的工具，绝不全量激活 getAllTools |
| `/tool-profile status` 或无参数 | 按需显示当前活跃列表与本包隐藏列表；不触发 LLM |

已知 LSP 名字精确列举：`lsp_diagnostics_many`、`lsp_find_symbol`、`lsp_hover`、`lsp_definition`、`lsp_references`、`lsp_document_symbols`。兼容旧工具 `lsp_diagnostics` 已从本地 LSP 默认入口移除；不使用 `lsp_*` 通配，不改变未来新增工具。

general/coding **临时隐藏直接桌面执行和旧 HTTP 登录**。如果主 Agent 没有专用委派路由，应先执行 `/tool-profile full` 再使用直接工具；已被启动上限排除、或身份变更而放弃恢复的工具不能通过 full 找回。这里不检查路由、不推断主/子身份；用户在子会话显式执行 general 也会隐藏该子会话的直接后端，但主会话命令不影响独立子会话。

集合是呈现优化，**不是权限沙箱或只读模式**。忙碌时拒绝切换。状态仅存在当前扩展实例内，reload/new/resume/fork 不从旧 session 恢复隐藏名单；以 host 当时能力为准。只在明确命令时调用 setActiveTools，没有 hooks 反复抢写；其他包后续动态激活可以改变集合，下次显式命令才重新应用。保留所有不受本命令管理的外部增减；不会因为 coding/full 而启用初始未 active 的 LSP。LSP/browser 注册行为不变。

## 显式主/子启动集合

确认主会话有可用的专用 computer-use Agent 路由后，**只在主会话**增加下面的官方参数：

```sh
pi -e "$P/index.ts" --exclude-tools chatgpt_computer_use,credential_login
```

保留 `computer_use_status` 和已有 Agent 入口，隐藏桌面后端与旧 HTTP 登录工具。这里不会检查/注册 Agent 入口：必须由维护者在主侧验证实际入口及专用 agent 配置。没有入口时不要使用上述排除集合，否则桌面能力不可达。若不确定，使用默认 full。

专用 computer-use 子 Agent 保持自己的 tools 上限，例如：

```sh
pi --tools read,computer_use_status,chatgpt_computer_use
```

这些参数应由已有 Agent 启动器使用；本包不启动/委派子 Agent、不改其批准/凭据/安全执行器。**不要把主会话 exclude 参数复制到子 Agent。** 如果启动器会自动继承主侧排除项，先在主侧解决参数隔离，再启用去重。

已有 `--tools` 时保留原 allowlist，不能为了切换添加未授权工具；已有 `--exclude-tools` 时把上述名字并入同一个 exclude 列表，不依赖重复参数的覆盖顺序。排除优先于允许。需要严格 coding 启动上限时可显式使用 `--tools read,bash,edit,write,grep,find,ls`；这有意不包含 Agent/browser/LSP，按用户授权提供一次完整名单，不由本包补齐。

## 为什么运行时切换不会扩大授权

两份 0.85.1 host 中，`core/agent-session.js` 的 `_refreshToolRegistry` 先按 `allowedToolNames`/`excludedToolNames` 过滤 builtin、extension、SDK tools，再构建注册表；官方 `setActiveTools` 只能激活该注册表中的名字。因此即使主动请求被排除工具也不能恢复。

此外本包只记录自己从 active 中隐藏的工具，与当下 `getAllTools` 再求交集；不缓存全量启动工具作为可恢复授权。隐藏时保存规范化元数据**值快照**，每次命令核对完整 sourceInfo（必需 path/source/scope/origin）、parameters、description、promptGuidelines。对象键排序、数组顺序保留，采用 JSON 可见字段；不比较对象引用。缺失标记、消失、schema/描述/来源等值变化均丢弃旧恢复记录；同名替换不能凭名字恢复。循环或不支持的非 JSON 元数据不建立恢复记录。被外部主动激活的替换工具，可在之后的显式命令中重新隐藏并建立新记录。

官方 API 不提供 execute 函数/注册 generation ID；这是宿主可见定义的值校验，不是执行代码指纹。browser 动态注册会让 host 重建 SDK customTools 的 sourceInfo 对象，同一未变定义的刷新必须可恢复，不能因引用变化永久丢失合法能力。无法区分在完全相同 provenance/schema/描述/指引下替换 executor 的行为；这不是防同权限恶意扩展的安全边界（TypeBox symbol 等非 JSON 字段也不作为 executor 身份）。值不匹配时由用户通过原工具包/重启恢复，不在本包越权激活。升级 host 后应重跑测试。

## 启动入口表（本次本机检查）

| host | 入口 / 核心 |
|---|---|
| CLI | `command -v pi` → `/opt/homebrew/bin/pi` → `../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`；核心 0.85.1 |
| Web | `@agegr/pi-web` 0.9.1，bin `bin/pi-web.js`；内嵌核心 `/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent` 0.85.1 |

Web 内嵌核心也有 `dist/bundle/cli.js` 可用于独立 CLI 启动验证；**不声称 pi-web 服务入口接受 Pi 的 --tools 参数**。Web 的实际会话参数传递由主侧 host 接入负责，本包不改 Web 包。未查看任何私有进程参数。

## 本地类型检查

`tsconfig.json` 使用当前 CLI host 0.85.1 的 `dist/index.d.ts` 显式 paths 和宿主 Node typeRoots，与相邻本地包的配置方式一致。仅检查本包 `index.ts`，开启 strict/noEmit；skipLibCheck 仅跳过宿主依赖声明内部检查，不跳过本包源码。

执行 `tsc -p tsconfig.json --strict --noEmit`：TypeScript 7.0.2，退出码 0、零诊断。本次元数据值快照修复后已重新通过 strict 检查及行为回归；未安装依赖、未使用 any/ts-ignore。绝对路径仅适用于当前机器，迁移/升级 host 时需更新并复验。

## 无 LLM 验证

Node 25.1.0，本目录运行 `npm test`，无需 npm install。测试也支持 `node tests/hosts.mjs /absolute/host/package ...`。

- `tests/hosts.mjs`：分别导入两份真实 host SDK，官方 DefaultResourceLoader 加载本扩展 factory；隔离临时 cwd/agentDir、内存 settings/session、禁用资源自动发现与模型网络。CU/credential/Agent/LSP/browser 是只注册不执行的 mock。
- 通过真实 `session.prompt('/tool-profile ...')` 检查默认不变、基础读写/bash/memory/Agent/browser/status 保留、精确 6 个 LSP 隐藏/恢复（未知 lsp_future 保留）、general↔coding↔full 往返、status/非法参数、外部移除 browser 不恢复、外部重新激活 CU 后 coding 再隐藏、独立子 session 不受主命令影响、子会话自身显式命令往返、allowlist+exclude、空上限、直接越权激活失败、显式主排除不恢复。所有 session 的模型消息数量为零。
- `tests/mock.mjs`：无启动写列表、集合往返、外部激活增减、不同来源/schema/描述/指引替换不恢复（包括原地修改）、等值克隆及对象键重排可恢复、注册表收窄不恢复、主动激活替换后可建立新记录、缺失/不支持的元数据保守不恢复、忙碌拒绝、状态输出、补全、新实例无恢复记忆。
- `node tests/browser-refresh.mjs`：额外的最小真实 host 回归（依赖相邻 browser 入口，只读加载，不改其代码），两份 host 运行 general → browser full → full，断言刷新不改变 active、元数据值不变、full 恢复全部 CU/HTTP。`--control` 跳过刷新用于对照。诊断红→绿证据见 [tests/refresh-diagnosis.md](tests/refresh-diagnosis.md)。

结果：两份 host 与 mock 均 PASS。不是浏览器端 UI E2E、真实桌面执行或真实 Agent 调度验证；这些未执行，也未接触登录/批准系统。
