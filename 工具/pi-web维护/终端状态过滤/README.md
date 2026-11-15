# Pi 终端状态过滤

- 当前阶段：已配置到本机 `~/.pi/agent/settings.json`，现有会话执行 `/reload` 后读取；未重启 Herdr 或 Pi Web，当前窗口效果待确认。
- 用户确认的显示范围：Fast 开启时仅在底部模型名后显示 `⚡`，关闭时消失；不再显示独立插件状态行（包括 Fast、LSP、codex-cua）。模型、用量、其他图标、配色不变。
- 闪电仅作用于页脚模型文字的绘制，使用实时 `codex-speed` 状态；不修改真实模型 ID、API 请求、Fast 开关或费用计算。
- 只过滤美化页脚看到的数据；不改原始状态，不禁用 LSP 或电脑操控功能，错误详情通过原有命令/工具查看。
- 启用方式：已安装的 `npm:pi-beautiful-tui` 包配置 `extensions: []`，全局 `extensions` 加入本目录 `beautiful-tui-filter.ts` 绝对路径；原扩展由包装器加载一次。
- 验证：`node --test 工具/pi-web维护/终端状态过滤/footer-status-filter.test.mjs`（4项通过，含真实 Pi 加载器重载回归、Fast开关及切换模型）；`python3 工具/pi-web维护/终端状态过滤/tui-smoke.py`（隔离TTY验证普通终端回退、Ghostty/Herdr图标及仅在模型处显示Fast闪电通过，状态为测试数据）。
- 重载修复：包装器及过滤模块使用 `.ts`，避免原生 ESM 缓存让 `/reload` 继续使用旧过滤逻辑；加载器重载回归测试覆盖修改前后。
- Herdr图标识别另在已安装 `pi-beautiful-tui/styles.ts` 补齐，包更新可能覆盖；此目录不修改字体与终端环境。
## 连续新建会话缺画修复

- `pi-beautiful-tui/index.ts` 在 `session_start` 直接向 stdout 发送清屏指令，但不重置 Pi 的差分画面缓存。真实 `TuiAltScreen` / `TuiMainScreen` 的确定性回归证明：清屏后未变化的输入区可以不再输出；这属于画面失配，不是删除会话文件。
- `session-render-reset.ts` 通过原生 header 工厂取得当前渲染器，在美化扩展的会话初始化完成后请求一次 `requestRender(true)`，使缓存与清屏同步；不拦截全局 stdout、不改变布局或主题、不升级包。普通消息不强制重画，RPC / 非 UI 上下文不处理。
- 验证：`node --test 工具/pi-web维护/终端状态过滤/session-render-reset.test.mjs 工具/pi-web维护/终端状态过滤/footer-status-filter.test.mjs`（8 项通过）；`python3 工具/pi-web维护/终端状态过滤/session-layout-smoke.py`（独立真实 PTY、fullscreen / regular 各连续 10 次 `/new`，另含 `/reload` 与两次 resize，欢迎卡/输入框/页脚完整）；原 `tui-smoke.py` 页脚过滤回归通过。全部隔离测试，不使用真实模型或凭据。
- 边界：最小扩展组合的普通 `/new` 未复现用户完整现场，已确定性复现并修复的是直接清屏造成的缓存失配。未证实用户现场存在 editor 工厂异常，不顺手改 SDK。当前已打开窗口尚未重载，个人完整扩展组合的现场效果仍待确认。
- 生效：在目标空闲会话执行 `/reload`，再连续 `/new` 检查；不用重启 Herdr 或 Pi Web。仅回退本次修复时，将 `beautiful-tui-filter.ts` 中的 `withSessionRenderReset` 导入和调用去掉，保留页脚过滤，再 `/reload`。

- 独立的 Web PTY 环境修复仍是源码提交 `a82d869`，未在本任务构建或发布；与本机状态过滤的启用分开处理。
- 回退：删除全局配置中的包装器路径，将美化包条目恢复为 `npm:pi-beautiful-tui`，在目标空闲会话 `/reload`；不要覆盖其他并发配置。
