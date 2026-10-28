# fetch failed 显示修复：已合并，待正式空闲切换

2026-10-13 00:29：已由工作提示/字体任务接手合并并通过统一桌面 quiet-tools、候选主子切换和 launchd 探针。统一 build `43vyDID02ateiPUOqXxVe` 已 prepare，后台等待所有会话空闲。正式状态仍以 `upgrade-0.12-state.json` 为准；当前入口改为 `../工作提示与字体/README.md`。以下原始暂停记录保留追溯，不再作为当前待合并状态。

2026-10-13 用户要求模型 `Error: fetch failed` 不在过程区域外单独显示。精确匹配原始 `errorMessage.trim().toLowerCase() === 'fetch failed'`，错误保留在默认折叠过程内；其他模型错误、回答、截断及权限提示不变。

修复已在维护源码中，未部署。71项定向单测、类型检查、lint、独立生产构建通过；完整桌面浏览器验收未通过，因为并发任务把“正在工作…”改为“Pi is working”，并增加图标/字体断言，测试与首次候选构建不同步。不得将这些结果当成正式验收。

用户已选择：等另一项界面任务完成后合并。本轮worker已停止写入，不覆盖或回退并发改动，不继续写共享候选/证据。后续统一源码冻结后重新构建，完成桌面quiet-tools、主子切换smoke、launchd runtime probe；更新可重放补丁与manifest，再按全部Web会话空闲规则prepare/apply及正式页面真实孩子验收。

## 保存的证据

- 报告：`/Users/guojiahang/.pi/agent/sessions/--Users-guojiahang-Documents-pi--/subagent-artifacts/6228421e-26b0-4af7-b3c8-581dfd17f92e_worker_output.md`
- 精确本轮补丁、首次构建源码快照与日志：`/Users/guojiahang/.pi/agent/sessions/--Users-guojiahang-Documents-pi--/subagent-artifacts/outputs/040c15c3-720e-4d1a-801b-7b45a70a93da/artifacts/`
- 首次独立构建：`/Users/guojiahang/.pi/pi-web-builds/fetch-error-lqdTL4`，buildId `_peSS2c107UDV8t5zKRaL`。
- 共享候选本轮曾替换，未经完整验收，不可直接apply。原有三份通过证据指向旧build `AJafakBiZuoOiuB8H3yZf`，不能支持本候选。

整套pstack测试被本任务插入暂停，尚未安装或完成测试。无未消费子代理或唤醒订阅。
