# 快速路径：命令、缓存与边界

工作目录：`<工作区>/工具/pi-web维护/native-agent-switcher/`。这些是只读或候选内操作，不是发布器。没有安装依赖或系统配置授权时，不执行那些动作。

## 常用命令

```sh
python3 flow.py --features                    # 能力地图：设置/语言/API/e2e/已有定制
python3 flow.py                               # 只读预检：配置、合同、依赖、发布状态
python3 flow.py --validate --profile ui --test components/X.test.mjs
python3 flow.py --validate --profile runtime
python3 flow.py --validate --profile upgrade
python3 flow.py --evidence --dry-run          # 现有证据是否匹配当前 BUILD_ID
python3 flow.py --evidence                    # 生成三件同构建证据
```

- `--validate` 默认仍跑 typecheck/test/lint 和一次生产构建；`--skip-build` 只省构建，不省静态检查。小改动直接跑对应测试，不必为使用统一入口而扩大范围。
- `--evidence` 只写候选/证据，不安装、不切换、不重启。
- 预检覆盖配置、未完成计划、定制 marker、依赖/SDK 接点、候选输入和真实历史；不覆盖守卫的完整指纹、空闲/PTY 保护和正式验收。

## 缓存与并行

- 静态检查默认 2 项并行，最多 3 项。阶段缓存绑定命令、源码/测试字节、依赖实际字节、外部恢复引擎、Node 和环境摘要。
- 文档变化不使运行构建失效；测试变化重验检查但不强迫重建；运行代码/配置/依赖变化才重建。
- `--skip-build` 的结果是 `static_validated`，不能声称已有可发布包。
- 成功记录按精确输入复用；失败/中断/输入变化后只重做受影响阶段。看到旧日志或 BUILD_ID 不等于成功。
- 一个候选只允许一个验证 writer；原进程还活着就等它，不另开构建。取消时先关闭准入，再清理本轮自己的进程组。

## 真实历史

`local-update.json.historyFixtureFile` 必须指向实际存在、已完成且可核对的 parent/run UUID 和助手正文。

```sh
python3 history_fixture.py check      # 只读：归属、正文、父会话已结算
python3 history_fixture.py retain     # 保存完成 run 的原样元数据
python3 history_fixture.py restore    # 仅在索引丢失且原父/孩子仍可验证时
```

父会话必须已结算。任何 pending 恢复状态都在 GET 前阻断；不改写恢复状态、不禁用扩展、不新造模型请求。retain/restore 只处理原始字节，不合成 status，不覆盖现存不同 run。

## 计时

- 候选阶段耗时：`<候选>/test-results/maintenance/validation.json`。
- 证据步骤耗时：`<候选>/test-results/maintenance/evidence/<BUILD_ID>/*.log`，汇总在 `--evidence` 输出。
- 发布阶段耗时：`release-timings.jsonl`（prepare、复制、依赖克隆、等待、切换、正式验收）。

报告耗时区分模型分析、首次准备、实际命令、空闲等待和正式验收；没有实测就不声称节省。
