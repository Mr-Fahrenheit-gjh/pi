---
name: pi-web-candidate
description: 在独立目录和端口准备、验证并复用定制Pi Web候选，不影响正式30141。候选路径、输入合同和检查入口交给统一维护技能，不重复构建或误删待发布包。
---

# Pi Web 候选：复用有效结果

先读取 `{{REPO_ROOT}}/.pi/skills/pi-web-maintenance/SKILL.md` 及命中的候选/快速路径引用；这是统一流程，本技能不另建发布入口。

- 当前源码、候选和目标版本从 `{{REPO_ROOT}}/工具/pi-web维护/native-agent-switcher/local-update.json` 读取，不硬编码旧源码版本。
- 先运行维护目录`python3 flow.py`做只读预检；候选已有有效运行输入、依赖、构建与证据时复用，不无条件重新build。
- 源码目录不构建。创建候选时排除`.git/node_modules/.next/test-results`，依赖用独立副本（APFS可用`cp -cR`），不软链接正式包或源码依赖。不为普通界面改动安装/升级依赖。
- 候选就绪后用`flow.py --validate --profile ui|runtime|upgrade`并行、可恢复地检查/构建；升级必须完整测试。输出明确未完成门禁，构建通过不等于发布。
- 长期待发布包保留在适当的候选路径；需要launchd环境时按维护合同使用其可访问目录。只获准本地修改时，不做正式宿主操作。
- 候选服务仅监听127.0.0.1，端口30150–30199，不占30141。浏览器先读browser-harness；真实历史先离线确认完成孩子和已结算父会话，不能为测试触发恢复/新模型请求。
- 结束时关闭自己的临时进程；保留唯一有效待发布包和证据，不因“测试完成”立即删除它。只清理本轮明确失败/重复产物，不动其他会话产物或正式回退。
- 上线需独立授权；上线/重启由唯一`upgrade_when_idle.py`负责；中断先核对原任务，不能再起一次发布。

历史`scripts/run.sh`只在确有需要且核实当前参数后使用，不作为版本、构建复用或发布状态的权威。

工作区版本源：`{{REPO_ROOT}}/工具/pi-web维护/skill-sources/pi-web-candidate/SKILL.md`；运行副本为本目录`SKILL.md`。维护只同步所需文件，不覆盖整个技能目录。
