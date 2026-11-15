# Browser schema 轻量适配

2026-09-15 主侧已在全局 settings 接入本包；原上游固定版保留安装，资源入口禁用，避免双载。运行中的旧进程须正常重启。配置与统一验收见[总入口](../../README.md)。

## 行为

- 默认 `agent_browser` 仅暴露 `args`、`stdin`、`outputPath`、`timeoutMs`、`sessionMode`（args 必填）。
- `args` 仍完整委托原执行器，支持 `read/open/snapshot/get/click/fill/select/eval/batch` 等读写页面命令；**basic 是 schema 瘦身，不是只读或权限沙箱**。
- 用户执行 `/browser-mode full` 使用完整 schema + 共享路由提示（不是全部上游原文恢复），保留原 execute 和 8 种输入：script、args、semanticAction、job、qa、sourceLookup、networkSourceLookup、electron。
- `/browser-mode basic` 切回；无参数查询。运行中拒绝切换，空闲后重试。模式仅当前扩展实例有效，重启/reload/new/resume 默认 basic。
- basic 的不支持字段在 prepareArguments（校验前）或 execute 入口明确报错，提示 `/browser-mode full` 后原样重试，不丢弃字段、不自动执行、不回显潜在秘密。
- 常用字段复用上游属性 schema，仅浅拷贝 args 替换描述中的无条件 Start with open 句；输入格式与安全约束不变。basic 增加 args 必填及禁止额外字段。full 浅拷贝完整 schema，保留全部 8 模式结构；不原地修改 upstream 对象。
- basic/full 共享只读/交互路由：公开网页介绍、事实检索优先已有 brave-search skill；已知公开 URL 优先该 skill 的 content 命令，`agent_browser read <url>` 仅为备选，正文足够即止；需要浏览器渲染/DOM 才 `open`，点击填表才 `snapshot -i` + 当前 @refs，页面变化后重新 snapshot。brave-search 的 search.js 支持本地 `.api-key`，本适配器不读取密钥、不探测或改动 skill。
- 通过精确提示替换消除两种上游前缀、交互句及 full description 的旧路由；basic 另替换模式选择规则。交互句同一行的普通提交/危险操作授权安全后缀逐字保留，其余安全、profile/config、凭据、artifact 和文档路径规则不变；无关键词过滤。上游文字漂移则拒绝加载、要求重审。
- 上游工厂调用一次；所有事件钩子、执行器、队列、校验、权限/凭据解析、脱敏、渲染、结果及清理原封不动。web-search companion 原样由上游决定是否注册，不主动启用。

## 启动解析与版本边界

此包为私有本机适配器，不发布、不复制上游、无需 npm install。`compat.ts` 集中保存 Pi **0.85.1** 与上游 **0.6.10** 的唯一运行时兼容边界、依赖定位和可读诊断；`package.json` 同步声明精确 peer。

入口：`index.ts` → `compat.ts` → `adapter.ts`。上游只按以下顺序从本机解析：

1. `PI_CODING_AGENT_DIR/npm/node_modules/pi-agent-browser-native`（Pi npm 根）；
2. `$HOME/.pi/agent/npm/node_modules/pi-agent-browser-native`；
3. 从适配器模块位置执行 Node `require.resolve`。

每个候选都读取 package name/version，仅接受精确 0.6.10；随后再读取 `getPackageDir()` 对应 host，仅接受精确 0.85.1。失败信息列出预期值、实测值及候选路径。不会搜索 cwd、联网解析、自动安装或修改配置。通过 Pi 的 jiti 加载原 JS 图，Pi 提供核心 optional peer aliases；直接 Node import 上游并不等价。

**配置必须只加载适配入口、停用上游原扩展入口，同时保留上游安装目录。不要同时加载两者。** 跨扩展同名工具是 first-wins，不是安全覆盖；双载还会重复生命周期钩子。仅同一扩展内部重注册才是本方案验证过的动态替换。适配不读取/修改 settings 来替用户修复冲突。

启用与回滚需完整重启 Pi（上游 README 明确 `/reload` 可能保留旧 compiled JS）。回滚为只加载原上游入口。git 与配置切换由主代理统一维护。

## 离线验证

在本目录执行：

```sh
bash run-checks.sh
/opt/homebrew/bin/tsc -p tsconfig.json
node check-lsp.mjs
```

