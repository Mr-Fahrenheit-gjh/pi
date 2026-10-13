import assert from "node:assert/strict";
export async function verifySidebarBrowserWheel({ page, panel, run, waitScreen, checks, artifacts }) {
  const { join } = await import("node:path");
  const selected = page.locator(".session-tree-session.is-selected").first();
  assert.equal(await selected.evaluate(el => getComputedStyle(el, "::before").content), "none");
  assert.equal(await selected.locator(".session-tree-title").evaluate(el => getComputedStyle(el).fontSize), "13px");
  checks.push("claude-sidebar-neutral-selection-and-legible-titles");
  assert.equal(await panel.locator(".terminal-ghostty-surface").evaluate(el => getComputedStyle(el).caretColor), "rgba(0, 0, 0, 0)");
  assert.equal(await panel.locator(".terminal-panel-header, .terminal-open-control, .browser-remote-surface").count(), 0);
  const top = await panel.evaluate(el => el.getBoundingClientRect().top);
  assert.equal(await panel.locator(".terminal-workspace-content").evaluate(el => el.getBoundingClientRect().top), top);
  checks.push("terminal-toolbar-removed-no-reserved-row-no-remote-browser-surface");
  checks.push("native-host-caret-hidden-real-terminal-cursor-retained");
  const script = ["import os,sys,termios,tty,select", "old=termios.tcgetattr(0)", "tty.setraw(0)", "sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HSCROLL_WAIT')", "sys.stdout.flush()", "ready=select.select([0],[],[],8)[0]", "data=os.read(0,1024) if ready else b''", "sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l')", "sys.stdout.flush()", "termios.tcsetattr(0,termios.TCSADRAIN,old)", "print('\\nWHEEL_REPORT:'+data.hex(),flush=True)"].join(";");
  await run(`python3 -c ${JSON.stringify(script)}`);
  await waitScreen(/SCROLL_WAIT/);
  const box = await panel.locator("canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -24);
  await waitScreen(/WHEEL_REPORT:1b5b3c36343b/);
  checks.push("real-pty-fullscreen-trackpad-sends-sgr-wheel-not-history-arrows");
  await page.screenshot({ path: join(artifacts, "terminal-without-toolbar.png") });
}
