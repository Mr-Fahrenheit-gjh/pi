# Hy-Memory 迁移约束

- `data/` 包含私密记忆备份和导入材料，全部保持忽略；提交证据不得包含记忆正文、凭据或模型 prompt/response。
- 模型/Embedding 探测通过不等于记忆可用；正式切换前必须验证实际写入、召回、纠错和重启持久化。
- 当前方案保留 qmd 的本地 Embedding，不卸载 qmd，不修改 notesoup。
- 生产入口使用官方 Hy-Memory SDK，不依赖前期受阻的 MemHub 桌面队列；SDK 负责记忆算法，本项目仅做接口与故障保护，不修改 vendor、任务状态、权限或 manifest 伪造成功。
- SDK JSONL 可能含事实正文，必须在导入前将 MEMORY_DATA_DIR/MEMORY_LOG_DIR 限定在私有 store；不能把关闭数据库 trace 当成关闭所有日志。
- mutation 结果不确定时保留 request_id、先查回执，不盲目重发。正式切换须验证完整迁移集合并停旧写者；只替换旧记忆插件条目，不改 notesoup 或其他设置。
