# 公开分发适用范围

本公开包是单一 Git checkout，不包含作者的个人独立仓库清单或本机发布工作树。先用当前仓库的 Git 状态和实际目录确认范围；以下历史仓库/launchd发布说明仅供维护源码参考，不得据此寻找作者目录、覆盖全局安装或重启服务。公开应用使用根目录 start.cmd/start.sh。

# 独立仓库与 Pi Web 入口

修改独立仓库、核对工作区仓库状态，或升级 Pi Web 时读取。

## 独立仓库

- 权威清单：工作区根目录的 `项目/工作区整理/独立仓库.json`。独立仓库在主仓库显式忽略，不是子模块，不用 `git add -f` 加成 gitlink。
- 在相应仓库内验证并提交；同步清单的 revision/branch，上游变更时同步 upstream。不能只凭主仓库干净就认定独立仓库也干净。
- 需要核对所有仓库时运行：`python3 项目/工作区整理/检查独立仓库.py`。不把这项全量检查作为每次小改动的固定步骤。
- 当前 Pi Web 定制源码与 `pi-web-source-0.12` 共用 Git 公共目录，不能因旧版本名称删除后者。

## Pi Web

- 修改、排障、发布或恢复任务：先读工作区 `.pi/skills/pi-web-maintenance/SKILL.md`，遵守其增量验证、候选保留和守卫发布合同。
- Pi 核心与 Pi Web 是两个升级对象，分别说明、分别确认。Pi Web 是本地定制版，禁止用 `npm install -g @agegr/pi-web@...` 覆盖。
- 升级唯一入口：`工具/pi-web维护/native-agent-switcher/README.md`；先迁移上游差异并保留本地改造和 SDK 恢复接点，独立候选验收后沿守卫发布。
