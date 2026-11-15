# Pi local memory

本地维护包 `pi-local-memory@0.4.2-local.1`。源码来自 `jayzeng/pi-memory`（https://github.com/jayzeng/pi-memory），已安装 manifest 版本 **0.4.2**；迁移基线已含 2026-09-15 日志按需注入补丁，并非声称与 npm 原版字节一致。MIT，原 LICENSE 保留。

## 本地差异

- 保留日志补丁：日记/交接日志不作为标准上下文读取；仍可 `memory_read` / `memory_search` 按需访问。显式 per-turn 搜索仍可召回日志。
- **退出 LLM 摘要默认关闭**。只有 `PI_MEMORY_EXIT_SUMMARY=1|true|yes|on`（忽略大小写及前后空白）开启；未知值也关闭。转换会话摘要还需 `PI_MEMORY_SUMMARIZE_TRANSITIONS=1`。
- **启动不探测 qmd、不创建 collection、不 embed**，只建立本地快照。首次显式搜索（或显式 per-turn 检索）按需探测/建库；后台模式写入也按需检查/建库，然后防抖 update/embed。缺 qmd 不影响文件工具。
- 不保留上游 postinstall（仅设置开发 Git hooks，非运行必需）；不携带 node_modules、真实记忆、缺失的测试入口或发布配置。Git 入库由主代理统一处理。

七个工具保持：`memory_read/write/search/forget/restore/status`、`scratchpad`。forget 先记录 recovery JSON，restore 幂等。稳定快照保持启动、压缩交接、长期写入/删除恢复、跨日刷新；daily/scratchpad 高频写入不使快照失效。

## 接入

2026-09-15 主侧已在全局 settings 接入本包，并备份/移除旧 npm 安装包；运行中的旧进程须正常重启。以下是配置维护方式。

在 settings 的 `packages` 数组中，将 `"npm:pi-memory"` **替换**为：

```json
"/Users/guojiahang/Documents/pi/工具/pi-local-runtime/packages/memory"
```

不要同时加载新旧包。若原项是对象，只替换 `source`，保留已有资源过滤。CLI/Web 若使用不同 settings，分别确认入口。回退时反向替换；不需要迁移记忆数据。

## 配置

- `PI_MEMORY_DIR`：默认 `~/.pi/agent/memory`，保持原文件布局。
- `PI_MEMORY_SNAPSHOT=stable`（默认）或 `per-turn`；后者每轮检索会变化上下文。`PI_MEMORY_NO_SEARCH=1` 禁止 per-turn 自动检索。
- `PI_MEMORY_QMD_UPDATE=background`（默认）、`manual`、`off`：后两者禁止写后自动 update/embed，但显式搜索仍可探测/建 collection，status 仍可探测。不是全局禁止 qmd 的开关。
- `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS=60000` 默认搜索超时。
- 摘要显式开启后：`PI_MEMORY_EXIT_SUMMARY_MODEL=provider/model-id` 可覆盖会话模型；默认保持会话模型。`PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS=10000`。摘要门槛为 4 条 message entry；最多输入 80000 字符。超时仅丢弃结果，**不保证取消底层请求**。
- qmd 语义/深度搜索缺 embeddings 时，background 模式可自动 embed；status 也保留原有诊断/修复行为。首次模型加载可能联网，需操作者自行批准。

## 离线验证

```sh
npm test
PI_TEST_HOST=/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent npm test
npm run build
```

测试仅合成临时数据：qmd exec 全部替身；新测试摘要 complete 为本地替身，fetch 禁止。现有 `scripts/test-prompt-refactor.mjs` 原样迁移并运行。上游 README 提及的 `test/unit.test.ts`、e2e/eval **未随已安装包发布**，没有联网获取或运行。

`PI_TEST_HOST` 指向提供 jiti/Pi 依赖的安装目录；默认全局 CLI。`tsconfig.json` 是本机显式检查配置，使用该全局安装的声明文件；换机器需要调整 paths/typeRoots，无需复制依赖。当前无可用 LSP 工具/服务，以 `tsc 7.0.2 --noEmit` 替代，结果为零错误。

证据在 `tests/evidence/`：`source.sha256`（只源码文件），`prior-log-injection.patch`（原日志补丁），`local-runtime.patch`（相对迁移基线，可反向还原），`test.log`、`test-web-host.log`、`tsc.log`。

未验证：真实 qmd 搜索质量/索引和模型请求、CLI/Web 真实 UI 生命周期/包切换、Windows、跨日时钟模拟、上游缺失测试。已有 qmd 全局 collection/update/embed 作用域及摘要超时取消问题未重构；本次测试不触碰真实索引。子任务仅修改本包；主侧接入与安装清理见[总入口](../../README.md)。权限和真实记忆未改动。
