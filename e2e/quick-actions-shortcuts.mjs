import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkQuickActionShortcuts(page, { base, sessionId, outputDir, recentSessions }) {
  assert.notEqual(new URL(base).port, "30141", "Candidate fixture only");
  const checks = [];
  const dialog = page.locator(".quick-actions-backdrop");
  const input = dialog.locator("input");
  const open = async (mode = "command") => {
    await page.keyboard.press(mode === "command" ? "ControlOrMeta+k" : "ControlOrMeta+j");
    await dialog.waitFor();
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
  };
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.locator(".chat-input-textarea").waitFor();
  await open();
  const options = dialog.getByRole("option");
  const count = await options.count();
  assert.equal(count, 7, 'command mode includes the Intelligence UI toggle but no conversations');
  assert.equal(await dialog.locator('.quick-action-preview').count(), 0);
  const numbered = count;
  assert.deepEqual(await dialog.locator(".quick-action-shortcut").allTextContents(), Array.from({ length: numbered }, (_, i) => String(i + 1)));
  for (let i = 0; i < numbered; i++) assert.equal(await options.nth(i).getAttribute("aria-keyshortcuts"), String(i + 1));
  await dialog.locator(".quick-actions-surface").evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const geometry = await options.evaluateAll(nodes => nodes.map(node => {
    const row = node.getBoundingClientRect(), copy = node.querySelector('.quick-action-copy').getBoundingClientRect(), meta = node.querySelector('.quick-action-meta').getBoundingClientRect();
    return [row.x, row.width, row.height, copy.x, copy.width, meta.x, meta.width];
  }));
  for (const row of geometry) row.forEach((value, column) => assert.ok(Math.abs(value - geometry[0][column]) < 1, 'commands use consistent row and column geometry'));
  await page.screenshot({ path: join(outputDir, "quick-actions-shortcuts.png") });
  // Arrow selection must not change the displayed digit-to-row mapping.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("3");
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".outputs-workspace:visible").waitFor();
  checks.push("quick actions: uniform row widths, heights and columns; 3 opens conversation files");

  await open();
  await page.keyboard.press('ControlOrMeta+j');
  assert.equal(await dialog.locator('.quick-actions-surface').getAttribute('data-mode'), 'chat');
  assert.equal(await options.count(), 8);
  await dialog.getByRole('button', { name: 'Command' }).click();
  assert.equal(await options.count(), 7);
  await dialog.getByRole('button', { name: 'Chat' }).click();
  assert.equal(await input.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('ControlOrMeta+k');
  assert.equal(await options.count(), 7);
  await page.keyboard.press('Escape');
  await open('chat');
  assert.equal(await options.count(), 8);
  assert.deepEqual(await dialog.locator('.quick-action-shortcut').allTextContents(), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(await options.first().getAttribute('aria-posinset'), '1');
  checks.push('quick actions: Command/Chat buttons and shortcuts switch within one focused dialog');
  const laterLabel = await options.first().locator('.quick-action-copy > span').first().textContent();
  const laterSession = recentSessions.find(session => session.name === laterLabel);
  assert.ok(laterSession, 'a later conversation is reachable on the second page');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await options.count(), 8);
  await page.keyboard.press('PageDown');
  assert.equal(await options.count(), 8);
  await page.keyboard.press('1');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForURL(url => url.searchParams.get('session') === laterSession.id);
  checks.push('quick actions: Chat numbering is independent of commands and opens a conversation');
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: 'networkidle' });
  await open("chat");
  await input.fill("report");
  await page.keyboard.press("1");
  assert.equal(await input.inputValue(), "report1");
  assert.equal(await dialog.locator('[role="option"][aria-keyshortcuts]:not([aria-keyshortcuts^="Alt+"])').count(), 0);
  await input.fill(" ");
  await page.keyboard.press("1");
  assert.equal(await input.inputValue(), " 1", "a leading space permits numeric-first searches");
  await input.fill("");
  for (const flags of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    await input.dispatchEvent("keydown", { key: "1", ...flags });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await input.inputValue(), "");
  }
  await page.keyboard.press("0");
  assert.equal(await input.inputValue(), "0");
  checks.push("quick actions: numeric searches, zero, IME, repeats and browser modifiers do not execute");

  await input.fill('Numbered conversation');
  const filteredLabel = await options.first().locator('.quick-action-copy > span').first().textContent();
  const filteredSession = recentSessions.find(session => session.name === filteredLabel);
  assert.ok(filteredSession);
  assert.equal(await options.first().getAttribute('aria-keyshortcuts'), 'Alt+1');
  assert.equal(await options.first().locator('kbd').textContent(), '⌥1');
  await page.keyboard.press('Alt+1');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForURL(url => url.searchParams.get('session') === filteredSession.id);
  checks.push('quick actions: Option/Alt+digit opens a filtered conversation without consuming typed search digits');
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: 'networkidle' });
  await open();
  await input.fill("");
  await page.keyboard.press("1");
  await dialog.waitFor({ state: "hidden" });
  await page.locator('[data-composer-layout="welcome"]:visible').waitFor();
  await page.waitForURL(url => !url.searchParams.has("session") && url.searchParams.has("cwd"));
  checks.push("quick actions: 1 directly opens a new conversation without sending a prompt");
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "networkidle" });
  return checks;
}
