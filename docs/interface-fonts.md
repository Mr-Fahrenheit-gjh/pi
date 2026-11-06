# 界面参考字体

用户要求界面采用 Claude 应用的字体，消息正文、代码与终端不变。界面使用独立别名 **Claude Interface Sans**；首页问候和 Pi Web 品牌使用 **Claude Interface Serif**。

## 真实应用来源

本轮在已登录的 `https://claude.ai/new` 读取实际 `@font-face`、computed styles，并核对原始 WOFF2 的 name/fvar 表。上轮采用 `claude.com` 营销官网的 26.043.1 字体，虽为官方文件，但不是应用当前字形，不能凭相同字重数值就声称应用效果一致。本轮已替换为应用实际引用的以下文件。

官方目录：`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/`。

| 本地文件（`public/fonts/`） | 应用引用文件 | 实际名称 / 版本 | SHA-256 |
| --- | --- | --- | --- |
| claude-interface-sans-roman.woff2 | cb48c413e-yAna2Le1.woff2 | Anthropic Sans Beta 26-245-1 Text / 26.245.1 | 5161b683881e79149ff06ace3256e704b920839885032afba6b1a874895e1ced |
| claude-interface-sans-italic.woff2 | c9d3a3a49-CJtkx3-S.woff2 | Anthropic Sans Variable Text Italic / 26.179.2 | ad89863fd0eb36e001166ea2a51e5102d18ffbbe4a0b321291a94d3739a5696b |
| claude-interface-serif-roman.woff2 | c66fc489e-2VcCjn5t.woff2 | Anthropic Serif Variable Text / 26.179.2 | ac9c19c70558c5152b92119f83ca37dded627b524d75552a26fcda015d4106be |

三者均支持 `wght=300..800`。Sans 正体另含 `GRAD=-200..200`（默认 0）、`opsz=12..16`；斜体和 Serif 的实际轴以源文件元数据为准，不用字体 CSS 名字推断。侧栏使用正常光学字号及 `GRAD=0`，不通过浏览器合成粗体模拟参考字形。

版权归 Anthropic。文件未附开放许可，不视为开源；仅供用户明确要求的本地私有定制，不推送或对外分发。公开发布或再分发前须另行核实字体授权，公开可下载不代表许可。

## 正文隔离与渲染验证

`app/interface-fonts.css` 保留原有独立别名。Serif 不注册成 `Anthropic Serif`，避免激活 `--font-answer-default` 的原首选字族而改变消息正文。只替换界面字体文件，不改 `--font-answer-default`、`--font-mono-default` 或用户存储偏好。中文按实际字形回退到系统字体；不能仅凭 CSS 字族串声称已渲染特定字形。

字体随本地包同源加载，不依赖第三方 CDN。验证应核对 WOFF2 字节、FontFace 加载以及浏览器实际渲染字体，不能只用 `document.fonts.check()` 判断。

应用实测导航为 14px / 21px、字重 435，项目/会话为 14px / 400，分组为 12px / 20px / 520。参考应用辅助文字采用中性灰；本地 Light 与 Claude White 仅在侧栏内统一灰阶，不修改消息区和暖色/暗色主题。普通顶层会话与有分叉的父会话共用左文字边缘；折叠按钮独立置于链接之后，只有实际子级增加缩进。
