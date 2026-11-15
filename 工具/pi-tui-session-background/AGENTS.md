# TUI 后台会话维护

- 适配器只能从 InteractiveMode 启用，不改变普通 SDK/Web runtime 的替换语义。
- 同时验证 SDK TUI 与实际 CLI bundle；不得只补其中一份。保留已有 interrupt adapter 的首尾维护合同。
- 回归用独立临时 SDK 副本、faux provider 和 fake terminal，不连接真实模型、复制凭据或修改全局安装。
- 停靠不得 abort/shutdown/dispose 或重复 session_start；reload/退出要处理旧代 UI、交互等待和资源清理。
- `--apply`/`--rollback` 到全局 SDK 必须取得明确授权；源码验证完成不等于当前运行进程已启用。
