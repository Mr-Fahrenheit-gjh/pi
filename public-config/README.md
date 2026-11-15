# 公开配置：提示词、规则、技能、角色与扩展

`main` 和 `pi-web` 提供同一份应用与公开配置，不再要求切换分支才能取得网页端。这里是可审计的配置源，不是作者 `~/.pi` 的备份。

## 包含与排除

- `agent/APPEND_SYSTEM.md`：常驻系统补充提示词；`agent/rules/`：按需实施/委派规则。
- `agent/skills/`：可分发技能及必要脚本、模板、参考与原始许可；pstack 保留完整相对目录结构。
- `agent/agents/`：七个角色正文与角色设置，不含子代理运行记录。
- `agent/settings.template.json`、`agent/extensions/`：可选插件声明及本地适配代码；空资源数组和禁用项保留原意。
- `workspace/AGENTS.md`：工作区规则模板，不替换应用根目录的开发说明。
- `sources.json`：来源与例外清单；`manifest.json`：当前公开配置逐文件 SHA-256。

不包含个人记忆、学习记录、账号/密钥、模型授权、聊天、浏览器登录态、运行缓存、备份、依赖目录或构建产物。记忆插件的**代码**可以在源码中，个人记忆**数据**不能在包中。Pi Meta/Feynman 继续不分发。

**许可例外：**claude-design、claude-slides、claude-design-system、claude-dashboard、dataviz 不附受限正文、编辑器或字体。固定来源、提交、指纹与本地适配补丁在 `项目/规则优化/运行规则/design-skills/`；使用者须自行合法取得原材料。不能把这些材料或整个技能集合一概视作本项目 MIT 许可。

## 显式导入，不覆盖现有配置

```sh
# 只读预览；必须自己选择目标目录
node bin/configure-agent.mjs --target /absolute/path/to/new-agent
# 确认后执行
node bin/configure-agent.mjs --target /absolute/path/to/new-agent --apply
# 同时导入插件代码与声明（下次启动SDK可能联网安装对应npm包）
node bin/configure-agent.mjs --target /absolute/path/to/new-agent --with-extensions --apply
# 可选：给一个项目安装工作区规则；已有不同内容时拒绝覆盖
node bin/configure-agent.mjs --target /absolute/path/to/new-agent --workspace /path/to/project --apply
```

导入时将 `{{REPO_ROOT}}`、`{{AGENT_DIR}}` 渲染为当前 checkout 和目标目录。已有文件完全相同时可重复执行；有任何不同内容则在写入前整体拒绝，不覆盖既有模型、账号、规则或设置。新配置建议用独立目录，通过 `PI_CODING_AGENT_DIR` 指向它再启动；具体 Windows/Linux 命令见根 README。不要在仓库内新建自己的账号、记忆或会话目录。

导入不会安装系统软件、调用模型、启动服务、拷贝个人数据或改 launchd。插件声明会由 SDK 在启动时尝试安装；第三方代码应先审阅。已有实例需要 `/reload` 或新建会话，不能把磁盘文件存在当作已加载。

## 外部能力不是随包就绪

模型账号需要自己授权。Hy-Memory 服务/token、LSP语言服务器、浏览器/OpenCLI、tmux、代理和macOS Keychain/launchd各有环境要求。相关代码和规则被保留，不代表这些外部系统已部署；不要启用作者机器的代理、服务地址或安装路径。角色的发现/继承能力依赖对应子代理插件及其宿主兼容适配，不能用文件数量证明执行成功。

## 维护与验证

```sh
node scripts/check-public-profile.mjs
node --test lib/configure-agent.test.mjs lib/public-profile-sdk.test.mjs
```

第一条检查文件清单、指纹和公开边界；第二条在临时空数据目录验证安全导入和真实 SDK 对提示词/技能/工作区规则的发现，不使用真实账号、记忆或模型。网页启动由现有双平台 CI 单独验证；外部服务与真实模型对话不在这项离线验收中。

维护者可用 `scripts/export-public-profile.py` 的显式 `--workspace`、`--agent-dir`、`--output` 参数重新收集白名单源码到临时目录，审查后更新公开配置及清单；不能以此复制整个用户配置目录。新增文件后先审查，再用 `node scripts/check-public-profile.mjs --write` 更新指纹。原私有 `pi-github-sync` 的私有仓库守卫仍保留，不恢复其定时任务。

发布使用一个同时包含两条旧分支的合并提交，验证后执行 `git push --atomic origin HEAD:main HEAD:pi-web`；禁止强推或只更新一个分支。默认 `main` CI 验证同一个提交，`pi-web` 仅保留兼容入口。
