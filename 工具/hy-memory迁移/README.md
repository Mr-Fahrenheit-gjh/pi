# Pi × 官方 Hy-Memory

## 独立部署与平台边界

以下“已上线”是原维护机器的历史记录，**不表示克隆本仓库后记忆服务已恢复，也不表示 Windows/Linux 已验收**。扩展依赖另行部署的 `127.0.0.1:30147` 模型桥接与 `127.0.0.1:30148` 官方 Hy-Memory 2.0.2 服务、已有私有记忆库/授权/token，以及已安装的 qmd 2.8.3 和现有 EmbeddingGemma 模型文件。本次不安装依赖、不下载模型、不复制任何本机配置。

`bridge.mjs` 可直接由该平台已有 Node 运行。路径设置（均为现有本地文件/包，不接受远程模型下载）：

- `HY_BRIDGE_PI_SDK_ROOT`：Pi coding-agent 包根目录，含 `dist/index.js` 和 `dist/core/http-dispatcher.js`。
- `HY_BRIDGE_QMD_ROOT`：`@tobilu/qmd` 包根目录；仍严格检查 2.8.3。
- `HY_BRIDGE_EMBED_FILE`：已有 `.gguf` 文件；缺失或为目录直接失败，不尝试下载。
- 未指定包根时，只查 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）的 `npm/node_modules`；不会回退到 Homebrew 或另一全局SDK。模型默认仍为用户 `~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf`。
- 仍需 `HY_BRIDGE_TOKEN_FILE` 指向私有 token（至少32字符），已有 Pi 模型授权；Pi 扩展可通过 `PI_HY_MEMORY_CONFIG` 指定本地配置，地址仍限定为30148。不要把 token、授权或数据提交到仓库。

现有 `install_runtime.py` / `models.sh` / `engine.sh` 是 macOS launchd 维护流程，包含本机部署路径，**不是 Linux/systemd 或原生 Windows 服务安装器**；本次保持原样。其他平台需独立管理员部署 Python SDK 服务并验证写入、召回、回执与重启持久化。服务代码的 POSIX 0700/0600 在 Windows 不等价于私有 ACL，不能为启动方便移除权限守卫；Windows 私有存储/ACL 和原生 qmd 后端支持仍须单独验收。只通过桥接路径测试不能宣称完整服务已移植。

## 当前状态

**已上线。** `data/activation-state.json` 记录2026-10-17 `verified_live`；2026-10-19实际 `memory_status` 复核 Hy-Memory 2.0.2、backend ok、accepting true，已补齐共享清单状态。以下迁移及“等待上线”描述保留为原阶段记录，不代表当前仍使用旧插件。

43 个源文件的 181 个原请求已完成，另补迁移期间旧库仅追加的一条长期偏好：合计 182 个 completed、0 unknown。真实偏好召回、43 原文/74 页回读、历史日期来源及两轮冷启动通过；独立审查未发现阻断项。用户随后要求所有 Pi 改动登记到“待上线”后停止，故本轮不切换 settings、不重启 Pi Web，也未卸载旧插件。

受管 `data/` 已准备并验收。自己的 model/engine LaunchAgent 均已停止，保留数据和安装状态，避免待上线期间占用资源；没有遗留自动等待或激活任务。统一交接入口见 `../pi-web维护/待上线/README.md`。

采用官方 `hy-memory==2.0.2` SDK，不以 MemHub 桌面应用的处理队列作为生产入口。整理模型为 Pi 已授权的 `openai-codex/gpt-6.1-sol`、medium；向量模型为 qmd 已有的本地 EmbeddingGemma、768 维。不使用硅基流动，不下载混元 30B；记忆适配不接管 notesoup/AGENTS 上下文机制，也不修改 Pi Web 主题。

`records/sdk-acceptance.json` 是本次脱敏验收记录，不代表已经启用。未来重新获准上线后，`data/activation-state.json` 的 `verified_live` 才表示配置切换和重启验收完成；SDK/HTTP 测试成功不等于已上线。

## 接入边界

