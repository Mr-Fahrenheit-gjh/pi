import assert from "node:assert/strict";

// Reuse quiet-tools' isolated production server/history and intercepted commands.
export async function checkComposerFocus(page, { base, sessionId }) {
  assert.notEqual(new URL(base).port, "30141", "Candidate fixture only");
  const checks = [];
  const input = page.locator(".chat-input-textarea").first();
  const focused = () => page.waitForFunction(() => document.activeElement?.matches(".chat-input-textarea"));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const returnEvents = () => page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const navigate = async (action) => {
    const previous = await page.locator(".conversation-transition").getAttribute("data-conversation-key");
    await action();
    await page.waitForFunction(key => {
      const view = document.querySelector(".conversation-transition");
      return view && !view.hasAttribute("inert") && view.getAttribute("data-conversation-key") !== key;
    }, previous);
    await settle();
  };

  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await focused();
  await page.keyboard.type("ready without a click");
  assert.equal(await input.inputValue(), "ready without a click");
  checks.push("composer: initial entry accepts typing without a click");

  await input.evaluate(node => node.setSelectionRange(2, 7));
  await returnEvents();
  assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 7]);
  await input.fill("");
  for (const type of ["focus", "visibilitychange"]) {
    await input.evaluate(node => node.blur());
    await page.evaluate(type => (type === "focus" ? window : document).dispatchEvent(new Event(type)), type);
    await focused();
  }
  checks.push("composer: window/tab return handlers restore idle focus and preserve selection");

  const search = page.locator("#session-search-input");
  await search.focus();
  await returnEvents();
  assert.equal(await search.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.locator('[role="dialog"]:visible').first();
  await dialog.waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await returnEvents();
  assert.equal(await input.evaluate(node => document.activeElement === node), false);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  checks.push("composer: search and visible settings dialog keep focus ownership");

  // Test a real editable control outside chat (the same ownership check protects
  // terminal textareas/editors), without opening a PTY or writing user files.
  const editor = await page.evaluateHandle(() => {
    const node = document.createElement("textarea");
    node.setAttribute("aria-label", "isolated editor focus fixture");
    document.body.append(node); node.focus(); return node;
  });
  await returnEvents();
  assert.equal(await editor.evaluate(node => document.activeElement === node), true);
  await editor.evaluate(node => node.remove());
  await editor.dispose();
  checks.push("composer: another real textarea keeps focus (no PTY started)");

  const newButton = page.locator(".sidebar-quick-new:visible, .sidebar-new-button:visible").first();
  const link = page.locator(`#session-sidebar-panel-sessions a.session-tree-main[href="?session=${sessionId}"]`).first();
  await navigate(() => newButton.click());
  await focused();
  await page.keyboard.type("new draft");
  assert.equal(await input.inputValue(), "new draft");
  await input.fill("");
  await navigate(() => link.click());
  await focused();
  checks.push("composer: mouse New/session navigation focuses the active composer");

  await navigate(() => newButton.click());
  await link.focus();
  await navigate(() => page.keyboard.press("Enter"));
  assert.equal(await link.evaluate(node => document.activeElement === node), true);
  await returnEvents();
  assert.equal(await link.evaluate(node => document.activeElement === node), true);
  checks.push("composer: keyboard session navigation retains link focus");
  return checks;
}
