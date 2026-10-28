# Pi 附件展示

- 阶段：全局 CLI/SDK 1.4.0 已更新类型标记，安装检查和12项测试通过；既有TUI正常退出重开后生效，不强制结束任务。
- TUI：图片`[image.1]`；PDF、Word、表格、文本、数据和代码按扩展名显示，如`[pdf.2]`、`[docx.3]`、`[txt.4]`、`[ts.5]`；未知类型才用file。
- 只按扩展名识别，不读文件正文；编号共用paste registry，删除不重排。真实路径、引号与空格在发送/历史/排队/外部编辑器中保留。
- `node --test 工具/pi-attachment-presentation/install.test.mjs`：真实SDK/CLI bundle临时模块、v1兼容、短标记、迁移/中断续跑/锁/回退冲突测试。
- `node 工具/pi-attachment-presentation/install.mjs --sdk /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent --check`：只读验真，当前pending为空。
- 重放仍须当轮全局修改授权，使用`--apply --allow-external`；不自动重启既有TUI。
- 先安装向后兼容helper；v2编辑器和消息渲染器显式选择typed API，避免迁移半途丢路径或缺导出。
- 锁内重验原备份与全量manifest；写入/回退前核对当前字节。恢复失败继续处理其余文件，并保留兼容helper。
- 首次原备份：SDK `dist/pi-attachment-presentation-backup/`；v2迁移前态和哈希manifest：`dist/pi-attachment-presentation-v2-backup/`，均不覆盖原备份。
- 回退v2时核对manifest的after哈希，按记录逆序恢复before字节（helper最后）；拒绝覆盖后续改动。强制中断遗留锁须先核实owner，不能盲删。
- Web源码：`../pi-web维护/pi-web-source-0.12.1-custom/`；附件只显示紧凑卡片，不在输入区重复编号，沿用现有主题和预览器。
- 未验证：用户实际终端逐字拆分的非bracketed-paste拖入；已有TUI不会热更新。
