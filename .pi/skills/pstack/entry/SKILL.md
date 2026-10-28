---
name: pstack
description: Poteto 工程技能包的 Pi 入口。所有工程类任务默认使用，包括改代码、写程序、修缺陷、重构、测试和工程排障，不以复杂度为门槛；Pi Web 任务同时遵守 pi-web-maintenance，不替代发布守卫。
---

# pstack for Pi

上游技能在 `../upstream/skills/<name>/SKILL.md`；总览在 `../upstream/README.md`。按当前问题加载，不全量阅读。

## 本机执行适配

- 这是工作方法，不增加权限。当前系统、项目和用户授权优先；上游的自主执行、发布、删除、安装依赖等表述不能绕过本机确认边界。
- `Task`、`Agent`、`AskQuestion` 等是跨宿主概念名，必须转换为当前实际工具接口，不照抄参数。委派遵守本机 delegation 规则、工具发现和单顶层 workflow 协议；先确认模型列表才可指定模型，默认继承当前模型，不尝试 Cursor 专用模型名，不因某模型不可用自行改用外部 CLI。
- 本机已有子代理编排与静默完成协议；不另启上游编排后台或修改全局模型设置。按实际任务选用少量有独立收益的分支，不机械套用上游固定并行数量。遇到基础设施阻碍遵守宿主协议，不能用上游“不要阻塞”要求绕过。
- 浏览器操作先读 browser-harness；Pi Web 修改与部署先读 pi-web-maintenance。上游 control-ui / control-cli 不存在时使用现有合规工具，不为此自动安装新工具。
- 不改当前主题、依赖、版本、系统配置，不启动发布；只有具体维护任务获得相应授权后才执行。当前任务验收和 Git 规则继续适用。

## 选择入口

所有工程类任务默认先读本入口，再按任务规模选用匹配技能；小改动不机械展开完整流程。若范围、目标、约束或验收标准存在需用户决定的重要歧义，先澄清；可查事实先核实，已确认事项不重复询问。技能不可用时如实说明，不冒充已调用，也不自行安装。

- 要求完整的 pstack 工程流程：读 `../upstream/skills/poteto-mode/SKILL.md`，再只读匹配的 playbook 与原则。
- 不熟悉技能选择：读 `../upstream/skills/poteto-help/SKILL.md`。
- 根因与系统理解：`how`、`why`；改动影响：`blast-radius`。
- 测试与证据：`tdd`、`create-verification-skill`、`maintain-verification-skill`。
- 架构与独立审查：`architect`、`interrogate`；按授权与预算控制探索规模。

其他技能可直接用 `/skill:<name>`。直接调用上游技能时，也应先读取本入口的本机执行适配。保持回复自然简洁，不为了展示流程堆砌原则名称。
