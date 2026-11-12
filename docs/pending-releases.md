# Pi 待上线清单

左下角 **待上线 + 数量** 打开独立窗口，沿用设置的主题、字体和桌面窗口样式。只收已完成、已验证、尚待人工上线的 Pi Web / 扩展 / 记忆 / 配置改动，不收普通项目或草稿。这里不扫描会话、不重新执行验证，也不判断登记内容是否真的完成；证据由登记者负责。

## 一份共享持久清单

默认目录：当前用户的 `~/.pi/agent/pending-releases`；设置 `PI_CODING_AGENT_DIR` 时，使用该 agent 目录下的 `pending-releases`。

服务端和 CLI 均可通过进程环境 `PI_PENDING_RELEASE_DIR` 覆盖，必须是绝对目录，路径各级不得是符号链接。API 和网页不能指定路径。显式 `PI_PENDING_RELEASE_DIR` 优先于 `PI_CODING_AGENT_DIR`。Web 与 CLI 必须使用一致的环境配置。测试仅使用独立临时目录，不向默认目录登记。

- 每项一个小写 `UUID.json`，`schemaVersion: 1`、独立 `revision`。人和任意模型都用下面的 CLI 写入；**禁止直接覆盖 JSON 文件**。
- 读操作不创建目录，目录不存在视为空。坏 JSON、未知版本、超限或不安全条目明确警告，其他条目仍显示；此时 footer 数量显示 `—`，不冒充完整计数。目录不可访问或超过 1000 项时 API 返回 503，不返回伪空清单。
- 每文件最多 64KiB；字段、数组、文本长度及 UUID 受严格校验；不支持用户提供文件名。新目录 0700、新文件 0600。已有上级目录不被改权限。
- 源会话和代码位置只保存并展示引用文字，绝不读取对应文件。**不登记凭据、真实记忆正文或私密会话正文**；记忆改动只写脱敏摘要和位置。
- `pending` 表示完成且验证通过，计入数量；显式标记 `deployed` 后保留历史，不再计数。已上线条目不可改写或改回 pending；后续修复另登记新条目。

## 唯一写入协议

从源码根目录运行，不需 npm 依赖。条目 ID 由调用方生成并保留，便于重试和交接：

```sh
node scripts/pending-release.mjs --help
node scripts/pending-release.mjs list
node -e 'console.log(require("node:crypto").randomUUID())'
```

准备完整 `ENTRY.json`，以下仅是模板（替换 UUID、时间及合成证据后才能登记）：

```json
{
  "schemaVersion": 1,
  "id": "<调用方保留的小写 UUID>",
  "revision": 1,
  "scope": "web",
  "status": "pending",
  "title": "简短标题",
  "summary": "已完成的改动及当前待上线状态，不写过程流水账",
  "sourceSessions": ["源会话 ID 或文件引用（只展示）"],
  "codeLocations": ["仓库/工作树、文件及提交或明确未提交差异位置"],
  "verification": ["实际验证命令、结果及验证边界"],
  "releaseSteps": ["必要的确认、依赖与人工上线步骤"],
  "rollback": ["可操作的回退步骤和备份位置"],
  "dependencies": [],
  "createdAt": "2026-10-17T10:00:00.000Z"
}
```

`scope` 仅允许 `web | extension | memory | config`；除 `dependencies` 外各证据列表不可为空。`dependencies` 只收其他条目的 UUID，可为空，不可重复或自依赖。缺失依赖在窗口显示未找到；这里不提供调度或自动执行，人工须核对依赖及上线顺序。不要用“待验证”等占位证据冒充已验证。

登记（显式声明已经完成且验证通过）：

```sh
node scripts/pending-release.mjs register --file ENTRY.json --completed-and-verified
```

更正**待上线**条目：先 `list` 读取当前修订，将完整输入的 `revision` 改为 `N+1`，保留 `id` 和 `createdAt`，再提交：

```sh
node scripts/pending-release.mjs update --id UUID --expected-revision N --file ENTRY.json --completed-and-verified
```

人工确认**已经实际完成上线**后，才能显式标记（仅改清单，绝不执行上线）：

```sh
node scripts/pending-release.mjs mark-deployed --id UUID --expected-revision N --confirm-deployed
```

模型完成改动和验证后登记，**登记后停下**，等待人工统一上线；不自动发消息、不调用主 Agent、不运行上线步骤、不重启 30141。复制出的交接说明包含同一条目的源会话、代码、验证、上线、回退、依赖与修订，复制不是授权。本功能自身也需未来统一上线。

### 并发和失败处理

选每项独立 JSON，而非单一总表：不同对话登记互不覆盖，单条坏数据不拖垮整份清单，也不需要全表写锁。代价是列表为逐项原子读取，**不是跨条目的事务快照**；刷新可能读到相邻时刻的状态，不用于自动调度。

同 ID 使用跨进程 `.<UUID>.lock` 目录锁，锁内重读并核对 `expectedRevision`。新登记以独占硬链接发布，更新写同目录独占临时文件、flush 后原子 rename。读者只会看到完整旧版或新版，不会看到半文件。不同 ID 可并行。需本机支持普通 POSIX 文件锁目录/硬链接/原子替换的文件系统，不支持弱一致网络盘。

- CLI 成功退出 0，修订/重复 ID/占锁冲突退出 3，其他错误退出 1；失败不静默覆盖。CLI 输出及错误不要当作已上线证明。
- 冲突后先重新 `list`，不要盲目提高 `expectedRevision` 覆盖别人更新。登记进程在发布后中断，重试同 ID 可能报冲突；核对已有记录，不生成新 ID 制造重复项。
- 锁等待最多约 3 秒，不按时间偷锁。崩溃遗留锁须维护者确认原写入进程已退出、保存现场后再人工清理；CLI 不提供自动删锁或强制覆盖。
- 坏条目由维护者离线备份、核对和修复，CLI 不会用空清单覆盖它。未知版本需兼容处理，不得直接降级覆盖。
- 隐藏 `.tmp` 文件不参与列表；若崩溃留下，只在确认写入已结束后人工处理。正常成功/失败清理本次临时文件和自有锁。

## 只读界面与验证

`GET /api/pending-releases` 由现有 API 来源检查和 Web 认证保护，`force-dynamic`、`Cache-Control: no-store`，只有 GET，无写接口。窗口启动、打开、页面重新获得焦点/可见时刷新，也有手动刷新；不轮询、无 SSE 或模型调用。请求取消、超时、旧响应防护与业务/HTTP/格式错误均不伪装零项。

```sh
node --test lib/pending-release.test.mjs components/PendingReleasePanel.test.mjs
node --check scripts/pending-release.mjs
git diff --check
```

Node 测试覆盖共享目录覆盖、严格校验、坏文件警告、符号链接/路径边界、独占登记、多进程并发与修订冲突、原子读取、历史计数、交接文本、API 返回及刷新竞态；UI 部分是源码合同，不是浏览器验收。

完整 typecheck/lint 与桌面浏览器验收须在独立候选执行，不在无依赖源码 worktree 安装或构建。浏览器需核对主题/字体/布局、footer 数量与不可用态、两页签、详情/长路径、复制成功和拒绝、刷新失败恢复、开关/遮罩/Escape、焦点进入/恢复及 Tab 留在窗口。未实际验证不可宣称上线。
