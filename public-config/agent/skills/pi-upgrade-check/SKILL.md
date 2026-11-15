---
name: pi-upgrade-check
description: Pi版本与升级对象的只读检查。用于提到新版本、升级或兼容问题；区分CLI、Web内嵌内核与Web界面，Web升级转统一定制维护流程，不覆盖官方整包。
---

# Pi 升级检查：先分清升级对象

## 只读核对

```sh
bash ~/.pi/agent/skills/pi-upgrade-check/scripts/check.sh
```

它报告全局CLI/Web安装声明和npm最新版本；**CLI已更新不代表Web内嵌内核已更新**。另读实际Web包`node_modules/@earendil-works/pi-coding-agent/package.json`，分别说明：CLI、Web内核、Web上游版本与本地定制。

核对精确目标、变更收益/兼容点及回退；对象有实质歧义时一次澄清。已有本轮修改/依赖/发布授权就复用，不反复询问同一授权。没有授权不安装。

## Web或Web内核：统一入口

读取 `{{REPO_ROOT}}/.pi/skills/pi-web-maintenance/SKILL.md`，按其预检、隔离候选、增量验证、唯一守卫与正式验收执行。

- 配置与源码身份从 `工具/pi-web维护/native-agent-switcher/local-update.json` 读取，不使用历史版本目录作为当前入口。
- 以本地定制为主迁移上游；不运行官方Web全局安装来覆盖或回滚定制版。
- 先解决便宜的合同/SDK/真实历史阻碍，再安装获准依赖或构建；已验证运行输入不变就复用候选。
- Web内核与Web版本分别确认；所有Pi包精确对齐，恢复双接点和子代理兼容不能遗漏。
- 重启不另行确认，其他会话与 PTY 保护不变。部署后以原任务退出0、正式构建及真实孩子验收为准，HTTP200或`pi --version`不能代替Web验收。

## 仅CLI

明确仅CLI时，按获准精确版本更新CLI，不自动升级Web。全局安装/依赖变更仍先确认；保留旧版本与回退方法，并核实实际CLI版本，不把它宣称为Web内核更新。

本技能运行副本为本目录`SKILL.md`；工作区版本源：`{{REPO_ROOT}}/工具/pi-web维护/skill-sources/pi-upgrade-check/SKILL.md`。维护时同步源与副本，不覆盖其他脚本。
