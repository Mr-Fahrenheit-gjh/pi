# 候选、证据、发布与恢复

工作目录：`<工作区>/工具/pi-web维护/native-agent-switcher/`。只在用户已批准本轮上线/重启时执行写入和切换。路径与版本从 `local-update.json` 读取，不抄旧目录。

## A. 候选只准备一次

源码目录不构建。候选必须是独立副本：

- `candidateDirectory` 指向实际候选包；来源与候选的 `package.json`、运行源码一致。
- 依赖用独立 APFS 副本（`/bin/cp -cR <正式包>/node_modules <候选>/node_modules`），目标必须不存在，不能是软链接。
- 有有效候选就复用；只有实际运行输入或依赖变化才重建。文档或记录变化不使候选失效。
- 候选命名和位置写入 `local-update.json`；测试/证据留在候选自己的 `test-results/`。

然后构建一次（只在源码收敛后）：

```sh
python3 flow.py --validate --profile ui --test <相关测试>
python3 flow.py --validate --profile runtime          # 无定向范围时才跑完整应用测试
python3 flow.py --validate --profile upgrade          # 仅内核/Web/依赖升级
```

`--validate` 的完成条件是 `candidate_built`；它不会安装、发布或运行浏览器。阶段结果与缓存以实际字节、依赖和命令为键，失败不缓存。

## B. 同构建证据一条命令

```sh
python3 flow.py --evidence --dry-run    # 只读：BUILD_ID/候选/真实历史身份 + 现有证据问题
python3 flow.py --evidence              # quiet-tools → launchd 探针 → 真实历史
```

`--evidence` 做四件事：

1. 跑候选预检，阻碍未解决就停止。
2. `e2e/quiet-tools.mjs` 写 `<源码>/test-results/quiet-tools/result.json`。
3. `probe_runtime.py <候选> --launchd` 写 `runtime-probe-result.json`（真实 HOME/CLI/launchd）。
4. 起一个临时候选服务（只绑定 127.0.0.1 的随机端口，跑完即停），跑 `verify-live.mjs <fixture.sessionId> <BUILD_ID> <版本>`，写 `live-result.json` 和 `smoke-result.json`。

最后核对三件证据的 `passed`、`buildId`、`packageRoot` 和精确真实历史（`sessionId`/`realHistoryRunId`/`expectedChildText`），再跑 release 预检，输出 `releaseReady`。日志在 `<候选>/test-results/maintenance/evidence/<BUILD_ID>/`。

- 成功时只读汇总；某一步失败才看那一步日志。
- 真实历史必须指向已有的完成 run 且父会话已结算；`history_fixture.py check` 在任何 GET 前离线拒绝 pending 父会话。
- 旧证据只说明当时状态；不修改 `passed`/`buildId` 让旧报告冒充新构建。
- 不手写 `smoke-result.json`，也不把旧 smoke 复制到新构建。

## C. 一次守卫发布

```sh
python3 upgrade_when_idle.py --prepare <真实历史会话UUID>   # 前台，一次
python3 -u upgrade_when_idle.py --apply                     # task_start 后台，日志写本轮任务文件
```

- 只有用户明确允许重启中断当前会话，才追加 `--restart-session <当前会话UUID>`；一次性豁免，不放宽其他会话/PTY。
- 不运行 `--supersede`/`--refresh-owner` 绕过不明冲突；先查旧计划是否已切换。
- 不手工换 `.next`、不 `launchctl kickstart`、不全局安装官方包。
- `task_start` 返回中断/超时后先核对任务、PID/cwd 和状态；已有 apply 在跑就等它。

## D. 以实际状态结束

只有以下都成立才说已上线：

- `upgrade-0.12-state.json` 为 `deployed`、`verifiedLive: true`；
- 正式包 BUILD_ID 与 `live-result.json` 的 `buildId`/`version`/`sessionId` 一致，`passed: true`、`realChildVerified: true`；
- 证据 base 是 30141，`packageRoot` 是正式安装路径；
- 发布任务退出 0。

不一致就保留失败状态和备份，按恢复分支处理，不宣称完成。守卫内部已做正式验收，不再从外部重跑同轮全套。

## E. 恢复：先看事实，再选动作

| 观察到的状态 | 动作 | 停止条件 |
| --- | --- | --- |
| 构建/验证显示中断 | 查任务、日志尾、实际 PID/cwd 和锁 | 原进程活着就等同一任务；确认退出后才重试 |
| prepare 后中断 | 查原任务是否还活着、stage 与 backup 是否已初始化 | 同一计划可续；backup 已存在或身份变化则转守卫恢复 |
| apply 显示中断 | 查 state、正式 BUILD_ID、任务 | 已 deployed 且身份一致 → 收尾；仍在跑 → 等；未知 → 暂停发布 |
| waiting_for_idle 长时间不动 | 查是否真的有其他活跃会话/PTY | 不强制停别人的工作；必要时报告具体阻碍 |
| failed / rolled_back | 读失败原因，确认当前正式包 | 需要修守卫缺陷时只改本轮必需部分 |
| 探针连接拒绝 | 读探针退出码、端口、日志 | 已知失败就结束那次探针，修正条件后同一协议重试 |
| 唯一候选被误删 | 从源码/依赖重建缺失候选 | 后续保留到发布结束 |

重复发布不是恢复方法；已退出 0 且正式证据一致时直接收尾。

## F. 清理与回退

发布成功并确认稳定正式包和回退位置后，关闭自己的候选进程，清理本轮失败产物；保留有效候选、最终证据和正式回退。私密运行 JSON、截图和日志不入库。源码回退先核对后续提交，再 `git revert` 本轮提交，不回滚其他会话的改动。
