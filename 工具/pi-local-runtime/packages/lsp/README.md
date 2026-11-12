# 本地 LSP 包

基线：已安装 `@spences10/pi-lsp@0.0.46`（MIT，作者 Scott Spence）。
来源：`~/.pi/agent/npm/node_modules/@spences10/pi-lsp`。
上游发布物只有 `dist/*.js`、声明和不含 sourcesContent 的 map，没有 TS 源码；本地将 10 个可读 JS 模块迁入 `src/` 直接维护，不伪称恢复 TS。不复制 node_modules、无效 source map、过期声明或构建脚本。
保留 `LICENSE`、`UPSTREAM-README.md`、`upstream-package.json`；本地 manifest 私有、不发布、不需要 build。

## 本地差异

- `src/tools.js`：many 支持一个或多个文件，返回字段与可见文本同步：
  - `tool_error_count`：失败的文件检查次数（不是代码错误数）。
  - `diagnostic_error_count`：成功检查返回的 severity=1 诊断数。
  - `warning_count`：severity=2 诊断数。
  - `execution_ok`：所有文件检查均成功。
  - `code_clean`：所有检查成功且 **没有任何诊断**（warning、hint、info、未指定 severity 也使其为 false）。
  - 旧 `ok = execution_ok`、`error_count = tool_error_count` 原义保留，文本明确标为 legacy execution-only。
  - 原 `checked`、`diagnostic_count`、`clean_count` 保留。按输入检查次数统计，不去重。
- 返回聚合结果仍沿用上游普通工具结果，不伪造 Pi `isError`；部分失败可返回其他文件诊断。用户必须检查 execution_ok，不能只看框架的工具调用成功状态。
- `src/prompt.js` 合并重复提醒、重复追加去重；保留完成/提交前检查、不能检查时披露、语义导航及项目测试契约。
- 默认包入口为 `slim.js`，只注册 `lsp_diagnostics_many`、hover、definition、references、document symbols、find symbol 共 6 个工具；不再注册 legacy `lsp_diagnostics`，也不改宿主 allowlist。
- TypeScript 优先使用项目内或 PATH 上的 TypeScript 7 原生 `tsc --lsp --stdio`；即使项目包含旧版 TypeScript，也不会因此退回或要求另装 `typescript-language-server`。其他语言发现逻辑不变。
- Windows 下的 npm `typescript-language-server`、`tsc`、`svelteserver` 从项目 `.bin` 或 PATH 对应安装的 package.json bin 定位实际 Node CLI，以 `process.execPath` 启动；不直接执行 POSIX/.cmd shim、不启用 `shell:true`。全局 TypeScript 版本探测复用同一入口。未知 `.cmd` 不猜测命令或执行shell；原生可执行文件和POSIX启动不变。定向离线回归：`node --test test/spawn-command.test.js`；尚未在 Windows/Linux 实机验收。
- 多文件共享同一 server 启动失败时，缓存复用 server 失败原因，但每项结果重新绑定调用方文件，避免全部显示为首个文件。
- hover / definition / references / document symbols / find symbol、信任和受限环境逻辑保留。
- `src/dependencies.js`：**无全局 resolver hook，无 Web host fallback**。Pi peer（typebox、coding-agent 及辅助包传递 peer）交由当前宿主官方 loader 的 jiti alias/virtualModules 解析。仅三个明确辅助包先用本包正常依赖解析，缺失时用 `~/.pi/agent/npm/package.json` 为解析基点，返回辅助包入口路径并继续在官方 jiti 图内导入。未修改 Node 的全局解析策略；其他扩展不会继承该 fallback。`PI_LSP_HOST_PACKAGE` 已删除。普通 Node 原生 import 不再受支持的离线自动补齐模式；自定义 harness 应使用 Pi loader（或自行提供完整正常依赖），不要依赖本包修改进程行为。

## 工具与 allowlist 决策

默认 manifest、包主入口和 `exports["."]` 均指向 `slim.js`。该入口注册 6 个工具，不含重复的单文件 `lsp_diagnostics`；单文件检查用 `lsp_diagnostics_many` 的单元素 `files`。扩展不会调用 `setActiveTools`，因此仍由宿主权威 allowlist 决定这 6 个工具中哪些可用。

## settings 接入

2026-09-15 主侧已接入兼容入口。原 npm LSP 固定为0.0.46、四类资源禁用，仅保留辅助依赖安装来源；不与本地入口双载。运行中的旧进程须正常重启。

由主代理将原 `npm:@spences10/pi-lsp` 替换为（目录入口已默认解析到 `slim.js`）：

```json
"/Users/guojiahang/Documents/pi/工具/pi-local-runtime/packages/lsp"
```

不要同时加载上游和本地包，避免重复工具/命令。若配置曾直接指向 `src/index.js`，应改用包目录或 `slim.js`。现有 allowlist 的 `lsp_diagnostics` 需由调用方明确替换为 `lsp_diagnostics_many`；不要自动扩大其他工具权限。

## 调用方与验证证据

CLI/Web loader 复核、零 hook reload 证据及必须保留的 npm 辅助依赖详见 [LOADER-VERIFICATION.md](LOADER-VERIFICATION.md)。原 npm LSP 可从 settings 移除；须保留 child-env/project-trust/tui-modal 及传递 pi-settings 的物理安装，避免 uninstall/prune 清理。

扫描已安装 `@spences10` JS：聚合 `error_count` 仅在本包 tools.js 构造；prompt.js 是 many 提醒调用方。format.js 负责逐文件诊断（保留），没有单独聚合 renderer。Pi 默认展示 content，外部 JSON 使用者读取 details；两者均由测试覆盖。未知自定义 harness 若把旧 ok 当代码无错，应改读 code_clean；保留旧字段不会自动修复其误解。

本目录运行（无 UI、无模型请求、无依赖安装）：

```sh
npm test
npm run check
npm run typecheck
```

执行环境 Node 25.1.0、TypeScript 7.0.2、Pi host 0.85.1：
- Node 测试覆盖聚合统计、默认 6 工具注册、CLI/Web 真实 Pi loader 重载隔离、TS 7 优先发现，以及共享 server 启动失败的逐文件归因。
- 所有 src/test/scripts JS 的 `node --check` 通过。
- `npm run typecheck` 实际启动 `tsc --lsp --stdio`，经官方 Pi loader 解析 peer 与 Node 类型，对 `src/test/scripts` 的 JS 文件逐个请求 diagnostics；任何 error 都以非零状态结束。
- 不支持脱离项目解析环境直接运行 `tsc --strict --checkJs src/index.js`：显式文件模式不会使用 Pi loader 的 peer aliases、宿主 Node types 或本包运行时依赖解析，并会递归把整套迁移 JS 当作独立 strict-checkJs 工程，产生大量与真实加载环境无关的 unresolved-module/implicit-any 结果。上游发布物本来就是 JS 且没有 checkJs tsconfig；语法由 `npm run check` 覆盖，真实宿主类型诊断由 `npm run typecheck` 覆盖，行为契约由 `npm test` 覆盖。

已知边界：沿用上游诊断等待/缓存与时间窗口；`code_clean` 只描述返回的诊断快照，不能证明整个项目无错。子任务未执行可见 app、修改全局配置或安装依赖；主侧接入与统一验收见[总入口](../../README.md)。
