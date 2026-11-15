# CLI/Web 离线 loader 复核

## 结论

删除进程级 `registerHooks`，无需做 hook 单例、引用计数或 shutdown 清理。每次 reload 新建本包普通模块状态，不增加任何 resolver hook；本包不修改其他扩展的解析规则。宿主 peer 由 Pi 官方 loader 处理，CLI 不再退回 Web 的 Pi 实例。

已读取两份真实 loader：其源码相同，`loadExtensionModule()` 用 jiti，Node 模式有 `getAliases()`，bundle 模式提供 `VIRTUAL_MODULES`，包含 coding-agent/typebox/tui 等。辅助包通过动态绝对路径 import 保持在 jiti 图中，其传递 peer 使用本次加载宿主的 alias。只解析三个明确的辅助包名称，不进行命名空间通配 fallback。

## 执行证据

命令：本包目录 `npm test && npm run check`。Node 25.1.0，11/11 测试通过，JS 语法检查（含 slim 和 fixtures）通过。另执行 `PI_LSP_TEST_HOST=/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent node --test test/diagnostics.test.js`，Web host 下原 9 项合成测试也全部通过。

真实 loader 路径（均为 Pi 0.85.1）：

- CLI：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`
- Web：`/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`

`test/loader.test.js` 调用上述模块真正的 `loadExtensions()`，不是 mock registerTool；入口取本包 manifest。每个宿主重复 10 次：clearExtensionCache → loadExtensions → 验证 7 个工具、lsp 命令、单份 before_agent_start handler → session_shutdown → runtime.invalidate。

测试在加载期间将 Node registerHooks 替换为计数并抛错的哨兵，并 syncBuiltinESMExports，验证两宿主各 10 次 reload 后调用数为 **0**。同时验证：

- 本包导出的 defineTool 与所选真实 host 导出严格相等；CLI 没有混用 Web host。
- 仅三个明确辅助包可由 resolve_helper 解析；直接请求 pi-settings（非本包直接依赖）或无关扩展名被拒绝。
- 无关扩展 fixture 直接裸导入 pi-child-env，在本包加载前、10 次 reload 后均失败，错误仍指向缺失辅助包；没有继承本包 fallback。
- 原生 Node 裸 import pi-child-env 仍报 ERR_MODULE_NOT_FOUND，未被全局补齐。

测试仅加载扩展并检查注册，没有启动 Pi CLI 交互循环、Web 服务、LLM、GUI 或语言服务器，没有真实源文件诊断。测试路径是两份发行包的真实 unbundled loader；不声称测试了完整 CLI bundle/浏览器启动流程。

## 必须保留的 npm 辅助依赖

当前使用 `~/.pi/agent/npm/node_modules` 中的：

| 包 | 版本 | 用途 |
|---|---|---|
| @spences10/pi-child-env | 0.1.10 | 限制语言服务器子进程环境 |
| @spences10/pi-project-trust | 0.0.19 | 项目语言服务器二进制信任 |
| @spences10/pi-tui-modal | 0.0.24 | /lsp 模态输出/选择器 |
| @spences10/pi-settings | 0.0.3 | pi-project-trust 的传递依赖 |

Pi coding-agent/typebox/tui peers 由实际 host 提供，不要求在 agent/npm 重复安装。辅助包的实际源码没有复制进本包。

**可以从 Pi settings 的 packages 中移除原 npm:@spences10/pi-lsp，并物理保留 agent/npm 安装树作为辅助依赖来源。** 本包不导入原上游 pi-lsp 代码，也不要求旧包本身物理存在；需要的是以上辅助包及其可解析的传递依赖。仅更改 settings 不等于执行 npm uninstall。不要在接入时运行 pi remove/npm uninstall/npm prune 等可能清理辅助依赖的操作；未来安装树整理可能回收它们，届时应由主代理显式保留辅助包依赖或安排正常本地依赖安装，而非让本包自动安装。当前未改 settings、npm manifest/lockfile 或已安装目录。

直接 helper fallback 基点固定为用户主目录 `.pi/agent/npm/package.json`，不是 Web host，也不会跟随另一个包的 runtime 被全局注册。安装位置不同的环境应提供正常依赖解析；当前未添加更多路径猜测或额外依赖树复制。
