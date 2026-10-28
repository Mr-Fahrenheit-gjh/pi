// Exercise the unified UI against real history and a temporary, explicitly closed PTY.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '../pi-web-source-0.12/node_modules/playwright/test.mjs';
import { verifySidebarBrowser } from './verify-sidebar-browser.mjs';

export async function verifyUnifiedUi({ page, context, base, packageRoot, here, sessionId, uiPolish = false }) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const theme = page.locator('input[name="theme"][value="claude"]');
  await theme.locator('..').click();
  await expect(theme).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'claude');
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim()), '#faf9f5');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${here}live-claude-theme.png` });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('input[name="theme"][value="claude-white"]').locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'claude-white');
  const colors = await page.locator('html').evaluate(el => {
    const style = getComputedStyle(el);
    return Object.fromEntries(['--bg', '--user-bg', '--tool-success-text', '--tool-error-text'].map(key => [key, style.getPropertyValue(key).trim()]));
  });
  assert.deepEqual(colors, { '--bg': '#fafaf9', '--user-bg': '#f0f0ed', '--tool-success-text': '#4c705c', '--tool-error-text': '#95564e' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${here}live-claude-white-theme.png` });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__navigationMotion = [];
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'conversation-enter') window.__navigationMotion.push('enter');
    }, true);
    document.addEventListener('transitionstart', event => {
      if (event.target.classList.contains('conversation-transition') && event.target.inert) window.__navigationMotion.push('inert-exit');
    }, true);
  });
  const other = page.locator(`a.session-tree-main[href^="?session="]:not([href="?session=${sessionId}"])`).first();
  await other.waitFor();
  const target = await other.getAttribute('href');
  await other.click();
  await page.waitForURL(url => url.search === target);
  await page.locator('.conversation-transition .chat-content').waitFor();
  await page.waitForFunction(() => window.__navigationMotion.includes('enter') && window.__navigationMotion.includes('inert-exit'));
  assert.equal(await page.locator('.chat-content').evaluate(el => getComputedStyle(el).transform), 'none');
  await expect(page.locator('.conversation-transition')).not.toHaveAttribute('inert', '');
  await page.screenshot({ path: `${here}live-conversation-motion.png` });

  const wasmResponse = await fetch(`${base}/vendor/ghostty-web/0.4.0/ghostty-vt.wasm`);
  assert.equal(wasmResponse.status, 200);
  const wasm = Buffer.from(await wasmResponse.arrayBuffer());
  const expectedWasm = await readFile(`${packageRoot}/node_modules/ghostty-web/ghostty-vt.wasm`);
  assert.equal(createHash('sha256').update(wasm).digest('hex'), createHash('sha256').update(expectedWasm).digest('hex'));
  const created = new Set();
  const onRequest = request => {
    if (new URL(request.url()).pathname === '/api/terminal' && request.method() === 'POST') created.add(request.postDataJSON().id);
  };
  page.on('request', onRequest);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => { window.__clipboardBeforeVerification = await navigator.clipboard.readText(); });
  try {
    const files = page.locator('#session-sidebar-panel-files');
    const toggle = files.locator('.sidebar-files-section-toggle');
    if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.getByRole('button', { name: '打开工作区终端', exact: true }).click();
    const panel = page.locator('.terminal-panel:visible');
    await page.locator('.terminal-panel:visible[data-terminal-status=ready]').waitFor();
    assert.equal(await panel.getAttribute('data-terminal-engine'), 'ghostty');
    assert.equal(await panel.locator('canvas').count(), 1);
    const preferencesResponse = await page.request.get(`${base}/api/terminal/preferences`);
    assert.ok(preferencesResponse.ok());
    const preferences = await preferencesResponse.json();
    assert.equal(preferences.source, 'ghostty');
    assert.ok(preferences.fontFamily.includes('JetBrainsMono Nerd Font'));
    assert.equal(preferences.fontSize, 14);
    assert.equal(await panel.getAttribute('data-terminal-font-family'), preferences.fontFamily);
    assert.equal(Number(await panel.getAttribute('data-terminal-font-size')), preferences.fontSize);
    const originalCanvas = await panel.locator('canvas').elementHandle();
    const verifyTerminalPalette = async () => {
      await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
      const { expected, actual } = await panel.evaluate(el => ({
        expected: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3').slice(1).match(/../g).map(value => parseInt(value, 16)),
        actual: getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3).map(Number),
      }));
      assert.deepEqual(actual, expected);
      const png = await panel.locator('canvas').screenshot();
      const pixel = await page.evaluate(async data => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return Array.from(ctx.getImageData(Math.floor(image.width / 2), image.height - 10, 1, 1).data).slice(0, 3);
      }, png.toString('base64'));
      assert.deepEqual(pixel, expected);
      assert.equal(await originalCanvas.evaluate(el => el.isConnected && el === el.closest('.terminal-panel')?.querySelector('canvas')), true);
      assert.equal(await panel.locator('.terminal-ghostty-surface').evaluate(el => getComputedStyle(el).caretColor), 'rgba(0, 0, 0, 0)');
    };
    await verifyTerminalPalette();
    for (const palette of ['dark', 'claude-white']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.locator(`input[name="theme"][value="${palette}"]`).locator('..').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
      await page.keyboard.press('Escape');
      await verifyTerminalPalette();
      assert.equal(created.size, 1, 'Theme changes must preserve the PTY');
      await page.screenshot({ path: `${here}live-ghostty-${palette}.png` });
    }
    await originalCanvas.dispose();
    await panel.locator('textarea').focus();
    await page.keyboard.type(" unset HISTFILE; printf '\\nPI_WEB_UI_%s\\n' '终端验收✓'");
    await page.keyboard.press('Enter');
    await expect(async () => {
      await panel.locator('textarea').focus();
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Meta+c');
      await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('PI_WEB_UI_终端验收✓'), undefined, { timeout: 1000 });
    }).toPass({ timeout: 15000 });
    const polishAcceptance = uiPolish ? await verifySidebarBrowser({ page, context, panel, created, packageRoot, here }) : {};
    const terminalId = [...created][0];
    assert.equal(created.size, 1);
    assert.equal(await panel.locator('.terminal-panel-header').count(), 0, 'Removed toolbar must not be restored');
    await context.setOffline(true);
    await page.locator('.terminal-panel:visible[data-terminal-status=connecting]').waitFor();
    await context.setOffline(false);
    await page.locator('.terminal-panel:visible[data-terminal-status=ready]').waitFor();
    assert.equal(created.size, 1, 'Reconnect must preserve the PTY');
    await page.screenshot({ path: `${here}live-ghostty-terminal.png` });
    const closed = await page.request.delete(`${base}/api/terminal/${terminalId}`, { headers: { Origin: base } });
    assert.ok(closed.ok());
    assert.equal((await page.request.get(`${base}/api/terminal/${terminalId}`)).status(), 404);
    return { ...polishAcceptance, conversationMotionVerified: true, claudeThemeVerified: true, claudeWhiteThemeVerified: true, ghosttyTerminalVerified: true, nativeGhosttyFontVerified: true, terminalThemeVerified: true };
  } finally {
    await context.setOffline(false);
    for (const id of created) await page.request.delete(`${base}/api/terminal/${id}`, { headers: { Origin: base } }).catch(() => {});
    await page.evaluate(async () => { await navigator.clipboard.writeText(window.__clipboardBeforeVerification); delete window.__clipboardBeforeVerification; }).catch(() => {});
    page.off('request', onRequest);
  }
}
