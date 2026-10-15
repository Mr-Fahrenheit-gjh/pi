# 交互实用组：滚动、分栏与图片预览

状态：**已于 2026-10-15 11:04 经唯一发布守卫部署并重启 30141，正式验收通过。** 正式 BUILD_ID：`UAewjeq-8uaqnG0TfONQC`；`upgrade-0.12-state.json` 为 `deployed` / `verifiedLive: true`，正式 `live-result.json` 的构建标识一致且 `realChildVerified: true`。本轮没有版本或依赖升级。

参考：[原帖](https://x.com/BystAnd3rs/status/2110404747605709153)及 [open-claude-ui](https://github.com/Caho1/open-claude-ui)。借鉴交互原则，按现有 Pi Web 架构实现；没有引入其组件库、动效库、字体或依赖，没有改变版本号。

## 改动

- 滚动：在 wheel/touch/键盘输入表明向上阅读时，提前脱离自动跟随、取消待执行帧；向下回到尾部或点击“最新”可恢复。代码块等独立滚动区、输入控件的按键不误判为聊天导航。ResizeObserver 处理图片、图表和工具结果的高度变化，但只在仍跟随尾部时滚动。
- 分栏：4px 误触过滤，拖动时用透明命中层保护跨 iframe 的指针事件；Esc、指针取消/捕获丢失、窗口失焦均回退到拖动前宽度，不覆盖已保存设置。正常松手才保存；双击仍恢复各面板原本的默认宽度，而非强制对半。
- 图片：鼠标位置为中心的滚轮缩放（相对适应窗口尺寸 1–8 倍）、4px 过滤后的边界约束平移、双击缩放/还原、工具栏及 +/−/0/方向键。保留原生模态框、Esc 关闭和焦点返回。
- 在 `local-customizations.json` 增补本轮功能标记，后续迁移缺失时明确阻断。

## 验证

在独立 `/tmp` 候选构建，复用当前源码依赖，运行于 `127.0.0.1:30158`，隔离 `PI_CODING_AGENT_DIR`；未读取正式用户会话、未请求模型、未重启正式服务。

```sh
node --experimental-strip-types --test \
  lib/image-viewport.test.mjs lib/chat-scroll-intent.test.mjs \
  lib/chat-lazy-load.test.mjs lib/chat-scroll-position.test.mjs \
  hooks/useResizablePanel.test.mjs
# 34 passed, 0 failed

node_modules/.bin/eslint hooks/useAgentSession.ts hooks/useResizablePanel.ts \
  components/ImagePreview.tsx lib/image-viewport.ts lib/chat-scroll-intent.ts \
  lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
# 无错误、无警告

npm run build # 仅在独立候选目录；构建、TypeScript 检查通过
```

首次独立候选 BUILD_ID：`CYIy5_RfAXDJgVSehA2_d`；随后使用相同源码和正式依赖构建的发布候选为 `UAewjeq-8uaqnG0TfONQC`，已正式上线。构建仍有未改动的会话导出路由动态依赖警告，本轮未扩大修复。

通过 playwright-mcp 的无头、独立浏览器执行 `e2e/interaction-practical.mjs`，8 组桌面检查通过：鼠标锚点缩放、微移/平移、键盘/还原/Esc/焦点/重开、跨 iframe 拖动与撤销、松手保存/清理/双击恢复、输入早于滚动帧取消、流式/内容增高时保留阅读位置、回到尾部恢复高度跟随。页面异常为 0。

证据在本源码忽略目录 `test-results/interaction-practical-20261015/`：`result.json` 绑定 BUILD_ID、运行源码及 package/lock 的 11 项 SHA-256；另有构建/测试日志和截图。浏览器复现入口见 `e2e/README.md`。验收结束关闭页面及候选进程，清理自己的临时候选。

范围限制：交互专项为桌面 Chromium + 合成 SSE 验收，不代表真实模型延迟、手机触摸或 Safari 已验收。正式发布另经真实历史、真实子代理和折叠交互验收通过；未请求模型。

独立审查未执行：workflow `55e098e7-bc00-4134-8a32-3673b2799aff` / child `dc01e4f2-422a-4a7a-8453-d8e8b20db5cc` 因后台宿主预检失败（`Background children require a supported standalone Pi host ... neither is available`），没有产生审查结论，未替换执行协议或修改环境。
