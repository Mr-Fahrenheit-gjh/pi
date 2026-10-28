# Browser registry refresh：定向红→绿证据

遵循 `diagnosing-bugs`：读取主侧原始红灯，建立最小真实 host 回归，连续复现，对照/探针区分候选，修复后清理探针并重跑原组合。范围内未发现 CONTEXT.md 或 ADR 文件。

## 原始反馈与最小化

主侧 `../../../records/combined-2026-09-15T05-44-26.651Z.log`：CLI/Web 0.85.1 都在 general → browser full/basic → coding → browser full/basic → full 缺 CU/HTTP，7 LSP 恢复，active 列表在 browser 刷新前后相同。

新增 `browser-refresh.mjs`，仅真实 SDK + 本包 + 相邻 browser 入口 + 两个 SDK customTools mock。移除 memory/LSP/Agent/子 session 和多次模式往返，保留最小触发步骤：

```sh
node tests/browser-refresh.mjs
```

修复前连续运行两次，两 host 均报：

```text
AssertionError: full must restore unchanged CU/HTTP after browser refresh
actual Set(5), expected Set(7)
missing: chatgpt_computer_use, credential_login
```

对照命令 `node tests/browser-refresh.mjs --control` 仅去掉 `/browser-mode full`：两 host 都 PASS。说明一次真实 schema 刷新已足以触发，不需要 LSP 或多次切换。

## 候选与探针结论

1. 元数据引用变化清除 hidden：预测值相同、引用不同。
2. browser 恢复 active 不同步：预测 browser 返回后的 active 偏离之前列表。
3. mock provenance 不完整：预测来源缺必需字段，即使不刷新也不能恢复。

定向比较两 host 的两个 mock，全部得到：

```text
sourceReferenceStable=false
parametersReferenceStable=true
metadataValuesEqual=true
provenanceComplete=true
```

browser 前后 active 完全相同。因此确认 1，排除本次链路中的 2/3。旧 hidden 校验将 host 重新构造的 SDK sourceInfo 当作替换，错误永久清除了合法 CU/HTTP 的恢复记录。

## 修复及边界

`index.ts` 改存 sourceInfo/parameters/description/promptGuidelines 的规范化 JSON 可见值快照。键排序使等值克隆和对象字段重排可恢复，数组顺序保留；字符串快照也能发现原地值修改。保留完整 host registry 上限检查、只记录自己从 active 隐藏的工具、不增加 hooks、不改变默认 full。

不同来源、参数、描述、指引的替换仍不恢复；缺失或不支持的元数据不建立恢复记录。官方无 executor identity/generation API，无法鉴别伪装成完全相同可见定义的同权限替换；这不是防恶意扩展的安全边界。不能用引用失效替代此接口缺失，导致同一合法定义刷新后丢失能力。

新增 mock 测试：等值 provenance/schema 克隆、字段重排、来源/schema/描述/指引的原地变更、循环/非 JSON 元数据。原授权上限与恢复失败断言保留；原来“新空 schema 对象也算替换”的测试改为真正不同的 schema 值。

## 绿灯与清理

已移除临时引用比较输出；回归保留元数据值相等与 active 不变断言，无生产日志/调试 hooks。

```sh
node tests/browser-refresh.mjs
node tests/browser-refresh.mjs --control
npm test
tsc -p tsconfig.json --strict --noEmit
```

两 host 最小回归 PASS；本包 mock/host 测试 PASS；strict/noEmit 零诊断。均不执行模型或桌面工具。

原组合未经修改重跑：

```sh
# pi-local-runtime 根目录
node tests/run-combined.mjs
```

生成 `../../../records/combined-2026-09-15T05-51-29.397Z.log`：两 host status=0，result=PASS，runnerErrors=[]，forbidden=[]，FINAL exitCode=0，稳定哈希检查通过。原始多次 profile/browser 往返、子 session 往返、limited allowlist 与 shutdown 尾部断言全部执行完毕。本次未修改外部 tests/records 的测试或既有记录；仅运行脚本生成新日志。后续只补本文档证据，没有变更组合已验证的源码。
