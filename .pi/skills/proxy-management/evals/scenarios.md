# 写作依据与验收

## writing-great-skills 的用法

本技能依据本机保存的 Matt Pocock `writing-great-skills/SKILL.md` 与 `GLOSSARY.md` 编写，来源为 `~/.codex/skill-backups/skills-cleanup-20260928-210831/writing-great-skills/`。已读取原文，不安装或恢复旧技能。该写作技能后来更名为 writing-for-agents；相关上游固定版本入口见 [现有维护技能的来源记录](../../pi-web-maintenance/evals/scenarios.md)。

采用其具体方法：
- 以“实际请求路径”统一判断，而不是把进本机代理等同境外出口。
- description 区分诊断、定向修改、重连复查与原 proxy-env 的职责。
- 主文件只保留有完成条件的步骤；系统设置、测速和恢复细节按分支读取。
- 规则与域名名单仍在原 rules.yaml，技能不维护副本。
- 不把一次 Bilibili 排障记录变成所有任务必须执行的长流程。

Pi 的发现行为以当前安装版本为准。用户全局技能先于项目同名技能，故本技能使用 proxy-management，避免伪装覆盖已有 proxy-env；后者继续负责命令环境变量。

## 场景审阅

这是行为预期与人工审阅表，不代表已经用模型逐场景运行。

| 用户输入／前提 | 应走路径与完成证据 | 应挡住的错误 |
| --- | --- | --- |
| “B站是不是走代理？卡” | 只读查系统路径、PandaFan 状态；按需测速，未知出口明确说明 | 自动改系统；首包慢就断言境外代理 |
| “这个网站直连”且已授权 | 找活动服务、保留例外、补依赖域名、回读和目标／对照验证 | 重复索要相同授权；关闭全局代理 |
| 已有 DIRECT 规则，TUN 开启 | 区分默认规则与运行规则，核实接管层 | 仅看 rules 或系统 bypass 就宣称最终出口已证实 |
| “只让这条 curl 直连” | 转 proxy-env 临时模式 | 修改系统或重启应用 |
| PandaFan 重连后又慢 | 重新检查实际生效状态 | 旧文档记着直连便认为当前仍直连 |
| 活动网络服务不是 Wi-Fi | 映射接口到真实服务再操作 | 写死 Wi-Fi |
| 原绕过列表为空／有其他例外 | 正确处理空提示，保留既有值，备份可恢复 | 将提示当域名、覆盖其他例外 |
| 用户要求直连后缀里某站强制境外代理 | 核实 PandaFan 受支持规则入口和运行结果 | 填 always_proxy 或仅设本机代理就声称境外 |
| networksetup 无权限 | 报错并确认所需提权 | 自动 sudo |
| check 报后台副本漂移 | 查归属与内容、备份，遵守目录外写入授权；区分磁盘与进程 | 隐藏失败；直接重启 30141 |
| 页面可访问，视频仍卡 | 明确网页与视频指标不同，查实际媒体或播放 | 把网页 200 当视频验收 |
| 只有网站链接且一次加载超时 | 先重试，持续失败或有路径异常证据才扩大排查 | 每个链接都启动代理全检 |
| 只修改技能 | 检查加载、引用、脚本与用例，不改网络设置 | 运行 apply、重启服务或重做应用验收 |

## 最小验证

从工作区根目录运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .pi/skills/proxy-management/tests -v
python3 .pi/skills/proxy-management/scripts/system-route.py https://www.bilibili.com/ https://i0.hdslb.com/ https://www.google.com/
```

再用当前 Pi 的 `loadSkillsFromDir({dir, source})` 检查格式，`loadSkills({cwd, skillPaths: [], includeDefaults: true})` 检查默认发现与名称冲突；核对 Markdown 本地引用。只读脚本只查询系统选择、不发出网站请求；未知代理类型按非直连输出，PAC 候选不自动求值。

本轮验证：5 项脚本单元测试通过；当前安装 Pi 的格式、默认发现与名称冲突检查通过；7 处本地 Markdown 引用存在。实际只读查询中，Bilibili 网页、API、图片和视频域名样例均选择直连，Google 保持本机代理；带路径及 query 的输入输出中没有展示路径及 query。Python LSP 未报告诊断。场景表经人工审阅，未调用模型逐场景演练，也未改变网络设置或重启服务。

这些验证证明技能格式、辅助工具和当前系统选择，不证明真实浏览器播放或未来模型每次都遵守。脚本输出不含 URL 路径、query、代理凭据；实际选择仍使用完整输入 URL。
