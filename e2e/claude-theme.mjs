// Desktop candidate only. Never starts a model or reads the user's settings.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.PI_WEB_CHAT_PACKAGE_ROOT, 'An isolated built candidate is required');
const packageRoot = resolve(process.env.PI_WEB_CHAT_PACKAGE_ROOT);
const out = resolve(process.env.PI_WEB_TEST_OUTPUT_DIR || join(source, 'test-results/claude-theme'));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'pi-web-claude-'));
const agent = join(home, '.pi/agent');
mkdirSync(join(agent, 'sessions/fixture'), { recursive: true });
const project = join(home, 'project');
mkdirSync(project);
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [] }));
const sid = 'claude-theme-fixture';
const timestamp = new Date().toISOString();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const messages = [
  { role: 'user', content: '暖白主题阅读测试 · Warm reading palette', timestamp: Date.now() },
  { role: 'assistant', content: [{ type: 'text', text: '## Claude 风格配色\n\n暖米白背景、深炭灰文字与陶土强调色。保留原有字体、布局和过程折叠。\n\nA calm reading surface, not an exact copy of Claude.\n\n```ts\nconst theme = "claude";\n```\n\n[本地文档](https://example.invalid)' }, { type: 'thinking', thinking: 'THEME_HIDDEN_PROCESS' }], api: 'openai-completions', provider: 'anthropic', model: 'claude-sonnet-4-6', usage, stopReason: 'stop', timestamp: Date.now() },
];
messages[1].content.push(
  { type: 'toolCall', id: 'theme-ok', name: 'bash', arguments: { command: 'printf theme-ok' } },
  { type: 'toolCall', id: 'theme-error', name: 'read', arguments: { path: 'missing-file' } },
);
messages.push(
  { role: 'toolResult', toolCallId: 'theme-ok', toolName: 'bash', content: [{ type: 'text', text: 'theme-ok' }], isError: false, timestamp: Date.now() },
  { role: 'toolResult', toolCallId: 'theme-error', toolName: 'read', content: [{ type: 'text', text: 'File not found' }], isError: true, timestamp: Date.now() },
  { ...messages[1], content: [{ type: 'text', text: '浅白主题保留柔和、清晰的成功与失败状态。' }] },
);
writeFileSync(join(agent, 'sessions/fixture', `${timestamp.replaceAll(':', '-')}_${sid}.jsonl`), [
  { type: 'session', version: 3, id: sid, timestamp, cwd: project },
  ...messages.map((message, index) => ({ type: 'message', id: `entry${index}`, parentId: index ? `entry${index - 1}` : null, timestamp, message })),
].map(entry => JSON.stringify(entry)).join('\n') + '\n');
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const log = createWriteStream(join(out, 'server.log'));
const server = spawn(process.execPath, [join(packageRoot, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: packageRoot, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: '', PI_WEB_DISABLE_MCP: '1', PI_OFFLINE: '1', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
let browser, page;
const screenshots = [];
const errors = [];
try {
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(response => response.ok).catch(() => false)) { healthy = true; break; }
    assert.equal(server.exitCode, null);
    await delay(200);
  }
  assert.ok(healthy, 'Candidate must start');
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/agent/*/subagents**', route => route.fulfill({ json: { available: false } }));
  await page.goto(`${base}/?session=${sid}`, { waitUntil: 'networkidle' });
  await page.locator('.markdown-assistant-message').first().waitFor();
  const expectTheme = async theme => {
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    assert.equal(await page.locator('html').evaluate(root => root.classList.contains('dark')), ['dark', 'pine'].includes(theme));
  };
  const openSettings = () => page.getByRole('button', { name: 'Settings', exact: true }).click();
  const select = async (id, resolved = id) => {
    await page.locator(`input[name="theme"][value="${id}"]`).locator('..').click();
    await expectTheme(resolved);
    assert.equal(await page.evaluate(() => localStorage.getItem('pi-theme')), id);
  };
  await expectTheme('dark'); // No preference: still follows the system.
  await openSettings();
  assert.equal(await page.locator('input[name="theme"]').count(), 8);
  await select('claude');
  assert.equal(await page.getByRole('radio', { name: 'Claude', exact: true }).isChecked(), true);
  assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).getPropertyValue('--bg').trim()), '#faf9f5');
  assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).colorScheme), 'light');
  await page.screenshot({ path: join(out, 'claude-settings-desktop.png') }); screenshots.push('claude-settings-desktop.png');
  await page.keyboard.press('Escape');
  const typography = () => page.locator('.markdown-assistant-message').first().evaluate(el => ({ font: getComputedStyle(el).fontFamily, size: getComputedStyle(el).fontSize }));
  const before = await typography();
  assert.ok(before.font.includes('Georgia'));
  assert.equal(await page.locator('.markdown-user-message').first().evaluate(el => getComputedStyle(el).fontFamily), before.font);
  assert.equal(await page.getByText('THEME_HIDDEN_PROCESS', { exact: true }).count(), 0);
  const toggle = page.locator('[data-process-details] > button').first();
  for (let i = 0; i < 3; i++) {
    await toggle.click(); await page.getByText('THEME_HIDDEN_PROCESS', { exact: true }).waitFor();
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  }
  await page.locator('[data-model-label] use[href="/provider-icons.svg#anthropic"]').first().waitFor();
  await page.screenshot({ path: join(out, 'claude-chat-desktop.png') }); screenshots.push('claude-chat-desktop.png');
  await page.reload({ waitUntil: 'networkidle' });
  await expectTheme('claude');
  await page.emulateMedia({ colorScheme: 'light' }); await expectTheme('claude');
  await page.emulateMedia({ colorScheme: 'dark' }); await expectTheme('claude');
  await openSettings();
  assert.equal(await page.locator('input[value="claude"]').isChecked(), true);
  for (const theme of ['light', 'dark', 'mist', 'rose', 'pine']) {
    await select(theme);
    if (theme === 'light' || theme === 'dark') {
      await page.keyboard.press('Escape');
      assert.deepEqual(await typography(), before);
      await page.screenshot({ path: join(out, `${theme}-chat-desktop.png`) }); screenshots.push(`${theme}-chat-desktop.png`);
      await openSettings();
    }
  }
  await select('auto', 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await expectTheme('light');
  // Keyboard selection uses the existing native radio group.
  await page.locator('input[value="dark"]').focus();
  await page.keyboard.press('ArrowRight'); await expectTheme('claude');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await select('light'); await select('claude');
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  assert.equal(await page.locator('.settings-theme-option').evaluateAll(options => options.every(option => option.scrollWidth <= option.clientWidth)), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await select('claude-white');
  assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).getPropertyValue('--bg').trim()), '#fafaf9');
  await page.keyboard.press('Escape');
  assert.deepEqual(await typography(), before);
  await toggle.click();
  const success = page.locator('[data-tool-status="success"]').first();
  const failure = page.locator('[data-tool-status="error"]').first();
  assert.equal(await success.locator('button > span').first().evaluate(el => getComputedStyle(el).color), 'rgb(76, 112, 92)');
  assert.equal(await failure.locator('button > span').first().evaluate(el => getComputedStyle(el).color), 'rgb(149, 86, 78)');
  assert.equal(await success.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(76, 112, 92, 0.04)');
  assert.equal(await failure.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(149, 86, 78, 0.45)');
  await page.screenshot({ path: join(out, 'claude-white-chat-desktop.png') }); screenshots.push('claude-white-chat-desktop.png');
  await page.reload({ waitUntil: 'networkidle' }); await expectTheme('claude-white');
  await page.emulateMedia({ colorScheme: 'dark' }); await expectTheme('claude-white');
  await openSettings();
  await select('claude'); // The original palette remains available and unchanged.
  assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).getPropertyValue('--bg').trim()), '#faf9f5');
  // Both Chinese localizations use the same registered theme and saved preference.
  for (const locale of ['zh-CN', 'zh-TW']) {
    await page.evaluate(locale => localStorage.setItem('pi-locale', locale), locale);
    await page.reload({ waitUntil: 'networkidle' }); await expectTheme('claude');
    await page.getByRole('button', { name: locale === 'zh-CN' ? '设置' : '設定', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: 'Claude 暖白', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('radio', { name: locale === 'zh-CN' ? 'Claude 浅白' : 'Claude 淺白', exact: true }).count(), 1);
    await page.screenshot({ path: join(out, `claude-settings-${locale}.png`) }); screenshots.push(`claude-settings-${locale}.png`);
  }
  assert.deepEqual(errors, []);
  const result = { passed: true, packageRoot, buildId: readFileSync(join(packageRoot, '.next/BUILD_ID'), 'utf8').trim(), desktopOnly: true, realModelRequests: 0, screenshots: screenshots.map(path => join(out, path)), checks: ['eight selectable themes', 'original Claude palette preserved', 'neutral Claude White persistence', 'theme-aware success/error card colors', 'warm palette tokens', 'light color scheme on dark system', 'persistence after refresh', 'system changes do not override Claude', 'auto tracks system', 'original palettes selectable', 'font size/family unchanged', 'process repeatedly collapsible', 'manufacturer icon', 'keyboard radio selection', 'view transitions', 'en/zh-CN/zh-TW labels', 'no overflow', 'no browser errors'] };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  log.end();
}
