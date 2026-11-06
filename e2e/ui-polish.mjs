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
    await page.locator(".sidebar-quick-search").hover();
    check(await page.locator("#session-sidebar.sidebar-preview").count() === 1, "Hover preview closes before entering sidebar");
    await screenshot("sidebar-preview");
    await left.click();
    await page.locator("#session-sidebar.sidebar-open").waitFor();
    check(Math.abs((await left.boundingBox()).x - leftStart.x) < 1, "Left toggle moves after pinning");
    check(await page.locator(".sidebar-quick-new").isVisible(), "New row is missing");
    check(await page.locator("button.sidebar-quick-search").isVisible(), "Search navigation is missing");
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
    check(await page.locator('.workspace-settings-entry > button').count() === 1, 'Footer only keeps Settings');
    check(await page.locator('.service-restart-button, .pending-release-entry-button').count() === 0, 'Maintenance entries are unmounted');
    checks.push('footer: only Settings, no release/restart controls');

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

// Focused sidebar + streaming checks on an isolated source preview; no real model.
export async function runSidebarRefinementChecks(page, { baseURL, outputDir, sessionId, assistant }) {
  const assert = (await import('node:assert/strict')).default;
  const context = page.context();
  const requests = [];
  page.on('request', request => { if (/\/api\/(pending-releases|service\/restart)/.test(request.url())) requests.push(request.url()); });
  await context.addInitScript(() => {
    localStorage.setItem('pi-theme', 'claude-white');
    window.__sources = [];
    window.__proseStarts = [];
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'answer-prose-enter') window.__proseStarts.push(event.target);
    }, true);
    window.EventSource = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) { this.url = url; window.__sources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connected', isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
    window.__feed = event => window.__sources.filter(source => source.readyState === 1).forEach(source => source.onmessage?.({ data: JSON.stringify(event) }));
  });
  const state = { running: false, state: { isStreaming: false, isPromptRunning: false, messages: [], thinkingLevel: 'off', extensionStatuses: [], extensionWidgets: [] } };
  // Keep the isolated server's real read-state snapshot; legacy mock payloads can trigger a sync warning.
  await page.route('**/api/sessions/*/state', route => route.fulfill({ json: state }));
  await page.route(`**/api/agent/${sessionId}`, route => route.fulfill({ json: state }));
  await page.goto(`${baseURL}/?session=${sessionId}`, { waitUntil: 'networkidle' });
  await page.locator('.markdown-assistant-message').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.sidebar-quick-actions input').count(), 0);
  assert.deepEqual(await page.locator('.sidebar-quick-actions > button').allTextContents(), ['New', 'Search']);
  assert.deepEqual(await page.locator('.workspace-settings-entry > button').allTextContents(), ['Settings']);
  assert.equal(await page.locator('.pending-release-entry-button, .service-restart-button').count(), 0);
  await page.locator('.sidebar-quick-search').click();
  await page.locator('.quick-actions-surface[data-mode="chat"]').waitFor();
  await page.screenshot({ path: `${outputDir}/sidebar-search.png`, style: 'nextjs-portal { display: none !important; }' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+j');
  await page.locator('.quick-actions-surface[data-mode="chat"]').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('input[name="theme"]').first().waitFor();
  await page.keyboard.press('Escape');
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const fonts = {};
  for (const selector of ['.sidebar-quick-search > span', '.session-tree-title']) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    fonts[selector] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  }
  assert.ok(fonts['.sidebar-quick-search > span'].some(font => font.isCustomFont && font.glyphCount > 0 && /Anthropic Sans/.test(font.familyName)), 'Real Claude font renders the navigation, not just a CSS alias');
  await cdp.detach();
  await page.locator('.chat-input-textarea').blur();
  await page.mouse.move(1000, 20);
  await page.screenshot({ path: `${outputDir}/sidebar-chat.png`, style: 'nextjs-portal { display: none !important; }' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const message = { ...assistant, content: [{ type: 'text', text: 'Gentle streaming' }] };
  await page.evaluate(message => { window.__feed({ type: 'agent_start' }); window.__feed({ type: 'message_start', message }); }, message);
  const prose = page.locator('.markdown-streaming-answer > p').first();
  await prose.waitFor();
  await page.waitForFunction(() => window.__proseStarts.length === 1);
  await prose.evaluate(node => { window.__firstProse = node; window.__proseY = node.getBoundingClientRect().y; });
  const append = delta => page.evaluate(delta => window.__feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } }), delta);
  for (let i = 0; i < 10; i++) {
    await append(` ${i}`);
    await page.waitForFunction(i => window.__firstProse?.textContent.endsWith(` ${i}`), i);
  }
  assert.equal(await prose.evaluate(node => node === window.__firstProse), true);
  assert.equal(await page.evaluate(() => window.__proseStarts.length), 1, 'Token updates must not replay entry motion');
  assert.equal(await prose.evaluate(node => getComputedStyle(node).transform), 'none');
  assert.equal(await prose.evaluate(node => getComputedStyle(node).animationDuration), '0.18s');
  await append('\n\nSecond paragraph');
  await page.waitForFunction(() => window.__proseStarts.length === 2);
  assert.equal(await prose.evaluate(node => node === window.__firstProse), true);
  const selected = await prose.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert.equal(selected, 'Gentle streaming 0 1 2 3 4 5 6 7 8 9');
  await append('\n\n```ts\nconst ready = true;\n```\n\n$$x^2$$');
  await page.locator('.markdown-streaming-answer pre').waitFor();
  assert.equal(await page.locator('.markdown-streaming-answer pre').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await prose.evaluate(node => getComputedStyle(node).animationName), 'none');
  await append('\n\nReduced motion is immediate');
  await page.getByText('Reduced motion is immediate', { exact: true }).waitFor();
  assert.equal(await page.getByText('Reduced motion is immediate', { exact: true }).evaluate(node => getComputedStyle(node).opacity), '1');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('.markdown-streaming-answer').count(), 0, 'Historical messages never animate as live prose');
  await page.locator('.sidebar-quick-new').click();
  await page.locator('.new-session-greeting').waitFor();
  await page.locator('.chat-input-textarea').blur();
  await page.mouse.move(1000, 20);
  await page.screenshot({ path: `${outputDir}/sidebar-welcome.png`, style: 'nextjs-portal { display: none !important; }' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(requests, [], 'No background release/restart requests');
  assert.equal(await page.getByText(/Could not sync read status/).count(), 0, 'Isolated read-state fixture stays healthy');
  return { passed: true, fonts, checks: ['New/Search order and consistent navigation', 'Search and Cmd+J open the same dialog', 'Settings only; no maintenance requests', 'platform font rendering verified', 'new prose fades once at 180ms', '10 deltas preserve node and do not replay', 'text selection unchanged', 'code remains unanimated', 'reduced motion immediate', 'history unanimated', 'no desktop overflow'], screenshots: ['sidebar-chat.png', 'sidebar-search.png', 'sidebar-welcome.png'].map(name => `${outputDir}/${name}`) };
}
