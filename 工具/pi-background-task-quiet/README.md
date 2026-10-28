# 后台任务静默完成适配

用户不希望后台任务通知在正式交付后再触发一轮“验证通过/不影响结果”的回复（2026-10-09）。

本扩展复用已安装的 `pi-background-task`，只拦截 `pi-background-task:completion`：改为保存不进入模型上下文的 custom entry，不调用 `sendMessage`，不产生新模型轮次。保留 task_start/status/logs/send/wait/kill、任务状态、日志和原生命周期。其他插件消息不受影响。

安装：`~/.pi/agent/extensions/background-task-quiet` 软链接指向本目录。用户 settings 的 `npm:pi-background-task` 使用 `extensions: []`，避免原版重复加载；npm 包仍保留和正常更新，适配层从其 `dist/index.js` 加载实现。未修改 npm 包代码。

新会话自动生效；已有会话需空闲 `/reload`。等待后台结果时应使用 `task_wait`，不再依赖完成通知自动唤醒模型。真正失败仍可通过工具返回的状态/日志处理。

验证：官方加载器加载成功，六个工具注册正常；真实 CompletionNotifier 的 interrupted/completed/failed 通知均只写记录，仍标记已通知；其他插件 sendMessage 保持原行为。

当前上游导入路径是本机 npm 安装路径。如果更换用户目录或 npm 包位置，需要调整 `index.ts` 的导入路径。
