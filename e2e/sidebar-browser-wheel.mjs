import assert from "node:assert/strict";

export async function verifySidebarBrowserWheel({ context, page, panel, run, waitScreen, checks, created, artifacts }) {
  const { join } = await import("node:path");
  const selected = page.locator(".session-tree-session.is-selected").first();
  assert.equal(await selected.evaluate(el => getComputedStyle(el, "::before").content), "none");
  assert.equal(await selected.locator(".session-tree-title").evaluate(el => getComputedStyle(el).fontSize), "13px");
  checks.push("claude-sidebar-neutral-selection-and-legible-titles");
  assert.equal(await panel.locator(".terminal-ghostty-surface").evaluate(el => getComputedStyle(el).caretColor), "rgba(0, 0, 0, 0)");
  checks.push("native-host-caret-hidden-real-terminal-cursor-retained");

  const preview = "https://preview.test/demo";
  await context.route("https://preview.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Preview fixture</title><h1>Browser preview fixture</h1>" }));
  const countBefore = created.size;
  const open = async () => {
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await panel.getByRole("dialog", { name: "Open", exact: true }).getByRole("textbox").fill(preview);
  };
  await open();
  await panel.getByRole("button", { name: "Preview in window", exact: true }).click();
  await panel.frameLocator("iframe").getByRole("heading", { name: "Browser preview fixture" }).waitFor();
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), false);
  assert.equal(await panel.locator(".terminal-browser-note").count(), 0);
  assert.equal(await panel.locator(".terminal-engine-label, .terminal-cwd").count(), 0);
  assert.equal(await panel.locator(".terminal-panel-header").evaluate(el => el.getBoundingClientRect().height), 32);
  const frame = page.frames().find(frame => frame.url() === preview);
  await frame.evaluate(() => { window.__foldToken = "kept"; });
  await panel.getByRole("button", { name: "Expand toolbar", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), true);
  await panel.getByRole("button", { name: "Collapse toolbar", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), false);
  assert.equal(await frame.evaluate(() => window.__foldToken), "kept");
  assert.equal(created.size, countBefore);
  await page.screenshot({ path: join(artifacts, "browser-toolbar-collapsed.png") });
  checks.push("browser-toolbar-default-collapsed-one-row-no-help-banner-no-frame-reload");
  checks.push("inline-browser-preview-keeps-original-pty");
  const popupPromise = context.waitForEvent("page");
  await open();
  await panel.getByRole("button", { name: "Open externally", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL(preview);
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.close();
  checks.push("external-browser-open-is-user-triggered-and-noopener");
  await panel.getByRole("button", { name: "Terminal", exact: true }).last().click();
  await run("printf '\\nBROWSER_RETURN_OK:%s\\n' \"$$\"");
  await waitScreen(/BROWSER_RETURN_OK:\d+/);
  assert.equal(created.size, countBefore);
  checks.push("return-from-browser-keeps-shell-and-canvas");

  const script = [
    "import os,sys,termios,tty,select",
    "old=termios.tcgetattr(0)",
    "tty.setraw(0)",
    "sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HSCROLL_WAIT')",
    "sys.stdout.flush()",
    "ready=select.select([0],[],[],8)[0]",
    "data=os.read(0,1024) if ready else b''",
    "sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l')",
    "sys.stdout.flush()",
    "termios.tcsetattr(0,termios.TCSADRAIN,old)",
    "print('\\nWHEEL_REPORT:'+data.hex(),flush=True)",
  ].join(";");
  // Script is a literal test fixture, not request-controlled shell code.
  await run(`python3 -c ${JSON.stringify(script)}`);
  await waitScreen(/SCROLL_WAIT/);
  const canvas = panel.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -24);
  await waitScreen(/WHEEL_REPORT:1b5b3c36343b/);
  checks.push("real-pty-fullscreen-trackpad-sends-sgr-wheel-not-history-arrows");
  await page.screenshot({ path: join(artifacts, "claude-sidebar-terminal.png") });
  await open();
  await page.screenshot({ path: join(artifacts, "codex-open-menu.png") });
  await page.keyboard.press("Escape");
}
