# 界面参考字体

用户明确要求全站界面使用 Claude 的字体，同时保持当前消息正文不变。UI、输入框、弹窗与工具栏默认使用官方字体文件中的 **Anthropic Sans Web Text**；首页问候和 Pi Web 品牌使用 **Anthropic Serif Web Text**。不改正文、代码与终端的字族、字号、字重设置。

## 来源与身份

来自公开官方 `https://claude.com/` 页面引用的字体，而非根据截图猜测或第三方重新封装。对应官方声明：`https://claude.com/_next/static/chunks/e5def80c1c13272b.css`。

| 本地文件（`public/fonts/`） | 官方文件（`https://claude.com/_next/static/media/`） | SHA-256 |
| --- | --- | --- |
| claude-interface-sans-roman.woff2 | AnthropicSans_Roman_Web-s.p.050e7498.woff2 | 1b75c8ee81a05fa77331366e9602b82072bb5223593c928a6488dfe6fd023f1b |
| claude-interface-sans-italic.woff2 | AnthropicSans_Italic_Web-s.p.6550bf15.woff2 | ffcf21c4e9a729cbf4710401760434bb1d10bc7db244540e4af796d182c6817d |
| claude-interface-serif-roman.woff2 | AnthropicSerif_Roman_Web-s.p.c28786b4.woff2 | e96fe97bb7ba2190a9a227d27380e0c79894408bfc6acea5a511774d93a16f69 |

读取原文件name/fvar表确认：sans正体与斜体均为 `Anthropic Sans Web Text`（默认400）；serif正体为 `Anthropic Serif Web Text Light`（默认300）。三者均含 `wght=300..800` 与 `opsz=16..48`，CSS声明真实可变字重范围，不依赖浏览器合成粗体。

原字体元数据版权：**Copyright 2025-2026 Anthropic PBC**。文件未附开放许可，不将其视为开源字体；本次为用户明确要求的本地私有定制，不推送或对外分发。公开发布或再分发前须另行核实字体授权，不因可公开下载就推断许可。

## 正文隔离

`app/interface-fonts.css` 使用独立别名 `Claude Interface Sans` / `Claude Interface Serif`。后者故意不注册为 `Anthropic Serif`，以免使现有 `--font-answer-default` 的首选字族突然生效，改变用户确认正确的消息正文。只更新 `--font-ui-default`，原 `--font-answer-default`、`--font-mono-default` 与存储偏好不变。用户手动字体覆盖能力仍保留。

字体随本地候选包从同源加载，不依赖浏览器访问第三方字体 CDN；验证须检查 WOFF2真实字节、FontFace加载和实际渲染字族，不能只检查 CSS 字符串或依赖缺失字族时也会返回true的 `document.fonts.check()`。

上述字体文件与字族最初由官方公开网站确认；本轮侧栏另从已登录的 `claude.ai/new` 读取 computed styles 和 DOM 结构，不以营销页尺寸代替应用实测。New/Search 为 14px / 21px、字重 435，导航行高 32px、图标 20px；项目实例与会话文字为 14px、字重 400，Pinned 分组为 12px / 20px、字重 520。New/Search 与列表处于同一非 sticky 滚动容器，品牌和底部区域在其外；本地预览以真实 wheel 验证对应滚动行为。
