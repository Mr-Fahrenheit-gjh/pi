// Current user scope: no terminal toolbar; local HTML uses the existing iframe.
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function verifySidebarBrowser({ page, panel, created, packageRoot, here }) {
  const selected = page.locator('.session-tree-session.is-selected').first();
  await selected.waitFor();
  assert.equal(await selected.evaluate(el => getComputedStyle(el, '::before').content), 'none');
  assert.equal(await selected.locator('.session-tree-title').evaluate(el => getComputedStyle(el).fontSize), '13px');
  assert.equal(await panel.locator('.terminal-ghostty-surface').evaluate(el => getComputedStyle(el).caretColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await panel.locator('.terminal-panel-header, .terminal-open-control, .browser-remote-surface').count(), 0);
  assert.equal(await panel.evaluate(el => el.getBoundingClientRect().top), await panel.locator('.terminal-workspace-content').evaluate(el => el.getBoundingClientRect().top));
  const sdkRoot = `${packageRoot}/node_modules/@earendil-works/pi-coding-agent`;
  for (const relative of ['dist/core/agent-session.js', 'dist/bundle/chunks/chunk-TJXZSVTD.js']) {
    const source = await readFile(`${sdkRoot}/${relative}`, 'utf8');
    for (const hook of ['recordStop as piRecoveryStop', 'piRecoveryStop(this.sessionManager)', 'piRecoverySpent(this.sessionManager)', 'piRecoveryRetry(this.sessionManager']) assert.ok(source.includes(hook));
  }
  const run = async command => { await panel.locator('textarea').focus(); await page.keyboard.type(command); await page.keyboard.press('Enter'); };
  const waitScreen = async text => {
    for (let i = 0; i < 40; i++) {
      await panel.locator('textarea').focus(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+c');
      const output = await page.evaluate(() => navigator.clipboard.readText());
      if (text === 'PI_WHEEL_WAIT' ? /(?:^|\n)PI_WHEEL_WAIT\s*(?:\n|$)/.test(output) : output.includes(text)) return;
      await page.waitForTimeout(150);
    }
    throw new Error(`Missing own terminal output: ${text}`);
  };
  const script = ['import os,sys,termios,tty,select', 'old=termios.tcgetattr(0)', 'tty.setraw(0)', "sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HPI_WHEEL_WAIT')", 'sys.stdout.flush()', 'ready=select.select([0],[],[],15)[0]', "data=os.read(0,1024) if ready else b''", "sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l')", 'sys.stdout.flush()', 'termios.tcsetattr(0,termios.TCSADRAIN,old)', "print('\\nPI_WHEEL_REPORT:'+data.hex(),flush=True)"].join(';');
  await run(` python3 -c ${JSON.stringify(script)}`); await waitScreen('PI_WHEEL_WAIT');
  const box = await panel.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -24); await waitScreen('PI_WHEEL_REPORT:1b5b3c36343b');
  await page.screenshot({ path: `${here}live-terminal-without-toolbar.png` });
  const terminalLabel = await page.locator('#file-panel [role=tab][aria-selected=true]').getAttribute('aria-label');
  const id = [...created].at(-1);
  const base = new URL(page.url()).origin;
  const cwd = (await (await page.request.get(`${base}/api/terminal/${id}`)).json()).cwd;
  const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  assert.ok(cwd === repository || cwd.startsWith(repository + '/'), 'HTML fixture must stay inside this workspace');
  const filename = `pi-web-html-check-${randomUUID()}.html`;
  const path = join(cwd, filename);
  await writeFile(path, '<!doctype html><html><body><h1>HTML_IFRAME_OK</h1><input id="notes"><script>window.instanceToken=Math.random()</script></body></html>', { flag: 'wx', mode: 0o600 });
  try {
    await page.getByRole('button', { name: '刷新文件列表', exact: true }).click();
    await page.getByTitle(path, { exact: true }).click();
    const iframe = page.locator('#file-panel iframe'); await iframe.waitFor();
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.getByRole('heading', { name: 'HTML_IFRAME_OK' }).waitFor();
    await frame.locator('#notes').fill('直接渲染，不走截图');
    assert.equal(await frame.locator('#notes').inputValue(), '直接渲染，不走截图');
    assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
    await page.screenshot({ path: `${here}live-html-iframe.png` });
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.locator('#file-panel iframe').count(), 0);
    await page.getByRole('button', { name: 'Preview', exact: true }).click(); await iframe.waitFor();
    await page.getByRole('tab', { name: terminalLabel, exact: true }).click();
  } finally { await rm(path, { force: true }); }
  return { sidebarPolishVerified: true, terminalWheelVerified: true, sharedRecoveryHooksVerified: true, terminalToolbarRemovedVerified: true, htmlIframePreviewVerified: true };
}
