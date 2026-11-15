# Pi 菜单栏无刷新导航合同 v1

菜单仍只通过 Chrome 原生 typed Apple Events 操作已定位的本机 Pi 根页面，不执行脚本，不访问浏览器 cookie，不创建标签。网页桥只选择已有会话，不发送提示词、审批或其他 agent 命令。

## URL fragment

使用 URLSearchParams 编解码；字段不可重复，拒绝未知字段和非法值。

- 就绪：`#pi-menu=1&page=<page UUID>`
- 请求：`#pi-menu=1&page=<page UUID>&request=<request UUID>&session=<session ID>`
- 确认：`#pi-menu=1&page=<page UUID>&ack=<request UUID>`；此时 query 的 `session` 必须为请求目标。
- `page` 是浏览器文档内生成、同文档保持不变的 UUID，不存 sessionStorage/localStorage。它既绑定目标文档，也供原生实测确认没有整页重载。
- `request` 是每次导航的新 UUID。Session ID 为 1–200 位 `[A-Za-z0-9_-][A-Za-z0-9._-]*`，且必须解析到当前认证范围内真实存在的 SessionInfo。

## 网页端

1. 只在 Pi 主页面根路径启用。安装 hashchange 监听后，对空 hash 或本协议就绪/确认 hash 宣告当前 page UUID；不覆盖非本协议的 hash。
2. 请求必须是 v1、当前 page UUID，且尚未处理。用已有会话元数据解析 SessionInfo，必要时仅同源 GET 读取；401/403、缺失/非法会话均不选择、不确认。
3. 异步解析后再次确认当前 fragment 仍是原请求；用户转页、内部切会话、新请求或组件清理必须使旧请求失效。只应用最后仍有效的请求。
4. 调用既有 `handleSelectSession`，保留草稿停放、workspace/分支隔离、相同会话不 remount 等行为。为这个调用提供仅跳过其 router.replace 的内部选项；其余调用行为不变。
5. 同步用 `history.replaceState(history.state, "", url)` 确认：query 只移除旧 `session`/`cwd` 后写入目标 session，保留 sidebar 等其他参数；fragment 写 v1 + 原 page UUID + ack。不调用 location.assign/reload 或 router 导航。
6. 正常网页内切换使 query 更新后，重新宣告同一 page UUID。不得出现旧异步请求覆盖用户后续选择。

## 原生端

- 在菜单展开时、仅已授权情况下只读预定位 Pi 标签，短期内存缓存 PID/window ID/tab ID/index/原 URL；不后台持续扫描，不记录非 Pi URL。
- 点击先校验缓存的窗口/标签/原 URL，失效只在任何写入之前重新查找。每次写入仍用 Chrome 执行时求值的条件 specifier。
- 先选择目标 Pi 标签、恢复并置前对应窗口，确认后激活 Chrome。窗口先出现，不等后续会话数据加载。
- 同会话只唤起，不改 URL。已宣告 v1 的页面，保持 path/query 不变，仅条件写入请求 fragment。
- 后续只读确认同源根路径、同一 page UUID、相同 request 的 ack，以及 query 中的目标 session；未确认不提交已读，不重发请求，不降级整页重载。确认后按 [共享未读合同](UnreadProtocol.md) 提交导航开始时捕获的 read token；只有服务器快照可清除新版共享未读，不能在等待后换成新的完成 token。
- 没有任何 pi-menu 协议标记的旧页面沿现有条件导航一次（切换目标时移除冲突 cwd）；新页面加载后会宣告 v1。已声明但格式/版本错误、或仍有未完成请求的页面失败关闭，不视为旧页面降级。
- 源页面变化、目标被重排/关闭、权限失效时不操作其他标签。权限提示仅由用户点击显式触发；预定位/诊断及每次 send 都禁止系统新增授权提示。

## 最小验证

- 网页：严格解析、旧请求失效/快速连续请求、无效/缺失会话、同会话不 remount、草稿/工作区边界、同文档 page UUID 与导航次数保持、另一标签不受影响。
- 原生：缓存命中/失效、重排/来源变化条件拒绝、先唤起后发送、请求/ack 绑定、超时不重试、旧页受限兼容、cwd 冲突移除。
- 端到端耗时分开报告：菜单预定位、点击至 Chrome 激活、页内确认，以及实际聊天内容加载；不把只读查询耗时当完整跳转。
