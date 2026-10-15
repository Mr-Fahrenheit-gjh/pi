// Candidate-only, through the existing headless playwright-mcp service.
// Synthetic history + intercepted commands: no model requests or user-session writes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function prepareWorkspaceFixture(agentDir) {
  if (!/^\/(?:private\/)?tmp\//.test(resolve(agentDir))) throw new Error("Use an isolated temporary agent directory");
  const project = join(agentDir, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(agentDir, "sessions/design"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
  const document = "# 项目工作约定\n\n让内容成为主角，必要操作随手可达。\n\n## 文件与结果\n\n- **清楚的层级**：优先展示正文和当前任务。\n- **按需展开**：过程可以查看，但不抢占阅读空间。\n- **本地衔接**：随时在 Finder 中定位原文件。\n\n```ts\nconst workspace = { focus: 'content' };\n```\n";
  writeFileSync(join(project, "工作约定 notes.md"), document);
  writeFileSync(join(project, ".private.md"), "# Hidden fixture\n");
  writeFileSync(join(project, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#e9e5dc"/><text x="80" y="190" fill="#37352f" font-size="32">A quiet workspace</text></svg>');
  const timestamp = new Date().toISOString();
  const usage = { input: 24000, output: 8000, cacheRead: 12000, cacheWrite: 0, totalTokens: 44000, cost: { input: .04, output: .06, cacheRead: .01, cacheWrite: 0, total: .11 } };
  const assistant = content => ({ role: "assistant", content, api: "openai-completions", provider: "openai", model: "design-fixture", usage, stopReason: "stop", timestamp: Date.now() });
  const answer = "## 一个更安静的工作界面\n\n**把注意力留给内容，而不是工具栏。**\n\n" + Array.from({ length: 18 }, (_, index) => `### ${index + 1}. 阅读与工作\n\n日常只保留常用操作。历史、系统信息和高级设置按需展开；停止运行、权限确认和需要处理的错误仍然直接可见。`).join("\n\n");
  const entries = [
    { type: "session", version: 3, id: "workspace-design-fixture", timestamp, cwd: project },
    { type: "session_info", id: "title", timestamp, name: "重新整理一个安静的工作区" },
    { type: "model_change", id: "model", parentId: "title", timestamp, provider: "openai", modelId: "design-fixture" },
    { type: "message", id: "user", parentId: "model", timestamp, message: { role: "user", content: "请整理项目文件，保留必要操作，让阅读更专注。", timestamp: Date.now() } },
    { type: "message", id: "work", parentId: "user", timestamp, message: assistant([{ type: "text", text: "我会保留已有能力，先整理信息层级。" }, { type: "thinking", thinking: "HIDDEN_DESIGN_THINKING" }, { type: "toolCall", id: "inspect", name: "read", arguments: { path: "工作约定 notes.md" } }]) },
    { type: "message", id: "tool", parentId: "work", timestamp, message: { role: "toolResult", toolCallId: "inspect", toolName: "read", content: [{ type: "text", text: "HIDDEN_DESIGN_TOOL_OUTPUT" }], isError: false, timestamp: Date.now() } },
    { type: "message", id: "answer", parentId: "tool", timestamp, message: assistant([{ type: "text", text: answer }]) },
    { type: "custom", id: "todos", parentId: "answer", timestamp, customType: "rpiv-todo-state", data: { nextId: 4, tasks: [
      { id: 1, subject: "调整输入区与侧栏", activeForm: "验证界面布局", status: "in_progress" },
      { id: 2, subject: "验证上传引用", status: "pending" },
      { id: 3, subject: "保留官方 Pi 图标", status: "completed" },
    ] } },
  ];
  writeFileSync(join(agentDir, "sessions/design/workspace-design-fixture.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { project, file: join(project, "工作约定 notes.md"), image: join(project, "diagram.svg") };
}

export async function runWorkspaceDesignChecks(page, { baseURL, outputDir, project, file, image }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  check(/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL), "An isolated candidate port is required");
  const checks = [];
  const errors = [];
  const consoleErrors = [];
  const onConsole = message => { if (message.type() === "error") consoleErrors.push(message.text()); };
  page.on("console", onConsole);
  const commands = [];
  const reveals = [];
  let revealFails = false;
  let nativeSupported = true;
  let running = false;
  let compacting = false;
  const pageError = error => errors.push(error.message);
  page.on("pageerror", pageError);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("pi-locale", "zh-CN");
    localStorage.setItem("pi-theme", "claude-white");
    localStorage.setItem("pi-sidebar-open", "true");
    localStorage.setItem("pi-running-send-mode", "steer");
    localStorage.setItem("pi-enter-send-mode", "enter");
    window.__sources = [];
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) { super(); this.url = url; window.__sources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
    window.__feed = event => window.__sources.filter(source => source.readyState === 1).forEach(source => source.onmessage?.({ data: JSON.stringify(event) }));
  });
  const state = () => ({ model: { provider: "openai", id: "design-fixture" }, thinkingLevel: "medium", systemPrompt: "隔离设计验收：保留所有能力，减少常驻入口。", contextUsage: { percent: 8, contextWindow: 400000, tokens: 32000 }, isStreaming: running, isPromptRunning: running, isCompacting: compacting, messages: [], extensionStatuses: [], extensionWidgets: [] });
  await page.route("**/api/agent/*/subagents**", route => route.fulfill({ json: { available: false } }));
  await page.route("**/api/agent/running", route => route.fulfill({ json: { running: [], awaitingInput: [] } }));
  await page.route("**/api/sessions/*/state", route => route.fulfill({ json: { running, state: state() } }));
  await page.route("**/api/agent/workspace-design-fixture", route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running, state: state() } });
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.type === "get_state") return route.fulfill({ json: { success: true, data: state() } });
    if (command.type === "get_tools") return route.fulfill({ json: { success: true, data: [{ name: "read", description: "读取项目文件", active: true, parameters: { type: "object", properties: {} } }] } });
    if (command.type === "get_commands") return route.fulfill({ json: { success: true, data: { commands: [] } } });
    return route.fulfill({ json: { success: true, data: {} } });
  });
  await page.route("**/api/models?**", route => route.fulfill({ json: { models: { "openai/design-fixture": "Design fixture" }, modelList: [{ provider: "openai", id: "design-fixture", name: "Design fixture" }], defaultModel: { provider: "openai", modelId: "design-fixture" }, defaultThinkingLevel: "medium" } }));
  await page.route("**/api/open-in-explorer", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { supported: nativeSupported, platform: "darwin", reason: nativeSupported ? null : "remote" } });
    reveals.push(route.request().postDataJSON());
    return route.fulfill({ status: revealFails ? 503 : 200, json: revealFails ? { error: "fixture-failure" } : { opened: true } });
  });
  const feed = event => page.evaluate(event => window.__feed(event), event);
  const screenshot = name => page.screenshot({ path: `${outputDir}/${name}.png` });
  const assertNoOverflow = async () => {
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page must not overflow horizontally");
    for (const selector of [".workspace-topbar-row", ".sidebar-files-section", ".chat-input-controls", ".file-viewer-toolbar"]) {
      for (const element of await page.locator(selector).all()) {
        if (await element.isVisible()) check(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${selector} overflows`);
      }
    }
  };
  try {
    await page.goto(`${baseURL}/?cwd=${encodeURIComponent(project)}`, { waitUntil: "networkidle" });
    await page.locator(".composer-card").waitFor();
    check(await page.locator(".workspace-settings-entry button").count() === 2, "Settings and restart share the footer");
    check(!(await page.locator(".composer-options").isVisible()), "Options start collapsed");
    check(await page.locator(".sidebar-files-keys button").count() === 4, "Four direct file keys replace seven");
    await assertNoOverflow();
    await screenshot("new-session");
    checks.push("new session: quiet shell, one settings entry, four file keys, one composer surface");

    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
    await page.locator(".markdown-assistant-message").first().waitFor();
    await page.getByText("一个更安静的工作界面", { exact: true }).waitFor();
    check(await page.locator(".workspace-session-title, [data-agent-switcher]").count() === 0, "No title or agent icon clutters the header");
    check(await page.getByText("HIDDEN_DESIGN_TOOL_OUTPUT", { exact: true }).count() === 0, "Tool output remains folded");
    const beforeTypography = await page.locator(".markdown-assistant-message").first().evaluate(node => ({ font: getComputedStyle(node).fontFamily, size: getComputedStyle(node).fontSize }));
    check(await page.locator(".message-usage").count() === 0, "Per-message accounting is removed");
    check(!/\$\d/.test(await page.locator(".workspace-topbar").innerText()), "Billing is not shown in the header");
    await screenshot("conversation");
    checks.push("long conversation: no title or accounting, preserved typography and folded process");

    const ring = page.locator(".chat-input-controls [data-context-ring]");
    await ring.waitFor();
    check((await ring.getAttribute("title")).includes("8%"), "Context usage is represented by the bottom ring");
    check(await ring.getAttribute("role") === "meter", "Context ring is read-only");
    await ring.click();
    check(await page.locator(".session-info-popover").count() === 0, "Context ring does not open an inspector");
    check(await page.getByRole("button", { name: "会话操作", exact: true }).count() === 0, "Session menu is removed");
    checks.push("context: percentage ring without popup; no session action menu");

    const optionsTrigger = page.locator("[data-composer-options-trigger]");
    await optionsTrigger.click();
    await page.locator(".composer-options").waitFor();
    check(await page.getByRole("button", { name: "更改工具预设", exact: true }).isVisible(), "Tool preset remains available");
    await page.keyboard.press("Escape");
    check(!(await page.locator(".composer-options").isVisible()), "Esc collapses secondary composer settings");
    check(await optionsTrigger.evaluate(node => node === document.activeElement), "Composer options return focus");
    checks.push("composer: secondary controls on demand, Esc and focus restoration");

    await page.getByRole("button", { name: "更多文件操作", exact: true }).click();
    const fileMenu = page.getByRole("menu", { name: "更多文件操作", exact: true });
    await fileMenu.waitFor();
    check(await fileMenu.getByRole("menuitem", { name: /刷新文件列表/ }).count() === 1, "Refresh stays available");
    check(await fileMenu.getByRole("menuitem", { name: /上传/ }).count() === 1, "Upload stays available");
    const ignored = fileMenu.getByRole("menuitemcheckbox", { name: "显示被忽略的文件", exact: true });
    const ignoredBefore = await ignored.getAttribute("aria-checked");
    await ignored.click();
    await page.getByRole("button", { name: "更多文件操作", exact: true }).click();
    check(await ignored.getAttribute("aria-checked") !== ignoredBefore, "Ignored-file choice is still a working toggle");
    await page.keyboard.press("Escape");
    checks.push("file menu: upload entry exists, ignored-file state toggles, folder and refresh stay reachable");

    await page.locator("#session-sidebar").getByTitle(file, { exact: true }).click();
    const panel = page.locator("#file-panel");
    await panel.locator(".markdown-file-preview").waitFor({ timeout: 5000 });
    const reveal = panel.getByRole("button", { name: "在 Finder 中显示", exact: true });
    await reveal.waitFor();
    await reveal.click();
    check(reveals.at(-1)?.cwd === file && reveals.at(-1)?.reveal === true, "Finder uses the original path and reveal mode");
    revealFails = true;
    await reveal.click();
    await panel.getByRole("alert").filter({ hasText: "未能定位文件" }).waitFor();
    revealFails = false;
    await reveal.click();
    check(await panel.getByRole("alert").filter({ hasText: "未能定位文件" }).count() === 0, "Retry clears reveal errors");
    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await panel.locator(".file-source-line").first().waitFor();
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await panel.locator(".markdown-file-preview").waitFor();
    await assertNoOverflow();
    await screenshot("file-workspace");
    await page.setViewportSize({ width: 1100, height: 800 });
    await optionsTrigger.click();
    const cardBox = await page.locator(".composer-card").boundingBox();
    const optionsBox = await page.locator(".composer-options").boundingBox();
    check(optionsBox.x >= cardBox.x - 1 && optionsBox.x + optionsBox.width <= cardBox.x + cardBox.width + 1, "Composer options fit a narrow chat split");
    await assertNoOverflow();
    await screenshot("narrow-file-workspace");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 950 });
    checks.push("preview: Finder path/flag, retry, source/preview and narrow split toolbar/options fit");

    nativeSupported = false;
    await page.locator("#session-sidebar").getByTitle(image, { exact: true }).click();
    await panel.locator('img[src*="/api/files/"]').waitFor();
    check(await panel.getByRole("button", { name: "在 Finder 中显示", exact: true }).count() === 0, "Unavailable native action is not exposed");
    nativeSupported = true;
    await page.locator("#session-sidebar").getByTitle(file, { exact: true }).click();
    await panel.locator(".markdown-file-preview").waitFor();
    await panel.getByRole("button", { name: "全宽展示文件面板", exact: true }).click();
    check(Math.round((await panel.boundingBox()).width) === 1440, "Full-width file workspace still works");
    await panel.getByRole("button", { name: "还原文件面板宽度", exact: true }).click();
    await page.locator("[data-right-panel-toggle]").click();
    await page.waitForFunction(() => document.querySelector("#file-panel")?.getBoundingClientRect().width === 0);
    checks.push("file workspace: unavailable native action hidden; full-width/restore preserved");

    const editor = page.locator(".chat-input-textarea");
    await editor.focus();
    const idleBorder = await page.locator(".composer-card").evaluate(node => getComputedStyle(node).borderColor);
    running = true;
    await feed({ type: "agent_start" });
    const stop = page.getByRole("button", { name: "停止 Agent", exact: true });
    await stop.waitFor();
    check((await stop.innerText()).trim() === "", "Stop is icon-only");
    check(await page.locator(".composer-card").evaluate(node => getComputedStyle(node).borderColor) === idleBorder, "Running does not recolor the composer border");
    check(!(await page.locator(".composer-options").isVisible()), "Run cancellation does not require opening options");
    const send = page.locator("[data-composer-send]");
    check(await send.count() === 1 && (await send.innerText()).trim() === "", "One icon-only send action");
    check(await send.getAttribute("aria-label") === "引导", "Running send defaults to steering");
    await screenshot("running-input");
    await editor.fill("DESIGN_STEER_ONLY");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/agent/workspace-design-fixture") && response.request().method() === "POST" && response.request().postDataJSON()?.message === "DESIGN_STEER_ONLY"),
      send.click(),
    ]);
    check(commands.some(command => command.message === "DESIGN_STEER_ONLY" && command.streamingBehavior === "steer"), "The single send action steers the current run");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-section-tabs").getByRole("button", { name: "常规", exact: true }).click();
    await page.locator('input[name="running-send-mode"][value="followup"]').locator("..").click();
    check(await page.evaluate(() => localStorage.getItem("pi-running-send-mode")) === "followup", "Queue mode is an explicit browser preference");
    await page.keyboard.press("Escape");
    await editor.fill("DESIGN_FOLLOWUP_OPTION");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/agent/workspace-design-fixture") && response.request().method() === "POST" && response.request().postDataJSON()?.message === "DESIGN_FOLLOWUP_OPTION"),
      editor.press("Enter"),
    ]);
    check(commands.some(command => command.message === "DESIGN_FOLLOWUP_OPTION" && command.streamingBehavior === "followUp"), "The preference changes keyboard sending without exposing a second button");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-section-tabs").getByRole("button", { name: "常规", exact: true }).click();
    await page.locator('input[name="running-send-mode"][value="steer"]').locator("..").click();
    await page.keyboard.press("Escape");
    checks.push("sending: neutral border, icon-only actions, default steering and optional queued mode in Settings");
    await feed({ type: "extension_ui_request", id: "design-confirm", method: "confirm", title: "权限确认", message: "必要的确认不能被收进菜单" });
    await page.getByText("必要的确认不能被收进菜单", { exact: true }).waitFor();
    await screenshot("running-confirmation");
    await page.keyboard.press("Escape");
    running = false;
    await feed({ type: "agent_end", messages: [] });
    compacting = true;
    await feed({ type: "auto_compaction_start", reason: "manual" });
    await page.getByRole("button", { name: "停止压缩", exact: true }).waitFor();
    check(!(await page.locator(".composer-options").isVisible()), "Compaction cancellation stays direct");
    compacting = false;
    await feed({ type: "auto_compaction_end", aborted: true, willRetry: false });
    checks.push("safety: stop run, permission confirmation and stop compaction stay direct");

    await page.getByRole("button", { name: "设置", exact: true }).click();
    check(await page.getByRole("button", { name: "模型", exact: true }).count() > 0, "Models remain in Settings");
    check(await page.getByRole("button", { name: "技能", exact: true }).count() > 0, "Skills remain in Settings");
    await page.locator(".settings-section-tabs").getByRole("button", { name: "常规", exact: true }).click();
    for (const theme of ["claude", "dark", "claude-white"]) {
      await page.locator(`input[name="theme"][value="${theme}"]`).locator("..").click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    }
    await page.keyboard.press("Escape");
    const afterTypography = await page.locator(".markdown-assistant-message").first().evaluate(node => ({ font: getComputedStyle(node).fontFamily, size: getComputedStyle(node).fontSize }));
    check(JSON.stringify(beforeTypography) === JSON.stringify(afterTypography), "Theme switching preserves the user's content typography");
    await page.setViewportSize({ width: 1100, height: 800 });
    await assertNoOverflow();
    await screenshot("compact-desktop");
    checks.push("settings and responsive desktop: models/skills reachable, three themes, typography and 1100px fit");

    check(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    check(commands.filter(command => command.type === "prompt").length === 2, "Only the two intercepted test submissions are allowed");
    return { passed: true, checks, errors, modelRequests: 0, mockedPromptSubmissions: 2, mocked: true, browserBackend: "playwright-mcp", commands: commands.map(command => command.type), revealRequests: reveals.length, typography: beforeTypography };
  } catch (error) {
    await screenshot("failure");
    const panel = page.locator("#file-panel");
    const info = await panel.count() ? await panel.evaluate(node => ({ text: node.innerText.slice(0, 1200), box: node.getBoundingClientRect().toJSON(), preview: node.querySelector(".markdown-file-preview")?.getBoundingClientRect().toJSON() })) : null;
    throw new Error(`${error.message}\nCompleted: ${checks.join("; ")}\nFile panel: ${JSON.stringify(info)}\nErrors: ${JSON.stringify({ errors, consoleErrors })}`);
  } finally {
    page.off("pageerror", pageError);
    page.off("console", onConsole);
  }
}
