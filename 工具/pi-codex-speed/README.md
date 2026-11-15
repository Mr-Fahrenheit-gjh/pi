# Pi OpenAI / Codex Fast

## 使用

通过 `~/.pi/agent/extensions/codex-speed` 符号链接加载本目录。源码修改仅在下次加载扩展时生效；已运行会话仍使用旧模块。本次不执行 `/reload`、部署或重启。

| 命令 | 行为 |
|---|---|
| `/fast` | 切换 Fast 开/关 |
| `/fast on` | 开启 Fast |
| `/fast off` | 当前分支显式使用标准速度（default） |
| `/fast auto` | 恢复继承 OpenAI 工作台/模型请求档位；Codex 使用标准速度 |
| `/fast status` | 查看详细请求与服务端状态 |

Fast 开启且当前模型适用时，底栏按提供商显示 **OpenAI fast** 或 **Codex fast**；关闭或切换到不支持的 provider/API 组合时隐藏。标注表示所选模式，不是服务端档位确认。开关和服务端档位不一致均不弹出通知；详细状态仅在 `/fast status` 查看。命令无效或模型不适用时仍提示原因。

作用于 `openai` 提供商的 `openai-responses` 模型，以及 `openai-codex` 提供商的 `openai-codex-responses` 模型。暂不覆盖 Chat Completions 或自定义提供商；不更换模型、不改 thinking。新分支默认 auto：OpenAI 继承请求中已有的 `service_tier`（包括 flex、ultrafast），缺省 default；Codex 仍默认标准速度。`on/off` 是当前分支显式 priority/default 覆盖，`auto` 撤销覆盖。当前分支选择随会话保存，reload/resume/tree 后恢复，旧 standard/fast 选择不变。auto 不显示 Fast 徽标，继承 flex/ultrafast 不显示成已确认 Fast。生成过程中也可切换：不打断已发出的请求，从下一次模型请求（包括同一轮工具执行后的请求）起生效；旧请求的档位确认与用量记录保留。Pi Web 的 GPT 模型菜单可直接操作同一个开关，并可恢复模型设置。

已按用户要求移除 `/ultrafast`、对应参数和补全。旧会话最后选择 ultrafast 时恢复为 standard，不继承更早的 fast。历史测速脚本和原始记录保留，但不属于运行中的模式开关。

## 真实测速（2026-10-04）

当前账号 `gpt-6-astra` 对照：每档预检 1 次、正式 8 次，固定提示词、medium 思考设置和 SSE 传输。总耗时中位数：standard 24.51 秒、fast 10.98 秒、ultrafast 24.65 秒。Fast 有明显典型速度优势，但标准档有两次更快；Ultrafast 未测出额外收益。

全部返回 default，不能凭返回档位判断实际加速或计费。完整方法、数据和限制见 [实验报告](experiments/2026-10-04-astra-sse-proxy/REPORT.md)。

## 实现及费用

- `before_provider_request`：auto 保留 OpenAI 请求档位；standard → `service_tier=default`，fast → `service_tier=priority`。不改 `models.json`，不修改原 payload。
- 同时检查当前 provider/API 和 payload model；其他提供商、API、模型不改写、不记账。该 hook 仅提供 payload，无调用来源元数据，无法识别同 model ID 的第三方嵌套调用；不承诺隔离此类主动转发 hook 的调用。
- 根据 `response.completed.response.service_tier` 记录详细状态。Codex Fast 返回 default 时标记生效未知，不报警；Pi 内置适配器也兼容这种返回。OpenAI Fast 返回 priority 或 fast 均视为已确认；返回 default 则在详细状态记录实际档位，不弹出警告，也不确认加速，不套用 Codex 的特殊兼容处理。
- 不修改 Pi 核心、凭据或套餐，不自动探测、不自动降档，不增加模型请求。
- Fast 会增加额度消耗或费用。2026-10-04 官方列出的 Codex 订阅额度倍率为 2.5×，购买额度/Enterprise 按量计费为 2×；以账号实际账单和后续官方说明为准。Pi 金额估算不保证反映 payload hook 指定档位的实际费用。

