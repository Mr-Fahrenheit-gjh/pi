# Pi OpenAI / Codex Fast

## 使用

通过 `~/.pi/agent/extensions/codex-speed` 符号链接加载本目录。修改后运行 `/reload`。

| 命令 | 行为 |
|---|---|
| `/fast` | 切换 Fast 开/关 |
| `/fast on` | 开启 Fast |
| `/fast off` | 恢复标准速度 |
| `/fast status` | 查看详细请求与服务端状态 |

Fast 开启且当前模型适用时，底栏按提供商显示 **OpenAI fast** 或 **Codex fast**；关闭或切换到不支持的 provider/API 组合时隐藏。标注表示所选模式，不是服务端档位确认。开关和服务端档位不一致均不弹出通知；详细状态仅在 `/fast status` 查看。命令无效、忙碌或模型不适用时仍提示原因。

作用于 `openai` 提供商的 `openai-responses` 模型，以及 `openai-codex` 提供商的 `openai-codex-responses` 模型。暂不覆盖 Chat Completions 或自定义提供商；不更换模型、不改 thinking。新会话默认 standard；当前分支选择随会话保存，reload/resume 后恢复。生成过程中拒绝切换。

已按用户要求移除 `/ultrafast`、对应参数和补全。旧会话最后选择 ultrafast 时恢复为 standard，不继承更早的 fast。历史测速脚本和原始记录保留，但不属于运行中的模式开关。

## 真实测速（2026-10-04）

当前账号 `gpt-6-astra` 对照：每档预检 1 次、正式 8 次，固定提示词、medium 思考设置和 SSE 传输。总耗时中位数：standard 24.51 秒、fast 10.98 秒、ultrafast 24.65 秒。Fast 有明显典型速度优势，但标准档有两次更快；Ultrafast 未测出额外收益。

全部返回 default，不能凭返回档位判断实际加速或计费。完整方法、数据和限制见 [实验报告](experiments/2026-10-04-astra-sse-proxy/REPORT.md)。

## 实现及费用

- `before_provider_request` 注入：standard → `service_tier=default`，fast → `service_tier=priority`。
- 同时检查当前 provider/API 和 payload model；不承诺覆盖第三方扩展自行发出的嵌套调用。
- 根据 `response.completed.response.service_tier` 记录详细状态。Codex Fast 返回 default 时标记生效未知，不报警；Pi 内置适配器也兼容这种返回。OpenAI Fast 返回 priority 或 fast 均视为已确认；返回 default 则在详细状态记录实际档位，不弹出警告，也不确认加速，不套用 Codex 的特殊兼容处理。
- 不修改 Pi 核心、凭据或套餐，不自动探测、不自动降档，不增加模型请求。
- Fast 会增加额度消耗或费用。2026-10-04 官方列出的 Codex 订阅额度倍率为 2.5×，购买额度/Enterprise 按量计费为 2×；以账号实际账单和后续官方说明为准。Pi 金额估算不保证反映 payload hook 指定档位的实际费用。

OpenAI API Fast 按对应模型的加速档收费，不套用 Codex 订阅倍率。兼容网关是否支持该参数取决于后端；没有服务端确认时不承诺加速。扩展的 priority 参数与 OpenAI API 的 fast 参数等价。

来源：
- https://developers.openai.com/api/docs/guides/priority-processing
- https://developers.openai.com/codex/speed/
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs
- 本机 Pi 扩展文档、类型声明和 Codex 适配器。

## 验证与卸载

```sh
node --test ~/Documents/pi/工具/pi-codex-speed/speed.test.mjs
```

测试覆盖请求参数、开关、简洁底栏、详细状态、provider/model 隔离、旧 ultrafast 状态迁移、会话恢复和忙碌保护。新增 OpenAI Responses 的开关、档位别名、default 回退提示、错误、恢复及跨提供商事件隔离测试。本次适配不重新运行付费测速；上方历史测速只代表当时的 Codex 路径，不代表当前 OpenAI 路径。

卸载：移除 `~/.pi/agent/extensions/codex-speed` 符号链接后 `/reload`，源文件和历史记录可保留。
