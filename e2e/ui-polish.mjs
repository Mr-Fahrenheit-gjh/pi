// Isolated candidate only. Reuse prepareWorkspaceFixture and runWorkspaceDesignChecks first.
export async function runUiPolishChecks(page, { baseURL, outputDir }) {
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw new Error("Candidate port required");
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); };
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  const shots = [];
  const screenshot = async (name) => { const path = `${outputDir}/${name}.png`; await page.screenshot({ path }); shots.push(path); };
  try {
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
    await page.locator(".composer-card").waitFor();
    const left = page.locator("[data-sidebar-toggle]");
    const right = page.locator("[data-right-panel-toggle]");
    const leftStart = await left.boundingBox();
    const rightStart = await right.boundingBox();
    const mainPosition = async () => page.locator(".chat-input-shell").first().evaluate((node) => node.getBoundingClientRect().x);
    await left.click();
    await page.locator("#session-sidebar.sidebar-closed").waitFor();
    await page.waitForFunction(() => document.querySelector("#session-sidebar").getBoundingClientRect().width < 1);
    check(Math.abs((await left.boundingBox()).x - leftStart.x) < 1, "Left toggle moves after collapse");
    await page.mouse.move(700, 300);
    const before = await mainPosition();
    await left.hover();
    await page.locator("#session-sidebar.sidebar-preview").waitFor();
    check(Math.abs(await mainPosition() - before) < 1, "Sidebar preview shifts chat");
    await page.locator(".sidebar-quick-search input").hover();
    check(await page.locator("#session-sidebar.sidebar-preview").count() === 1, "Hover preview closes before entering sidebar");
    await screenshot("sidebar-preview");
    await left.click();
    await page.locator("#session-sidebar.sidebar-open").waitFor();
    check(Math.abs((await left.boundingBox()).x - leftStart.x) < 1, "Left toggle moves after pinning");
    check(await page.locator(".sidebar-quick-new").isVisible(), "New row is missing");
    check(await page.locator(".sidebar-quick-search input").isVisible(), "Search field is missing");
    await left.click();
    await page.mouse.move(700, 300);
    await page.waitForFunction(() => !document.querySelector(".sidebar-preview"));
    checks.push("left: fixed toggle, hover preview, pointer bridge, pin/collapse, Claude-style search/new rows");

    await page.waitForFunction(() => document.querySelector("#file-panel").getBoundingClientRect().width < 1 && document.querySelector("#session-sidebar").getBoundingClientRect().width < 1);
    const beforeRight = await mainPosition();
    await right.hover();
    await page.locator("#file-panel.right-panel-preview").waitFor();
    check(Math.abs(await mainPosition() - beforeRight) < 1, "Right preview shifts chat");
    await right.click();
    await page.locator("#file-panel.right-panel-open").waitFor();
    check(Math.abs((await right.boundingBox()).x - rightStart.x) < 1, "Right toggle moves after pinning");
    await page.locator('#file-panel [role="tab"]').filter({ hasText: "待办" }).first().click();
    await page.locator(".todo-workspace").waitFor();
    await page.getByText("调整输入区与侧栏", { exact: true }).waitFor();
    check(await page.locator(".extension-status-shelf").count() === 0, "Bottom extension shelf remains visible");
    await screenshot("right-todo-workspace");
    await page.locator('#file-panel [role="tab"]').filter({ hasText: "子代理" }).first().click();
    await page.locator(".agent-picker-trigger").waitFor();
    await page.route("**/api/agent/*/subagents**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: query.get("view") === "chat" ? { messages: [], text: "只读子代理对话验收" } : {
        available: true, asyncSnapshot: { runs: [{ id: "ui-polish-child", label: "检查界面", role: "reviewer", state: "complete" }] }, fleet: { entries: [] },
      } });
    });
    // A visibility event requests the current snapshot without waiting for polling.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator(".agent-picker-trigger").click();
    await page.locator('[role="option"][data-agent-id="package:ui-polish-child"]').click();
    await page.getByText("只读子代理对话验收", { exact: true }).waitFor();
    check(await page.locator('.workspace-topbar [data-agent-switcher]').count() === 0, "Agent icon remains in header");
    check(await page.locator('.conversation-transition [aria-label="子代理记录"]').count() === 0, "Child selection replaces the main chat");
    await screenshot("right-subagent-workspace");
    await page.locator(".agent-picker-trigger").click();
    await page.locator('[role="option"][data-agent-id="workspace-design-fixture"]').click();
    await page.locator("#file-panel .markdown-assistant-message").first().waitFor();
    await page.locator(".file-panel-expand-button").click();
    await page.locator("#file-panel.right-panel-full-width").waitFor();
    check(await right.isEnabled(), "Right toggle is inert in full-width mode");
    await right.click();
    await page.locator("#file-panel.right-panel-closed").waitFor({ state: "attached" });
    await page.mouse.move(700, 300);
    checks.push("right: fixed toggle, hover preview, right-only child switch, return to main, full-width close");

    await left.click();
    await page.getByRole("button", { name: "重启 Pi Web？", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await screenshot("restart-confirmation");
    await page.getByRole("button", { name: "确认重启", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "此实例不支持" }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    checks.push("restart: confirmation dialog and candidate instance rejection; no formal restart executed");

    for (const width of [1100, 820, 640, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator(".chat-input-textarea").first().fill("较长的输入内容，用于检查输入框换行、发送按钮和底栏的布局。\n".repeat(5));
      const card = page.locator(".composer-card").first();
      check(await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `Composer overflow at ${width}`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Document overflow at ${width}`);
      const send = await page.locator("[data-composer-send]").boundingBox();
      const textarea = await page.locator(".chat-input-textarea").first().boundingBox();
      check(send.x >= textarea.x + textarea.width - 1 || send.y >= textarea.y + textarea.height - 1, `Send button overlaps draft at ${width}`);
      await screenshot(`layout-${width}`);
    }
    checks.push("responsive: long draft and control layout at 1100/820/640/390 without horizontal overflow");
    check(errors.length === 0, errors.join("\n"));
    return { passed: true, checks, pageErrors: errors, screenshots: shots };
  } catch (error) {
    await screenshot("failure-ui-polish");
    return { passed: false, checks, pageErrors: errors, error: String(error?.stack ?? error), screenshots: shots };
  } finally { page.off("pageerror", onError); }
}