- 官方 SDK 负责提取、记忆协调、向量检索和持久化。本项目仅提供 Pi 工具、OAuth/本地模型接口、权限隔离及故障回执适配。
- Pi 六个工具：`memory_write/search/read/update/delete/status`。写入同步完成并回读 canonical 事实；官方 L1 原始记录不通过私有 SDK 接口暴露。
- 显式 `memory_write` 保存记忆；用户新提示可触发最多 1500ms 的可选预召回。**没有全会话自动采集**，没有另启主 Agent 模型来整理整段对话。
- global 保存跨项目长期偏好；project 按工作目录隔离；archive 保存历史日志。自动预召回只含 global 和当前 project，历史记录不作为当前指令注入。
- `memory_read` 可读 canonical ID，或读取保留的 `MEMORY.md`、`daily/YYYY-MM-DD.md`、写入/纠正请求的 `entry:<request_id>` 原文。应用侧来源索引补充 SDK 公开事实未保留的原始文件引用，读/搜返回可读取的 provenance；不修改 SDK 事实或排序。历史来源与日期保留，不把代理日志伪装成人类原话。删除当前事实不会抹除授权原文或备份，不提供彻底抹除承诺。
- 长期记忆与 42 份 daily 共 43 个源文件准备成 181 个幂等请求；不导入删除恢复区或 notesoup。原有 101 文件完整备份并逐文件核验，旧库不删除；qmd 另有归档用途，不卸载。

## 安全与失败语义

- SDK 仅连接 `127.0.0.1:30147` 模型适配器，Pi 仅连接 `127.0.0.1:30148` 记忆接口；后者使用私有 token，拒绝浏览器 Origin。原始凭据不写入源码、配置正文或日志。
- SDK 的 `MEMORY_PIPELINE_TRACE_ENABLED=false` 只关闭可选数据库 trace，**不能关闭 JSONL 日志**。JSONL 可能含提取事实；因此在 SDK 导入前设置正确的 `MEMORY_DATA_DIR`、`MEMORY_LOG_DIR`，全部限定在私有 store 内，目录 0700、文件 0600。不得宣称这些日志没有记忆正文。
- 模型失败时阻止官方 degraded ADD_ALL 兜底进入 writer，不以“未检索到”冒充后端失败。
- 每个 mutation 在发送前生成稳定 `request_id`。断线、取消、超时、非法 JSON 都返回该编号：先查 `memory_status`，不要盲目重发。
- 回执 `completed` 可安全复用；进程中断时的 `running` 转为 `unknown`，不自动重放。未知结果须人工核对已落盘事实；明确无副作用的校验错误不留下未知回执。
- SDK 2.0.2 曾在异步 trace 写入与 close 并发时出现 native 崩溃。关闭可选数据库 trace 后，当前独立进程/并发读取/停机重启测试通过；这是规避，不是上游修复保证。

## 受管运行目录

`~/.pi/agent/hy-memory/`：

- `runtime/`：适配器与服务源码副本；`runtime/plugin/`：Pi 扩展。
- `venv/`：已安装官方 SDK 的隔离 Python 3.13 环境；依赖冻结见 `requirements.lock`。
- `data/`：完成隔离验收后冷拷贝的正式记忆库、回执及原文 archive。
- `bridge-token`、`config.json`：私有 token 与仅含本地地址/token 文件路径的配置。
- `settings-before-cutover.json`：切换前设置原始字节，保留回退；旧记忆仍在原位置。

正式后台角色为 `cn.pi.hy-memory-models`（30147）与 `cn.pi.hy-memory`（30148），当前均已停止。迁移用临时角色 `cn.pi.hy-memory-candidate` 也已停止，未启用 Pi 插件。`install_runtime.py prepare` 不改 Pi 设置，拒绝覆盖正在运行的 engine；start/stop 仅操作已登记且身份匹配的服务，停机失败必须保留配置与状态。

## 验证与切换

离线测试（无新增依赖、无模型调用）：

```sh
node --check bridge.mjs
node typecheck.mjs
node --test bridge.test.mjs
python3 -m unittest discover -s . -p 'test_*.py'
```

需本机受管 SDK 环境及授权模型的合成验收：

