# 工具选择

只用当前实际暴露的工具。下表是选择依据，不是逐项调用的清单。

| 需要 | 首选 | 边界 |
| --- | --- | --- |
| 先看产品已有什么 | `python3 flow.py --features` | 只读一次；能复用就不开发 |
| 定位文件/符号 | 限定目录的 `rg`、`lsp_workspace_symbols` / `lsp_document_symbols` | 找到实现即可，不扫描生成目录或全部历史 |
| 调用关系/类型 | `lsp_definition` / `lsp_references` / `lsp_hover` | 陌生 API 或影响面不清时才用 |
| 阅读与修改 | `read`、`edit`；完整重写才 `write` | 同文件分散修改合并一次 edit |
| 独立只读操作 | `codemode` 的 `Promise.allSettled` | 只并行无依赖、不会争写的操作；检查每个结果 |
| 回归反馈 | 相关单测、`lsp_diagnostics` | 选能发现本次错误的检查，不默认全跑 |
| 页面行为 | `browser-harness` 技能 → 现有 playwright-MCP | 只查受影响页面；需要登录态再读 `opencli-usage` |
| 构建/候选服务/发布 | `task_start`、依赖点 `task_wait`、有界 `task_logs` | 一个构建/发布一个任务；中断先查真实状态 |
| 结束自己的进程 | `task_kill` | 先确认 PID/cwd 属于本轮，不泛化为杀正式服务 |
| 真实需求/授权缺口 | `ask_user_question` | 只问影响结果或权限的缺项 |
| 独立审查 | `subagent` | 只在 API/存储/权限/恢复/发布器改动时开；不是固定关卡 |
| 跨阶段任务 | `todo` | 只追少数交付物，不为每条命令建任务 |
| 收尾 | `git diff`、精确 `git add -- <文件>`、本地 commit | 只提交本轮文件；运行 JSON/截图/日志不入库 |

## 分支

- 用户要求核心/Web 版本升级：先读 `pi-upgrade-check`，确认对象和精确版本，再走唯一维护入口；不是日常样式改动的前置。
- 需要核对正式服务身份/日志：读 `pi-web-service` 的只读部分；重启仍交给守卫。
- 候选与证据：按 [release.md](release.md)，路径来自 `local-update.json`。
- 每个分支只加载下一步需要的技能，不并列调用全部技能，不为已有流程安装新工具。

## 浏览器

- 先复用 `e2e/` 里已有的套件和 fixture；只有本次风险需要页面时才打开浏览器。
- 页面等待用 DOM/定位器，不用 `networkidle` 作通用完成条件。
- 区分“合成响应验收”和“真实历史/正式服务验收”，在记录里写清楚。
- 工具/脚本失败先判断是验收设施故障还是产品故障；只修验收脚本时不重建产品。

## 正式服务

重启沿用现有守卫。技能修改、文档修改、候选验证都不需要重启正式服务。
