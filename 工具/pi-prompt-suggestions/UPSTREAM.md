# 上游来源与本地差异

上游是 [SteelDynamite/pi-prompt-suggestions](https://github.com/SteelDynamite/pi-prompt-suggestions)，固定提交 `6284dea31b499ec402d8df7cb31cb78974af711b`。上游 manifest 自报 `0.1.2`，本地版本标为 `0.1.2-web.1`，使用 MIT 许可，保留原 LICENSE。

npm 发布的 `0.1.2` 对应另一提交 `983887b80d04e0234144d399bef8f60675f9300a`，与上述 master 的代码、默认模型和 RPC 门禁不同。本地源码不混用这两个基线，也不自动跟随上游更新。

## 保留的实现

`src/index.ts`、`prompts/suggestion-system-prompt.md` 来自固定提交。TUI 和 RPC 共用这一个扩展的配置解析、预测提示词、上下文裁剪、输出提取和过滤，不在 Pi Web 再写一套生成逻辑。Web 只解析标准 Widget 和处理输入框交互。

## 本地修改

- 用宿主的 `CustomEditor`、`convertToLlm`、`getAgentDir` 与类型替代上游复制的 `pi-local.ts`，适配本机 SDK 1.3.0。
- 用 `ctx.modelRegistry.streamSimple(...).result()` 替代已被宿主移除的 `completeSimple`；认证由 registry 处理，透传取消信号、使用最低支持推理档、独立请求标识并禁用缓存。
- 将可变状态放进每个扩展实例。在最终 `agent_settled` 后后台请求，保留代际校验并加入真实取消、15 秒超时和分支、模型、会话清理。
- Web 显式打开已完成旧对话时，通过专用命令复用同一生成器；按当前分支选取最近四个完整问答轮次，拒绝过期叶子并在发布前复核。已完成结果按 agent 目录、项目、会话及完整输入摘要在进程内缓存 30 分钟（64条），可跨空闲实例/扩展重载复用；在途合并仍限实例。后台历史读取不生成，Web仍只消费扩展核对完整输入后发布的Widget，不另建可能越过关闭配置的前端缓存。
- 正常运行只有真实用户输入可触发建议，不把 `pi.sendUserMessage` 的 extension 输入或 custom 通知当成真实用户。中止、排队和无 UI 模式不请求模型。
- 原始消息先保留 user 和 assistant，再转换与裁剪。不把 bash 输出、自定义消息和压缩摘要转换为 user 后发送。
- 支持中文及其他无空格东亚文字；拒绝控制字符、换行和错误响应。提示词跟随用户语言、语气和表达习惯，每轮预测一条自然的下一句话，不强制技术对象或新增工作步骤；保留非空策略及现有输出过滤。
- 从当前项目当前分支最近用户轮次的原生 `custom_message/hy-memory-recall` 复用最多3条、JSON总长1200字符、30分钟内的召回；不新增搜索，记忆进入独立请求的数据正文和缓存摘要，不提升为系统指令；记忆变更、无效或过期时省略。
- 默认活动模型，不把某个未必可用的供应商模型设为隐式依赖。`enabled`、`tuiEnabled`、`webEnabled`、`acceptTab` 默认均开启；`tuiEnabled: false` 仅关闭终端请求与会话初始化时的编辑器接管，不影响 Web。显式关闭配置仍有效。
- Enter 不接受和发送灰字；Tab 或右箭头只填入，Esc 隐藏。RPC 不装终端编辑器，而是发 `next-prompt-suggestion` 标准 Widget，载荷包含版本、生成标识、所属会话、文本和 `acceptTab`。

`upstream.patch` 描述该固定上游 `src/index.ts` 到本地源码的差异，并新增纯历史轮次选择模块 `src/history.ts`、已召回记忆裁剪 `src/memory-context.ts` 与进程结果缓存 `src/suggestion-cache.ts`。升级时先审核新上游与当前宿主的 API 和生命周期合同，不把补丁成功应用当作兼容性证明。

## 重放补丁

在独立任务目录准备固定上游的 `src/index.ts`，不要覆盖现有本地文件：

```sh
mkdir -p /tmp/pi-suggestions-replay/src
curl -fsSL https://raw.githubusercontent.com/SteelDynamite/pi-prompt-suggestions/6284dea31b499ec402d8df7cb31cb78974af711b/src/index.ts -o /tmp/pi-suggestions-replay/src/index.ts
cd /tmp/pi-suggestions-replay
patch -p1 < /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/upstream.patch
cmp src/index.ts /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/src/index.ts
cmp src/history.ts /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/src/history.ts
cmp src/memory-context.ts /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/src/memory-context.ts
cmp src/suggestion-cache.ts /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/src/suggestion-cache.ts
```

提示词由同一固定提交的原文件修改，唯一运行文件仍是 `prompts/suggestion-system-prompt.md`。`prompt-policy.patch` 单独记录从上游保守留空到本地每轮建议的策略差异。重放它前，先在独立任务目录的 `prompts/` 下载固定提交的原提示词，再执行 `patch -p1 < /Users/guojiahang/Documents/pi/工具/pi-prompt-suggestions/prompt-policy.patch`，并与本地运行文件逐字比较。升级确认后重新执行本地 typecheck、插件用例、Web 相关用例和隔离浏览器，再按原发布守卫上线。
