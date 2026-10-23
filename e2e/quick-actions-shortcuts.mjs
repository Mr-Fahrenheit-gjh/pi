import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkQuickActionShortcuts(page, { base, sessionId, outputDir }) {
  assert.notEqual(new URL(base).port, "30141", "Candidate fixture only");
  const checks = [];
  const dialog = page.locator(".quick-actions-backdrop");
  const input = dialog.locator("input");
  const open = async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.waitFor();
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
  };
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.locator(".chat-input-textarea").waitFor();
  await open();
  const options = dialog.getByRole("option");
  const count = await options.count();
  assert.ok(count >= 3);
  const numbered = Math.min(9, count);
  assert.deepEqual(await dialog.locator(".quick-action-shortcut").allTextContents(), Array.from({ length: numbered }, (_, i) => String(i + 1)));
  for (let i = 0; i < numbered; i++) assert.equal(await options.nth(i).getAttribute("aria-keyshortcuts"), String(i + 1));
  await dialog.locator(".quick-actions-surface").evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: join(outputDir, "quick-actions-shortcuts.png") });
  // Arrow selection must not change the displayed digit-to-row mapping.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("3");
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".outputs-workspace:visible").waitFor();
  checks.push("quick actions: numbered rows match shortcuts; 3 directly opens conversation files");

  await open();
  await input.fill("report");
  await page.keyboard.press("1");
  assert.equal(await input.inputValue(), "report1");
  assert.equal(await dialog.locator(".quick-action-shortcut, [aria-keyshortcuts]").count(), 0);
  await input.fill(" ");
  await page.keyboard.press("1");
  assert.equal(await input.inputValue(), " 1", "a leading space permits numeric-first searches");
  await input.fill("");
  for (const flags of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }]) {
    await input.dispatchEvent("keydown", { key: "1", ...flags });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await input.inputValue(), "");
  }
  await page.keyboard.press("0");
  assert.equal(await input.inputValue(), "0");
  checks.push("quick actions: numeric searches, zero, IME, repeats and modified keys do not execute");

  await input.fill("");
  await page.keyboard.press("1");
  await dialog.waitFor({ state: "hidden" });
  await page.locator('[data-composer-layout="welcome"]:visible').waitFor();
  await page.waitForURL(url => !url.searchParams.has("session") && url.searchParams.has("cwd"));
  checks.push("quick actions: 1 directly opens a new conversation without sending a prompt");
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "networkidle" });
  return checks;
}