- `sdk_smoke.py write` / `read`：实际写入、语义召回、旧事实退出当前召回、无关偏好保留、作用域、删除及新进程持久化。
- `service_smoke.py` / `pi_smoke.mjs`：HTTP 十项（含来源读取与隔离）及真实 Pi SDK 的六工具注册、写/搜/删。
- `transport_smoke.mjs`：四类模拟传输故障保留编号并查询回执。
- `fault_smoke.py`：真实丢响应后回执恢复、模型后端不可用不返回空成功、并发读取后的干净停机/重启、中断回执不重放。仅含合成数据，启动独立候选进程；会临时停/启本任务模型服务，不碰正式 Pi Web。

`run_migration.py` 是最初自持候选入口；长迁移实际改用独立 launchd candidate + `migrate_sdk.py`，避免 Pi 会话取消时连带杀死服务。最终候选为 `~/.pi/agent/hy-memory/candidate-data`，已经冷拷至受管 `data/`。最初被取消的隔离库（92 completed + 1 未确认）未被重放、未用于正式数据；不得把该失败尝试当成最终库。每次写入先查回执，未知即停，不能在结果不确定的同一库里盲目重试。`cutover.py` 将完整请求集合、导入清单哈希、回执、保留原文和 staged-store 绑定；空/部分/重复/旧清单证据均拒绝切换。

未来统一上线先运行 `python3 cutover.py check-source`。旧插件在待上线期间仍可写入新记忆，不能忽略源哈希变化。仅 `MEMORY.md` 非空追加时可用 `refresh_append.py` 生成新快照和独立 delta 请求；其他文件变化或删除必须另行核对，不能直接跳过或假装已同步。补齐增量后重新核验 archive、完整回执及 staged-store 身份；现有 `stage` 拒绝覆盖已有正式目录，不要绕过单写者和冷拷贝检查。

源与依赖仍匹配且重新获准上线时，先启动 `install_runtime.py start models`、`start engine`，等本地服务健康，再复核正式库。`activate.py` 是仅记忆配置的重启入口：复用现有 Pi Web 空闲/PTY/部署锁守卫，授权只豁免当前会话，不能中断其他活跃任务；不修改或重建 Web 安装包。停 Web 后才允许原子替换唯一旧插件条目；全部其他设置保持原样。提交前再次检查源库和设置，避免覆盖并发变更。

`pi_live_smoke.mjs` 使用正式 settings 与实际已安装扩展，检查旧插件未加载、新工具健康、真实偏好可召回、带日期历史原文可读；不发主 Agent 模型请求。Web 健康、BUILD_ID 不变和实际加载通过后才记录 `verified_live`。

失败时保留两份记忆库；回退要求 Web/已知 CLI 写者已停止、settings 精确匹配切换结果。若上线后已有新记忆写入，拒绝自动回退以免隐藏新事实，需人工核对后处理。不以回退设置代替记忆数据迁移。

## 文件与证据

- `bridge.mjs` / `sdk_engine.py` / `sdk_service.py`：官方 SDK 薄适配。
- `index.ts` / `package.json`：Pi 原生扩展。
- `prepare_migration.py`：离线准备；`migrate_sdk.py`：稳定 ID 的实际导入。
- `install_runtime.py`、`cutover.py`、`activate.py`：受管安装、完整性与配置切换、受保护重启。
- `records/`：只提交脱敏的功能/版本证据；不包含记忆、凭据、prompt/response。
- `data/`：全部忽略，包含原始备份、实际导入材料、私密 store 与诊断日志。不要入库。

前期 MemHub v1.0.2/build97 的模型/向量 probe 通过，但手工导入队列不消费，因此不作为生产入口；没有修改其数据库任务状态、权限或发行包 manifest 绕过验收。早期证据 `records/verification.json` 仅描述该阶段，不代表当前 SDK 或正式上线状态。

qmd 当前固定使用 2.8.3 的 `dist/llm.js` 接点；Pi 使用本机 SDK 的 HTTP 初始化/扩展接口。升级 SDK、qmd 或 Pi 后必须重验合同，不能无条件覆盖本地定制。
