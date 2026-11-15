# Pi 全局设计技能

- 运行目录：`~/.pi/agent/skills/`；固定来源、提交与内容指纹见 `sources.json`，不自动跟随上游更新。
- 官方 `frontend-design` 保留原版与 Apache-2.0 许可；用于实际前端界面设计和实现。
- 宝玉安装 `claude-design`、`claude-slides`、`claude-design-system`、`claude-dashboard`、`dataviz`；保留完整支持目录和根 `LICENSE`、`NOTICE.md`。
- **许可边界**：宝玉本地工具为 MIT；Anthropic 来源技能、编辑器、字体等没有随仓库获得公开许可，不得将整套宣称为 MIT 或自行再分发这些材料。
- 本地差异唯一入口是 `baoyu-pi.patch`：权限/验证/如实披露以 Pi 约定优先；默认回环访问；修复归档技能及 Claude Code 命令引用。
- 恢复安装：按清单提交检出两仓库，将对应技能完整复制到运行目录，再复制宝玉根许可文件；仅对未修改的宝玉副本执行 `patch -p1 -d "$HOME/.pi/agent/skills" < baoyu-pi.patch`。已有副本先比对，禁止覆盖未知改动。
- `design-deck` 已通过 `pi remove npm:pi-design-deck@0.5.1 --no-approve` 移除；没有改 Pi Web 源码或清理历史方案。宝玉编辑器通过本地网页使用，不提供原 Pi 内嵌选项及选择回传。
- 私有回退副本：`~/.pi/agent/backups/design-skills-20261102-184936/`，不入库；恢复时只合并本任务条目，不整包覆盖配置。
- 验证：安装中 Pi Web SDK 的 `loadSkills` 正确发现六项且无相关诊断；官方正文未改，支持文件与固定来源一致。
- 验证：四个 `artifact.mjs check` 均为 0；编辑器入口与 18 个直接 JS/CSS 引用 HTTP 200，仅监听 127.0.0.1；测试服务全部停止。
- 卸载前后对比确认其他配置、直接依赖、锁文件条目不变；既有 Git 暂存内容未动。未验证真实设计质量、浏览器编辑/评论及 PDF/PPTX/PNG 导出。
- 已有会话执行 `/reload`；可显式使用 `/skill:frontend-design`、`/skill:claude-design`、`/skill:claude-slides`。不需要重启 Pi Web。
