# 当前页凭据填充

任务已经在获准的 agent-browser 会话中打开登录页后，把钥匙串里保存的账号密码填进去（只填写，不提交）。此入口不支持 Playwright/OpenCLI 当前页，不为填密码另开或切换浏览器；应复用原后端登录态，必要时由用户在那里登录，不询问密码。

## agent 怎么用

技能版本源为本目录的 `skill/SKILL.md`，运行副本为 `~/.pi/agent/skills/password-fill/SKILL.md`；修改后逐字同步。先按 browser-harness 选择后端，再决定此工具是否适用。核心就两条命令：

```sh
node pw.mjs accounts [--session NAME]                 # 当前页面这个网站保存了哪些账号
node pw.mjs fill [--session NAME] [--account 用户名]  # 填写
```

- 自动找到 agent-browser 当前标签页，不用再手动传 CDP 地址、targetId。
- 账号按网站匹配：同一网站的不同子域（`www.` / `login.` / `passport.`）通用，和 Chrome 一样；`github.io` 这类多人共用的域名除外。
- 自动识别不到输入框时，用 `--user-selector` / `--password-selector` 指定。
- 返回 JSON，`status` 为 `FILLED` / `NEED_ACCOUNT` / `FAILED`，失败时 `hint` 里写了下一步该怎么做。

## 你自己需要知道的

- **开关**（已开启）：在「终端」里运行 `python3 -I permission.py revoke` 关闭，`python3 -I permission.py setup` 重新开启。agent 不能替你开关。
- **密码来源**：钥匙串里 service 为 `local.pi.chrome-enrollment.v1` 的 101 个条目（从 Chrome 导入）。网站/账号目录在 `~/.pi-current-page-fill/accounts.json`（不含密码）。
- **钥匙串弹窗**：条目信任的是 Homebrew 的 Python（现为 3.14.2）。如果 `brew upgrade` 升级了 Python，第一次读取可能弹出钥匙串授权，选「始终允许」即可。
- **安全边界**：密码只经本机私有管道进入页面；但网页自己的脚本能读到填进去的密码（和你手动填写一样），同一用户下运行的恶意程序也能绕过这些限制。

## 文件

| 文件 | 作用 |
|---|---|
| `pw.mjs` | agent 入口：找当前页、选账号、调用 fill |
| `fill.mjs` | 核心：通过 CDP 校验页面和输入框后填写 |
| `accounts.mjs` | 网站/账号目录与同站匹配 |
| `permission.py` | 开关（setup/revoke）及钥匙串读取 |
| `test.mjs`、`test-pw.mjs` | 合成测试（本地 HTTPS 页面、假密码，不碰真实钥匙串和网站） |

```sh
node test.mjs && node test-pw.mjs && tsc -p tsconfig.json
```