OpenAI API Fast 按对应模型的加速档收费，不套用 Codex 订阅倍率。兼容网关是否支持该参数取决于后端；没有服务端确认时不承诺加速。扩展的 priority 参数与 OpenAI API 的 fast 参数等价。

### OpenAI API 用量条目

仅 `openai/openai-responses` 在 `message_end` 为有真实非零 usage 的 assistant 结果追加 `customType: "openai-api-usage"`。不修改历史条目、assistant 账目或 Pi 内核，不发额外请求。`response.completed` 收集返回档位；每次请求、重试的新 response、模型或分支切换清理旧确认。失败/中止且无 usage 不写条目；有 usage 但没有对应完成档位则记 unknown。

固定 `data` 合同：

```ts
{
  version: 1,
  messageTimestamp: number,
  model: string,
  requestedTier: string | null,
  actualTier: string | null,
  cacheTtl: '30m' | '12h' | null,
  usage: { input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number },
  estimatedCostUsd: number | null,
  pricingSource: 'catalog',
  costStatus: 'estimated' | 'unknown',
  responseId?: string,
  reason?: string
}
```

只存上述元数据，不存提示词、工具、内容或凭据。跨 fork 合并优先按 responseId 去重，无则按 messageTimestamp + model；本扩展不重写或合并历史。未指定/未识别 retention 的 `cacheTtl` 为 null，未知 retention 且存在缓存写入时估价 unknown。

估算读取请求发出时 `ctx.model.cost` 快照，不硬编码美元单价。只有精确官方端点 `https://api.openai.com/v1`（允许末尾 `/`）采用下列费率规则；自定义代理端点保守记 unknown，不改变其原有 `/fast` 参数行为：

- 核心 `usage.input` 已扣除 cacheRead/cacheWrite；阈值用三者之和，严格超过阈值后选择最高匹配 `cost.tiers`，整请求使用该档价格，不重复计算缓存普通输入。
- actualTier=default 为 1×；经确认的 `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`：priority/fast 为 2×，flex 为 0.5×。保留核心已知 `gpt-5.5` priority/fast 为 2.5×。
- ultrafast=6× 仅适用精确 ID `gpt-6-astra`、`gpt-6.1-sol`，不猜测 snapshot/子型号。
- 缓存时长优先读取实际 payload 的 `prompt_cache_options.ttl`；存在该对象但省略 TTL 时为默认/null，不回退旧 `prompt_cache_retention`。上述四个主力型号且 `compat.supportsExplicitPromptCacheMode=true` 时，12h 写入价为目录 30m cacheWrite 的 2×；默认/30m 不加倍。其他型号有 12h 缓存写入时保守记 unknown；无缓存写入不影响普通输入输出估算。
- 未报告实际档位、未知档位/未核实型号组合、价格缺失/无效或四项全零（无法与 SDK 为 id-only 导入生成的零价区分）均为 `estimatedCostUsd=null, costStatus=unknown`，不使用 requestedTier 冒充实际档位。估价不是账单，未知项也不是免费。

来源：
- https://developers.openai.com/api/docs/guides/priority-processing
- https://developers.openai.com/codex/speed/
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs
- 本机 Pi 扩展文档、类型声明和 Codex 适配器。

## 验证与卸载

```sh
cd ~/Documents/pi/工具/pi-codex-speed
node --test
```

测试覆盖继承/覆盖/auto 恢复、简洁底栏、安静通知、provider/model/API 隔离、旧 ultrafast 状态迁移、会话恢复和运行中换档，以及 ledger 隐私字段、缺失/实际档位、重试、错误/中止、responseId、模型切换、目录费率、严格阈值、12h 写入和未知估价。本次适配不重新运行付费测速；上方历史测速只代表当时的 Codex 路径，不代表当前 OpenAI 路径。

卸载：移除 `~/.pi/agent/extensions/codex-speed` 符号链接后 `/reload`，源文件和历史记录可保留。