`run-checks.sh` 以 env -i、隔离 HOME/agent/cwd/TMPDIR、PI_OFFLINE 启动，临时文件仅在本目录并自动删除。只加载注册、执行合成 mock 和无 LLM slash commands；不调用原 browser execute、不启动浏览器、不联网、不读取真实凭据。full 的 8 种输入通过真实 host validator 做 schema-only 校验，不运行各模式。

已通过 CLI 与 Pi Web 各自安装的真实 0.85.1 SDK host：

- 普通读/写 args：合成 executor 接收到原 input 引用及全部五个调用参数，result 原样返回。
- 不支持字段：校验前/直接执行均可恢复报错；真实 host wrapper 同样拒绝，未委托浏览器。
- full：全部 8 模式样例通过 host validator，完整 schema（仅 args 描述调整）与原 execute 保留；共享路由不回退。契约断言保留全部其余规则及同行授权句、两种上游前缀均覆盖、upstream 不变。
- 同实例重注册：立即刷新 agent.state.tools 与 system prompt，无 LLM、无需 reload。
- 显式 allowlist `['read']` 始终不获得 browser；`['read','agent_browser']` 不扩张；手动禁用 browser 后切模式仍禁用。
- host 刷新可能重新激活 allowlist 内手动关闭的工具，因此命令仅在必要时恢复**切换前完全相同的 active 列表**，绝不追加工具名。
- 跨扩展重复注册：真实 ExtensionRunner 方法验证 first-wins；禁止双载。
- TypeScript strict noEmit 通过；TypeScript 7.0.2 真实 stdio LSP `textDocument/diagnostic` 对两个 TS 文件均为 0 diagnostics。

JSON schema UTF-8 序列化大小：**9489 → 1453 bytes（约减少 84.7%）**。这是 schema 字节数，不是模型 token 或整段请求节省量；`check.mjs` 从真实上游 schema 重算三项数值并逐项核对本句，漂移会令检查失败。

### 2026-09-16 路由回归证据

本项目 `工具/pi-local-runtime/records/redundancy-20260916/browser/`：`red.log` 保留先添契约/host 断言、旧适配器失败的原始证据（EXIT=1）；`green-initial.log`、`tsc-initial.log`、`lsp-initial.log` 保留初版验证。已知公开 URL 改为 content 优先后，最终重跑证据为 `green-final.log`（CLI/Pi Web 双真实 host）、`tsc-final.log`（strict noEmit）、`lsp-final.log`（项目 check-lsp，TS 文件零诊断），均 EXIT=0。子代理未配置专用 LSP 工具，因此使用项目脚本；LSP 退出可能打印 context canceled。主侧随后使用活跃 LSP 确认 adapter.ts 无诊断；`.mjs` 测试脚本的 Node 类型/JS 推断诊断见[主侧验收](../../records/redundancy-20260916/README.md)，不声称所有文件类型检查通过。

验证全程离线、未安装依赖/修改 node_modules/重启宿主/调用原浏览器执行器。旧宿主不会自动获得磁盘上的新提示；需主侧正常完整重启后启用。本次不改全局配置、规则、skills，也不声称完成联网行为实验。

## 调查定位与更新风险

已全文读取安装包 README（860 行）、TOOL_CONTRACT（1003 行），Pi 官方 extensions（3024 行）、packages、sdk 文档，以及 dynamic-tools / SDK extensions 示例。

上游 `dist/extensions/agent-browser/index.js`：

- 1364 附近：agentBrowserTool 定义、parameters、guidelines、原 execute。
- 1834：`pi.registerTool(agentBrowserTool)`。
- 1231：条件 web-search 注册；session_start/tree/shutdown、before_agent_start、tool_call、tool_result 均保留。

Pi 0.85.1 `dist/core/extensions/loader.js:238`：同实例 `extension.tools.set` + `runtime.refreshTools()`。
`dist/core/agent-session.js:2105` 附近：工具注册表重建、allowed/excluded 过滤、schema/prompt 更新。
`dist/core/extensions/runner.js:325`：跨实例 first-wins。

升级须重审：上游顶层字段/prepareArguments/事件注册变化、提示规则文字变化、host allowlist 与重注册行为、jiti peer 解析及更新缓存。测试不证明真实浏览器/网络/provider 行为，也不替代上游自身验证；本任务按要求未触及这些外部系统。
