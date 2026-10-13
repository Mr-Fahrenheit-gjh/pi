import assert from "node:assert/strict";

export async function verifySidebarBrowserWheel({ context, page, panel, run, waitScreen, checks, created, artifacts }) {
  const { join } = await import("node:path");
  const selected = page.locator(".session-tree-session.is-selected").first();
  assert.equal(await selected.evaluate(el => getComputedStyle(el, "::before").content), "none");
  assert.equal(await selected.locator(".session-tree-title").evaluate(el => getComputedStyle(el).fontSize), "13px");
  checks.push("claude-sidebar-neutral-selection-and-legible-titles");
  assert.equal(await panel.locator(".terminal-ghostty-surface").evaluate(el => getComputedStyle(el).caretColor), "rgba(0, 0, 0, 0)");
  checks.push("native-host-caret-hidden-real-terminal-cursor-retained");

  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  let requests = 0;
  const fixture = createServer((_req, res) => {
    if (_req.url === "/demo") requests++; res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" });
    res.end(`<!doctype html><title>${_req.url === "/popup" ? "NATIVE_POPUP" : "Native browser fixture"}</title><body style="margin:0;background:#e0f0ff;min-height:2500px"><input style="position:absolute;left:20px;top:20px;width:200px;height:32px" oninput="document.title='typed:'+this.value"><button style="position:absolute;left:20px;top:80px" onclick="${_req.url === "/popup" ? "window.close()" : "window.open('/popup','_blank')"}">popup</button><h1 style="padding-top:120px">Native Chrome, frame denied</h1><script>onscroll=()=>document.title='SCROLL:'+Math.round(scrollY)</script></body>`);
  });
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
  const preview = `http://127.0.0.1:${fixture.address().port}/demo`;
  const countBefore = created.size;
  const open = async () => {
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await panel.getByRole("dialog", { name: "Open", exact: true }).getByRole("textbox").fill(preview);
  };
  await open();
  await panel.getByRole("button", { name: "Open in window", exact: true }).click();
  await panel.locator('.terminal-browser-preview[data-browser-title="Native browser fixture"]').waitFor();
  await panel.locator(".browser-remote-image").waitFor();
  assert.equal(await panel.locator("iframe").count(), 0);
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), false);
  assert.equal(await panel.locator(".terminal-browser-note").count(), 0);
  assert.equal(await panel.locator(".terminal-engine-label, .terminal-cwd").count(), 0);
  assert.equal(await panel.locator(".terminal-panel-header").evaluate(el => el.getBoundingClientRect().height), 32);
  const browserId = await panel.locator(".terminal-browser-preview").getAttribute("data-browser-id");
  const beforeFold = requests;
  await panel.getByRole("button", { name: "Expand toolbar", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), true);
  await panel.getByRole("button", { name: "Collapse toolbar", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-addressbar").isVisible(), false);
  assert.equal(await panel.locator(".terminal-browser-preview").getAttribute("data-browser-id"), browserId);
  assert.equal(requests, beforeFold);
  assert.equal(created.size, countBefore);
  await page.screenshot({ path: join(artifacts, "browser-toolbar-collapsed.png") });
  const surfaceBox = await panel.locator('.browser-remote-surface').boundingBox();
  await page.mouse.click(surfaceBox.x + 40, surfaceBox.y + 35);
  await page.keyboard.type('NativeUI');
  await panel.locator('.browser-input-capture').evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true, composed: true })));
  await panel.locator('.terminal-browser-preview[data-browser-title="typed:NativeUI中文"]').waitFor();
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+c');
  await page.waitForFunction(() => navigator.clipboard.readText().then(text => text === 'NativeUI中文'));
  await page.mouse.click(surfaceBox.x + 42, surfaceBox.y + 90);
  await panel.locator('.terminal-browser-preview[data-browser-title="NATIVE_POPUP"]').waitFor();
  await page.mouse.click(surfaceBox.x + 42, surfaceBox.y + 90);
  await panel.locator('.terminal-browser-preview[data-browser-url$="/demo"]').waitFor();
  await panel.getByRole('button', { name: 'Expand toolbar', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Web address', exact: true }).fill(preview.replace('/demo', '/second'));
  await panel.getByRole('textbox', { name: 'Web address', exact: true }).press('Enter');
  await panel.locator('.terminal-browser-preview[data-browser-url$="/second"]').waitFor();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await panel.locator('.terminal-browser-preview[data-browser-url$="/demo"]').waitFor();
  await panel.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
  await page.mouse.move(surfaceBox.x + 300, surfaceBox.y + 200);
  await page.mouse.wheel(0, 360);
  await panel.locator('.terminal-browser-preview[data-browser-title^="SCROLL:"]').waitFor();
  checks.push('native-browser-pointer-keyboard-CJK-copy-history-popup-and-real-page-scroll');
  checks.push("browser-toolbar-default-collapsed-one-row-no-help-banner-no-page-reload");
  checks.push("independent-chrome-no-iframe-frame-denied-site-rendered-keeps-original-pty");
  const popupPromise = context.waitForEvent("page");
  await open();
  await panel.getByRole("button", { name: "Open externally", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL(preview);
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.close();
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
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
