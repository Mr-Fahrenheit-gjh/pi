import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { checkQuickActionShortcuts } from './quick-actions-shortcuts.mjs';

const root = process.env.PI_WEB_CHAT_PACKAGE_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const production = Boolean(process.env.PI_WEB_CHAT_PACKAGE_ROOT);
const out = join(root, 'test-results/split-conversation');
mkdirSync(out, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), 'pi-split-'));
const project = join(fixture, 'project');
mkdirSync(project);
mkdirSync(join(fixture, 'sessions/test'), { recursive: true });
writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [] }));
const recentSessions = Array.from({ length: 8 }, (_, i) => ({ id: `split-history-${i}`, name: `Numbered conversation ${i + 1}` }));
const sessions = [{ id: 'split-primary', name: 'Primary conversation' }, ...recentSessions];
for (const session of sessions) {
  const timestamp = new Date().toISOString();
  writeFileSync(join(fixture, 'sessions/test', `2026-10-24_${session.id}.jsonl`), [
    { type: 'session', version: 3, id: session.id, timestamp, cwd: project },
    { type: 'session_info', id: 'name', parentId: null, timestamp, name: session.name },
    { type: 'message', id: 'prompt', parentId: 'name', timestamp, message: { role: 'user', content: session.name, timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
}
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(out, 'server.log'));
const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), production ? 'start' : 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: root, env: { ...process.env, NODE_ENV: production ? 'production' : 'development', PI_CODING_AGENT_DIR: fixture, PI_WEB_PASSWORD: '', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
let browser;
try {
  console.log(`[split] Waiting for preview at ${base}`);
  const startupDeadline = Date.now() + 120_000;
  for (;;) {
    if (await fetch(base, { signal: AbortSignal.timeout(10_000) }).then(response => response.ok).catch(() => false)) break;
    if (Date.now() >= startupDeadline || server.exitCode !== null) throw new Error('Test server unavailable; see server.log');
    await delay(500);
  }
  console.log('[split] Preview ready; checking browser layout');
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('pi-locale', 'en');
    localStorage.setItem('pi-ui-language-version', 'english-interface-v1');
  });
  const page = await context.newPage();
  const errors = [];
  let sends = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/agent/**', async route => {
    if (route.request().method() === 'POST') {
      const command = route.request().postDataJSON();
      if (['prompt', 'ensure_session'].includes(command?.type)) sends++;
      return route.fulfill({ json: { success: true, data: {} } });
    }
    if (route.request().url().includes('/subagents')) return route.fulfill({ json: { available: false } });
    return route.fulfill({ json: { running: false, state: { isStreaming: false, isPromptRunning: false, messages: [], extensionStatuses: [], extensionWidgets: [] }, sessions: [] } });
  });
  const shortcutChecks = process.env.PI_WEB_SPLIT_ONLY === '1' ? [] : await checkQuickActionShortcuts(page, { base, sessionId: 'split-primary', outputDir: out, recentSessions });
  await page.goto(`${base}/?session=split-primary`, { waitUntil: 'networkidle' });
  await page.locator('.chat-input-textarea').waitFor();
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.quick-actions-backdrop input').fill('split');
  await page.getByRole('option', { name: /Split conversation/ }).click();
  const right = page.locator('.secondary-conversation');
  const left = page.locator('.primary-conversation');
  await right.getByRole('heading', { name: 'Open a conversation alongside' }).waitFor();
  const widths = await Promise.all([left, right].map(node => node.evaluate(el => el.getBoundingClientRect().width)));
  assert.ok(Math.abs(widths[0] - widths[1]) <= 2, `Equal halves: ${widths}`);
  await page.screenshot({ path: join(out, 'split-picker.png') });
  const initialURL = page.url();
  await left.locator('textarea.chat-input-textarea').fill('primary draft');
  await right.getByRole('button', { name: /New conversation/ }).click();
  await right.locator('textarea.chat-input-textarea').fill('secondary draft');
  assert.equal(await left.locator('textarea.chat-input-textarea').inputValue(), 'primary draft');
  assert.equal(page.url(), initialURL);
  assert.equal(await right.locator('.split-conversation-header').count(), 0, 'No secondary-only title bar');
  await page.keyboard.press('ControlOrMeta+j');
  await page.locator('.quick-actions-backdrop').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await right.locator('textarea.chat-input-textarea').inputValue(), 'secondary draft');
  await page.keyboard.press('ControlOrMeta+j');
  await page.locator('.quick-actions-backdrop input').fill('Numbered conversation 4');
  await page.getByRole('option', { name: /Numbered conversation 4/ }).first().click();
  await right.locator('textarea.chat-input-textarea').waitFor();
  assert.equal(page.url(), initialURL);
  assert.equal(await left.locator('textarea.chat-input-textarea').inputValue(), 'primary draft');
  await page.screenshot({ path: join(out, 'split-history.png') });
  const newInPane = async pane => {
    await pane.locator('textarea.chat-input-textarea').click();
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.quick-actions-backdrop input').fill('new chat');
    await page.getByRole('option', { name: /New conversation in this project/ }).click();
    await pane.locator('[data-composer-layout="welcome"]').waitFor();
  };
  await newInPane(right);
  assert.equal(page.url(), initialURL, 'New in the right pane leaves the left alone');
  await newInPane(left);
  const geometry = async pane => pane.evaluate(node => {
    const selectors = ['.chat-content', '.new-session-hero', '.new-session-greeting', '[data-composer-layout="welcome"]', '.new-session-context', '.chat-input-textarea'];
    return selectors.map(selector => {
      const element = node.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { selector, top: box.top, height: box.height, width: box.width, font: style.font, padding: style.padding, radius: style.borderRadius, background: style.backgroundColor };
    });
  });
  const [primaryGeometry, secondaryGeometry] = await Promise.all([geometry(left), geometry(right)]);
  for (let i = 0; i < primaryGeometry.length; i++) {
    const a = primaryGeometry[i], b = secondaryGeometry[i];
    for (const key of ['top', 'height', 'width']) assert.ok(Math.abs(a[key] - b[key]) <= 2, `${a.selector} ${key}: ${a[key]} vs ${b[key]}`);
    for (const key of ['font', 'padding', 'radius', 'background']) assert.equal(a[key], b[key], `${a.selector} ${key}`);
  }
  assert.deepEqual(await left.locator('.new-session-context button').allTextContents(), await right.locator('.new-session-context button').allTextContents());
  await page.screenshot({ path: join(out, 'split-matching-welcome.png') });
  // The same sidebar selects a history conversation in whichever pane was focused.
  await right.locator('textarea.chat-input-textarea').click();
  await page.locator('.session-tree-main').filter({ hasText: 'Numbered conversation 4' }).first().click();
  await right.getByText('Numbered conversation 4', { exact: true }).first().waitFor();
  assert.equal(await left.locator('[data-composer-layout="welcome"]').count(), 1);
  // Main-pane navigation to the right's session must remove its second composer.
  await left.locator('textarea.chat-input-textarea').click();
  await page.keyboard.press('ControlOrMeta+j');
  await page.locator('.quick-actions-backdrop input').fill('Numbered conversation 4');
  await page.getByRole('option', { name: /Numbered conversation 4/ }).first().click();
  await right.getByRole('heading', { name: 'Open a conversation alongside' }).waitFor();
  assert.equal(await right.locator('textarea.chat-input-textarea').count(), 0);
  await page.setViewportSize({ width: 600, height: 850 });
  assert.equal(await right.isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.quick-actions-backdrop input').fill('close split');
  await page.getByRole('option', { name: /Close split/ }).click();
  await right.waitFor({ state: 'detached' });
  assert.equal(await right.count(), 0);
  assert.equal(sends, 0, 'Navigation and new composers never send or start a model');
  assert.deepEqual(errors, []);
  const result = { passed: true, shortcutChecks, checks: ['equal halves', 'no secondary-only header', 'independent drafts', 'shared palette preserves draft on cancel', 'history search targets focused pane', 'new conversation targets focused pane', 'identical welcome geometry and styles', 'identical project/worktree controls', 'sidebar targets focused pane', 'primary URL unchanged', 'duplicate session guard', 'mobile fallback', 'close split via palette', 'zero model requests'] };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  log.end();
  rmSync(fixture, { recursive: true, force: true });
}
