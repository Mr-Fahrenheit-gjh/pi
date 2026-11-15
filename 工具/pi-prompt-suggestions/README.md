# Pi 输入建议

基于 [SteelDynamite/pi-prompt-suggestions](https://github.com/SteelDynamite/pi-prompt-suggestions) 的本地适配版。回复结束后，在输入框显示下一句的灰字建议；Tab 或右箭头填入，Esc 隐藏。Enter 不会直接发送尚未接受的建议。

## 安装与启用

从工作区根目录安装本地包，不安装另一份 npm 插件：

```sh
pi install ./工具/pi-prompt-suggestions
pi list
```

本地包已注册到个人设置。新终端会话加载；已有会话需空闲后 `/reload`。不要同时启用上游 npm 版，避免重复请求和编辑器冲突。

Pi Web 适配在 `../pi-web维护/pi-web-source-0.12.1-custom/`。终端与 Web 生成默认开启，无需额外配置。正式发布状态和证据见 [RELEASE.md](RELEASE.md)，30141 只沿维护守卫切换。旧版 Web 尚无灰字界面，新界面要等本次适配上线后才显示；已加载新插件的旧 Web 会话仍可能产生建议请求。需要调整时，合并以下字段到 `~/.pi/agent/extensions/prompt-suggestions.json`，保留已有配置：

```json
{
  "enabled": true,
  "tuiEnabled": true,
  "webEnabled": true,
  "acceptTab": true
}
```

配置每次生成前重读。默认 `enabled`、`tuiEnabled`、`webEnabled`、`acceptTab` 均为 `true`。`enabled: false` 关闭终端和 Web；`tuiEnabled: false` 只关闭终端建议请求，新会话或 `/reload` 后也不再接管终端编辑器；`webEnabled: false` 只关闭 RPC 模式。项目 `.pi/prompt-suggestions.json` 覆盖个人配置。

## 默认行为与费用

- 使用当前会话模型和现有认证，不新增供应商或凭据。`model: "provider/modelId"` 可指定小模型；无效名称沿上游行为回退当前模型。
- 每次真实用户触发的运行最终 settled 后，最多发一次独立请求。中止、内部通知、待处理队列和非交互模式不生成。后台生成不阻塞主回复完成，不唤醒主代理，也不写入对话历史。
- Web 打开已完成的旧对话时，根据当前分支最近四个完整问答轮次生成建议；后台历史读取不会触发。已有草稿、附件、忙态、未完成尾部或过期分支不请求。相同 agent 目录、项目、会话、上下文、记忆快照、模型、提示词及限额的结果在进程内缓存 30 分钟（最多 64 条），重载或空闲实例关闭不清除已完成结果；新主轮次只清理本会话缓存。在途合并与取消仍限各运行实例。不另建前端建议快照，避免关闭配置、提示词或记忆变化时显示未经核对的旧结果；Web 仍只显示扩展验证后发布的 Widget。切走页面不保证取消已经开始的独立模型请求。
- 记忆复用只读取当前项目、当前分支最新用户轮次中已持久化的 `hy-memory-recall`：最多 3 条、JSON 总长 1200 字符、30 分钟内。缺失、截断、过期或本轮已修改记忆时直接省略；打开对话不新增记忆查询。记忆仅作为历史数据交给当前建议模型，不作为指令或授权，并与对话一同参与缓存键；缓存不跨 agent 目录、项目或会话复用。
- 请求包含最近四个完整问答轮次（无可用分支时退回本轮消息）：用户与助手正文、工具调用名与参数、工具结果摘要，让建议能点名具体的文件、命令和数值。助手正文保留末尾 1500 字符；单条工具参数最多 400 字符、结果最多 600 字符，整体上限 12000 字符。不发送思考内容和图片数据；正文、工具参数与结果仍会发给所选模型供应商。默认输出最多 256 token、140 字符，15 秒超时，不自动重试。
- 新输入、下一轮启动、模型切换、分支操作和会话关闭会取消请求并丢弃过期结果。Web 本地开始打字、切换页面只隐藏建议，不向服务器同步每次键入，也不保证已发送的模型请求停止计费。
- Web 只在当前会话、空草稿、无附件、无补全菜单且空闲时展示。接受后是普通未发送草稿；已有内容不会被覆盖。中文输入法不接管 Tab。`acceptTab: false` 保留原生 Tab 行为，可用右箭头接受。
- `maxChars`、`maxTokens` 沿用上游配置；Web 只接收不超过 240 字符的单行建议。终端 `display` 可选 `ghost` 或 `belowEditor`。终端灰字模式会接管自定义编辑器。
- 提示词预测用户自然会说的下一句话，匹配用户语言、语气和表达习惯；不强制点名文件、函数、命令、参数或数值，不强行安排检查、总结或额外任务。过滤允许文件名中的点，单条上限 140 字符。
- 保留每轮要求模型返回一条非空建议的策略，任务完成也不主动留空，但不把“下一句话”限定为新的工作步骤。生成仍受现有网络、超时和输出过滤约束；本次只改提示词，不调整模型、链路或过滤器。提示词每次生成时从本地文件重读，修改它不需要重启 Web。
- 默认不写调试日志。`PI_PROMPT_SUGGESTIONS_DEBUG=1` 仅记录上下文长度、截断输出和诊断，不记录新增记忆正文，不用于敏感会话。

## 维护与验证

上游固定来源、与 npm 发布包的差别和本地修改见 [UPSTREAM.md](UPSTREAM.md)。Web 使用现有 `ctx.ui.setWidget`，没有增加 Pi SDK 接口。`next-prompt-suggestion` Widget 的唯一一行是 JSON：

```json
{"version":1,"id":"生成标识","sessionId":"所属会话","text":"下一句建议","acceptTab":true}
```

本轮进程缓存与记忆复用只改扩展，不改 Web 载荷或页面；源码验证后需扩展 reload 生效，不需重建 Web。不把单元测试当正式性能验收。

本地验证命令：

```sh
node 工具/pi-prompt-suggestions/typecheck.mjs
node --test 工具/pi-prompt-suggestions/tests/extension.test.mjs
python3 工具/pi-prompt-suggestions/validate-web.py
```

前两项默认使用共享维护配置所指候选的现有 SDK 与开发工具，可用进程变量 `PI_SUGGESTIONS_HOST_ROOT` 指向另一已准备宿主。不安装依赖。源码目录的 `node_modules` 可能滞后于锁文件，不能据此判断正式宿主兼容性。

`validate-web.py` 通过共享 `flow.precheck.preflight` 和 `flow.validate` 验证本任务独立候选，不替换共享 `local-update.json`，不覆盖其他对话的候选，也不发布。先将当前 Web 源码同步到 `candidate/package`，排除 `.git`、`.next`、`node_modules` 和 `test-results`，再独立克隆已验证、版本匹配的依赖副本。候选输入变动后按原 runner 的输入身份重新验证。

`tests/history-fixture.mjs`、`tests/verify-history.mjs` 另覆盖打开旧对话、最近四轮、草稿保护、跨会话隔离、缓存重开，以及后台读取零生成、主模型零请求。

`tests/web-fixture.mjs` 在独立临时 agent 目录准备合成会话和零网络的测试供应商；`tests/browser-web.mjs` 由独立无头 playwright-mcp 执行。浏览器覆盖真实 SDK、扩展、SSE、输入框链路，但不使用真实供应商，不代表正式上线验收。测试不接管日常 Chrome。

开发候选默认保存在 `candidate/package/`；获准发布的最终候选路径由共享 `local-update.json` 指定。证据在 `evidence/`，候选和证据均不入库。正式上线仍走 Pi Web 维护守卫；上线前须将本任务候选身份交给共享配置，并重新核对其他待上线项、输入、依赖与同构建证据。回退时先关闭 `webEnabled`，再沿维护流程恢复上一正式包；移除扩展用 `pi remove ./工具/pi-prompt-suggestions`，不要覆盖整个个人设置。
