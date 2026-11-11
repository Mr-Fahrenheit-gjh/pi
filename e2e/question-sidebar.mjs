import assert from "node:assert/strict";
import { join } from "node:path";
import { showSidebarFiles } from "./sidebar.mjs";

/** Real RPC dialogs, isolated fixture only: no provider requests or real sessions. */
export async function checkQuestionSidebar(page, { artifacts, filePath }) {
  const panel = page.locator("#file-panel");
  const toggle = page.locator("[data-right-panel-toggle]").filter({ visible: true });
  const commands = [];
  const record = request => {
    if (request.method() === "POST" && /\/api\/agent\/[^/]+$/.test(new URL(request.url()).pathname)) commands.push(request.postDataJSON());
  };
  page.on("request", record);
  const start = async mode => {
    const input = page.locator(".chat-input-textarea").first();
    await input.fill(`/e2e-dialog ${mode}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const question = panel.locator("[data-question-panel]");
    await question.waitFor();
    return question;
  };
  const finish = async mode => {
    await page.getByText(new RegExp(`^E2E ${mode} result:`)).waitFor();
    await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
  };
  try {
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await showSidebarFiles(page);
    await page.getByTitle(filePath, { exact: true }).click();
    const iframe = panel.locator("iframe");
    await iframe.waitFor();
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.locator("#notes").fill("Keep the file draft");
    const instance = await frame.evaluate(() => window.previewInstance);

    const question = await start("select");
    await panel.getByRole("tab", { name: "Awaiting response", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "Questions are non-modal");
    assert.equal(await question.evaluate(node => Boolean(node.closest("#file-panel"))), true);
    assert.ok(await page.locator(".right-panel-overlay-backdrop").evaluate(node => {
      const style = getComputedStyle(node);
      return style.display === "none" || style.pointerEvents === "none";
    }), "Desktop reply has no backdrop");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-question-panel]") !== null), false, "Opening a question must not steal focus");
    const reply = page.locator(".markdown-assistant-message").first();
    const replyBox = await reply.boundingBox();
    const panelBox = await panel.boundingBox();
    assert.ok(replyBox && panelBox && replyBox.x + replyBox.width <= panelBox.x + 1, "Question and reply occupy separate columns");
    const scrollMoved = await reply.evaluate(node => {
      const scroll = node.closest(".overflow-y-auto");
      const before = scroll.scrollTop;
      scroll.scrollTop = before > 80 ? before - 80 : before + 80;
      return scroll.scrollTop !== before;
    });
    assert.ok(scrollMoved, "Main reply remains independently scrollable");
    const first = question.getByRole("button", { name: "Option 1", exact: true });
    const beforeIme = commands.length;
    await first.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.equal(commands.slice(beforeIme).some(command => command.type === "extension_ui_response"), false, "IME Enter does not choose an option");
    await page.screenshot({ path: join(artifacts, "question-sidebar-desktop.png") });
    await first.click();
    await finish("select");
    await iframe.waitFor();
    assert.equal(await frame.evaluate(() => window.previewInstance), instance, "Answering does not remount the parked file");
    assert.equal(await frame.locator("#notes").inputValue(), "Keep the file draft");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Previously open panel is restored");

    await toggle.click();
    const inputQuestion = await start("input");
    const input = inputQuestion.getByRole("textbox");
    await input.fill("侧栏里的未提交草稿");
    const beforeCollapse = commands.length;
    await input.press("Escape");
    await inputQuestion.waitFor({ state: "hidden" });
    assert.equal(commands.slice(beforeCollapse).some(command => ["extension_ui_response", "abort"].includes(command.type)), false, "Escape only collapses; it never cancels or aborts");
    assert.equal(await toggle.getAttribute("data-question-pending"), "true");
    await toggle.click();
    await inputQuestion.waitFor();
    assert.equal(await input.inputValue(), "侧栏里的未提交草稿");
    await input.press("Enter");
    await finish("input");
    await page.waitForFunction(() => !document.querySelector("#file-panel")?.classList.contains("right-panel-open"));

    const walk = await start("walk");
    await walk.getByRole("button", { name: "自己补充想法", exact: true }).click();
    const custom = panel.getByRole("region", { name: "补充你的想法", exact: true });
    await custom.waitFor();
    await custom.getByRole("textbox").fill("自己的回答");
    await custom.getByRole("textbox").press("Enter");
    const followUp = panel.getByRole("region", { name: "E2E walk follow-up", exact: true });
    await followUp.waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await followUp.waitFor();
    assert.equal(await toggle.getAttribute("data-question-pending"), "true", "Pending questions survive reconnect/reload");
    await followUp.getByRole("textbox").fill("顺序问题已回答");
    await followUp.getByRole("textbox").press("Enter");
    await finish("walk");
    console.log("PASS: right-sidebar questions, readable reply, IME, parked file/draft, collapse, restore, sequential input and pending replay");
  } finally {
    page.off("request", record);
  }
}


/** Theme tokens and quiet workspace rows; only the isolated preview command is used. */
export async function checkQuestionSidebarTheme(page, { artifacts }) {
  const viewport = page.viewportSize();
  const originalTheme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains("dark") }));
  const setTheme = theme => page.evaluate(value => {
    document.documentElement.dataset.theme = value;
    document.documentElement.classList.toggle("dark", value === "dark");
  }, theme);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".chat-input-textarea").first().fill("/e2e-dialog preview");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const question = page.locator("#file-panel .question-workspace");
  await question.waitFor();
  try {
    for (const theme of ["claude-white", "dark"]) {
      await setTheme(theme);
      await page.setViewportSize({ width: 1440, height: 950 });
      await page.mouse.move(0, 0);
      await question.evaluate(node => { if (node.contains(document.activeElement)) document.activeElement.blur(); });
      const styles = await question.evaluate(node => {
        const option = node.querySelector(".question-workspace-option");
        const row = getComputedStyle(option);
        return {
          font: getComputedStyle(node).fontFamily,
          uiFont: getComputedStyle(document.body).fontFamily,
          background: row.backgroundColor,
          sideBorders: [row.borderLeftWidth, row.borderRightWidth],
          footer: getComputedStyle(node.querySelector(".question-workspace-actions")).backgroundColor,
          headerPadding: getComputedStyle(node.querySelector(".question-workspace-header")).paddingLeft,
        };
      });
      assert.equal(styles.font, styles.uiFont, "Question workspace uses the existing UI font");
      assert.equal(styles.background, "rgba(0, 0, 0, 0)", "Rows have no grey card fill");
      assert.deepEqual(styles.sideBorders, ["0px", "0px"], "Rows have no card outline");
      assert.equal(styles.footer, "rgba(0, 0, 0, 0)", "Actions have no separate grey strip");
      assert.equal(styles.headerPadding, "24px");
      assert.equal(await question.locator(".question-workspace-category").innerText(), "界面优化");
      assert.equal(await question.locator(".question-workspace-title").innerText(), "下一步希望怎么继续？");
      assert.equal(await question.locator(".question-workspace-recommendation").innerText(), "Recommended");
      assert.equal(await question.locator(".question-workspace-option-description").count(), 2);
      const lastOption = await question.locator(".question-workspace-custom").boundingBox();
      const actions = await question.locator(".question-workspace-actions").boundingBox();
      assert.ok(actions.y - lastOption.y - lastOption.height < 40, "Actions follow the question instead of sitting at the screen bottom");
      await page.screenshot({ path: join(artifacts, `question-sidebar-${theme}.png`) });
      const first = question.locator("[data-extension-option]").first();
      // Set keyboard modality without tabbing into the custom-input handshake.
      await page.keyboard.press("Shift");
      await first.focus();
      assert.ok(await first.evaluate(node => parseFloat(getComputedStyle(node.closest(".question-workspace-option")).outlineWidth) >= 2), "Keyboard focus stays visible");
      await page.keyboard.press("ArrowDown");
      assert.equal(await question.locator("[data-extension-option]").nth(1).evaluate(node => node === document.activeElement), true);
      await first.hover();
      assert.notEqual(await first.evaluate(node => getComputedStyle(node.closest(".question-workspace-option")).backgroundColor), "rgba(0, 0, 0, 0)");
      await page.screenshot({ path: join(artifacts, `question-sidebar-${theme}-focus.png`) });
    }
    await setTheme("claude-white");
    const recommended = question.locator("[data-question-recommended]").first();
    const originalValue = await recommended.getAttribute("aria-label");
    await recommended.click();
    assert.equal(await question.isVisible(), true, "Selecting does not submit or change pages");
    let failed = false;
    const failOnce = route => {
      const request = route.request();
      if (!failed && request.method() === "POST" && request.postDataJSON()?.type === "extension_ui_response") {
        failed = true;
        return route.abort("failed");
      }
      return route.continue();
    };
    await page.route("**/api/agent/*", failOnce);
    await question.getByRole("button", { name: "Send", exact: true }).click();
    await question.getByRole("alert").waitFor();
    await page.waitForFunction(() => document.querySelector(".question-workspace-submit")?.disabled === false);
    assert.equal(failed, true, "A failed POST is reconciled against the live pending queue");
    await page.unroute("**/api/agent/*", failOnce);
    const answerRequest = page.waitForRequest(request => request.method() === "POST" && new RegExp("^/api/agent/[^/]+$").test(new URL(request.url()).pathname) && request.postDataJSON()?.type === "extension_ui_response");
    await question.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal((await answerRequest).postDataJSON().value, originalValue, "Visual parsing must not change the submitted option");
    await question.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
    await page.locator(".chat-input-textarea").first().fill("/e2e-dialog preview");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await question.waitFor();
    await page.setViewportSize({ width: 1100, height: 800 });
    assert.ok(await question.locator(".question-workspace-body").evaluate(node => node.scrollWidth <= node.clientWidth + 1), "Compact sidebar has no horizontal overflow");
    const input = question.getByRole("textbox", { name: "Your answer", exact: true });
    assert.equal(await input.isVisible(), true, "Custom input is visible below options before any selection");
    assert.equal(await question.locator(".question-workspace-detail").count(), 0, "No explanatory filler is added");
    assert.equal(await question.locator("[data-extension-option]").count(), 2, "The protocol sentinel is not a visible extra page");
    await input.fill("  1  ");
    await page.waitForFunction(() => document.querySelector(".question-workspace-submit")?.disabled === false);
    assert.equal(await input.evaluate(node => getComputedStyle(node).outlineWidth), "2px");
    await page.screenshot({ path: join(artifacts, "question-sidebar-input.png") });
    await question.locator(".question-workspace-header > .quiet-action-button").click();
    await question.waitFor({ state: "hidden" });
    await page.locator("[data-right-panel-toggle][data-question-pending]").filter({ visible: true }).click();
    await question.waitFor();
    assert.equal(await input.inputValue(), "  1  ");
    let releaseHandshake;
    let sawHandshake;
    const held = new Promise(resolve => { releaseHandshake = resolve; });
    const seen = new Promise(resolve => { sawHandshake = resolve; });
    const delayHandshake = async route => {
      const request = route.request();
      if (request.method() === "POST" && request.postDataJSON()?.type === "extension_ui_response" && request.postDataJSON()?.cancelled) {
        sawHandshake();
        await held;
      }
      await route.continue();
    };
    await page.route("**/api/agent/*", delayHandshake);
    try {
      await question.locator("[data-extension-option]").first().check();
      await seen;
      await input.focus();
      assert.equal(await input.evaluate(node => node.readOnly), true, "A pending mode switch cannot start another handshake");
      releaseHandshake();
      await page.waitForFunction(() => document.querySelector(".question-workspace-submit")?.disabled === false);
      assert.equal(await input.inputValue(), "  1  ", "Switching modes keeps the inline draft");
      await input.fill("  1  x");
      await input.press("Backspace");
      await page.waitForFunction(() => document.querySelector(".question-workspace-submit")?.disabled === false);
      assert.equal(await question.getByRole("radio", { name: "Your answer", exact: true }).isChecked(), true);
    } finally {
      releaseHandshake();
      await page.unroute("**/api/agent/*", delayHandshake);
    }
    const customResponse = page.waitForRequest(request => request.method() === "POST" && new RegExp("^/api/agent/[^/]+$").test(new URL(request.url()).pathname) && request.postDataJSON()?.value === "  1  ");
    await question.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal((await customResponse).postDataJSON().value, "  1  ", "Custom answers retain numbers and surrounding spaces");
    await question.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
    console.log("PASS: same-page options/input/send, original RPC values, mode switching, compact draft, theme tokens and keyboard focus");
    return { passed: true, themes: ["claude-white", "dark"], widths: [1440, 1100] };
  } finally {
    await page.evaluate(value => {
      if (value.theme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value.theme;
      document.documentElement.classList.toggle("dark", value.dark);
    }, originalTheme);
    if (viewport) await page.setViewportSize(viewport);
  }
}
