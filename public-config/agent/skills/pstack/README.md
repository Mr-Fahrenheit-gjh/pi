# pstack：Pi 安装入口

Poteto 工程技能包的跨宿主镜像。工程任务默认先读 Pi 入口，再按规模选流程；自动提示仅含选定技能元数据，不把全部正文注入每次会话。

## 来源

- 原项目：<https://github.com/cursor/plugins/tree/main/pstack>
- 跨宿主镜像：<https://github.com/backnotprop/pstack>
- 固定来源提交：`6f131f137de64fdaf928278c0fd9ecec520ccbee`
- `upstream/` 源于该提交的文件快照（不含 `.git`），保留许可证；该 SHA 是来源基线，不是当前内容逐字未改的保证。未执行上游安装脚本、编排脚本或第三方安装命令。
- 本机执行适配在 `entry/SKILL.md`。**pstack、setup-pstack 必须自动发现**；唯一可选的本地元数据例外为 poteto-mode，允许手动或自动，其余52项必须手动。当前工作树已有移除 poteto-mode 的 `disable-model-invocation: true` 的改动；本批不编辑、提交或回滚它。校验同时支持干净提交的两项基线与本地三项状态，不依赖未提交改动，也不把其他技能动态放宽为自动。
- 后续更新须按授权边界核对基线差异与元数据例外，不自动拉取。

## 安装与使用

版本源为本目录；用户级 `~/.pi/agent/skills/pstack` 软链接到本目录。移动工作区后应修复链接。Pi 会按真实路径去重全局与工作区入口。

已有会话用 `/reload`，或新建会话后调用：

```text
/skill:pstack 用 pstack 排查这个 pi-web 问题
/skill:poteto-mode 严谨地完成这个维护任务
/skill:blast-radius 检查这次修改的影响范围
/skill:tdd 为这个问题写回归测试并修复
```

完整原版指南见 `upstream/README.md`。Pi 使用 `/skill:<name>`，不是 Cursor 的插件命令。54 个原版技能加 1 个 Pi 入口；默认不运行 `/setup-pstack`、不修改用户模型配置。上游默认的 Cursor 模型名不能直接当作本机模型 ID；运行时按当前可用工具与模型处理。

## 边界

pstack 仅补充工作方法，不替代现有 `pi-web-maintenance`、浏览器规则、子代理协议与确认门禁。安装不代表任何维护已执行或正式服务已验证，不重启 30141。

验证脚本：

```sh
node .pi/skills/pstack/validate.mjs --source # 临时无凭据agent目录/链接，验证待上线源码
node .pi/skills/pstack/validate.mjs          # 默认严格检查实际全局链接、发现与去重
node --test 项目/规则优化/运行规则/validators.test.mjs
```

检查55个唯一技能及诊断、基础两项自动和仅 poteto-mode 可选的元数据合同、正文不注入、全局发现和真实路径去重；不验证来源提交的逐文件内容完整性，也不调用模型或服务。回归先恢复已提交元数据，验证两项和三项合法状态，再验证基础技能被禁用、非例外技能误自动以及错误全局链接的负样例。`--source` 不证明运行链接或已有会话生效；默认模式不容忍链接漂移。已有全局链接直接指向本目录，校验器/文档改动不等于修改运行配置或完成重载。
