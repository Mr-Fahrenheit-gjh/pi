import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer } from 'node:net';
import { checkComposerFocus } from './composer-focus.mjs';
import { checkQuickActionShortcuts } from './quick-actions-shortcuts.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.env.PI_WEB_CHAT_PACKAGE_ROOT || source;
const out = join(source, 'test-results/quiet-tools');
mkdirSync(out, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), 'pi-web-quiet-'));
const project = join(agentDir, 'project');
mkdirSync(project);
mkdirSync(join(agentDir, 'sessions/quiet'), { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [] }));
const sid = 'quiet-tools-smoke';
const timestamp = new Date().toISOString();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, extra = {}) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'test', model: 'test', usage, stopReason: 'stop', timestamp: Date.now(), ...extra });
const quotedMathSource = String.raw`> 若 \(f(x)\) 连续且 \(a_n=f(n)\)，则
>
> \[\boxed{
> \sum_{n=N}^{\infty}a_n \quad\text{与}\quad \int_N^\infty f(x)\,dx \text{同敛散}.
> }\]`;
const entries = [];
const add = (message) => entries.push({ type: 'message', id: `entry${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp, message });
add({ role: 'user', content: '已完成的测试任务', timestamp: Date.now() });
add(assistant([{ type: 'text', text: '过程中的说明始终可见' }, { type: 'thinking', thinking: 'HIDDEN_THINKING' }, { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'echo HIDDEN_COMMAND' } }]));
add({ role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: [{ type: 'text', text: 'HIDDEN_OUTPUT' }], isError: false, timestamp: Date.now() });
add(assistant([{ type: 'text', text: `正式回答可见\n\n${quotedMathSource}\n\n公式后续正文` }]));
add({ role: 'user', content: '历史无内容网络失败', timestamp: Date.now() });
add(assistant([], { stopReason: 'error', errorMessage: 'fetch failed' }));
add({ role: 'user', content: '历史部分回答后重试', timestamp: Date.now() });
add(assistant([{ type: 'text', text: '历史部分说明可见' }], { stopReason: 'error', errorMessage: '  FETCH FAILED  ' }));
add(assistant([{ type: 'text', text: '历史重试成功回答' }]));
add({ role: 'user', content: '历史重要错误', timestamp: Date.now() });
add(assistant([], { stopReason: 'error', errorMessage: 'fetch failed: 403 forbidden' }));
add({ role: 'user', content: '历史截断提示', timestamp: Date.now() });
add(assistant([], { stopReason: 'length' }));
add({ role: 'user', content: '正在执行的测试任务', timestamp: Date.now() });
add(assistant([{ type: 'toolCall', id: 'call2', name: 'read', arguments: { path: 'HIDDEN_PATH' } }]));
add({ role: 'toolResult', toolCallId: 'call2', toolName: 'read', content: [{ type: 'text', text: 'HIDDEN_FAILURE_DETAIL' }], isError: true, timestamp: Date.now() });
const sessionFile = join(agentDir, 'sessions/quiet', `2026-10-12T00-00-00-000Z_${sid}.jsonl`);
const save = () => writeFileSync(sessionFile, [{ type: 'session', version: 3, id: sid, timestamp, cwd: project }, ...entries].map(x => JSON.stringify(x)).join('\n') + '\n');
save();
const shortcutSessions = Array.from({ length: 8 }, (_, index) => ({ id: `shortcut-fixture-${index + 1}`, name: `Numbered conversation ${index + 1}` }));
for (const session of shortcutSessions) {
  writeFileSync(join(agentDir, 'sessions/quiet', `2026-10-12T00-00-00-000Z_${session.id}.jsonl`), [
    { type: 'session', version: 3, id: session.id, timestamp, cwd: project },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: session.name, timestamp: Date.now() } },
    { type: 'message', id: 'answer', parentId: 'user', timestamp, message: assistant([{ type: 'text', text: 'Completed shortcut fixture.' }]) },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(r => probe.close(r));
const log = createWriteStream(join(out, 'server.log'));
const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: '', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser;
let live = false;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(r => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    await delay(200);
  }
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ locale: 'zh-CN' });
  // Inject controllable SSE events; no model API or live user's session is used.
  await context.addInitScript(() => {
    localStorage.setItem('pi-locale', 'zh-CN');
    localStorage.setItem("pi-ui-language-version", "english-interface-v1"); // Explicit test locale after migration.
    window.__sources = [];
    window.EventSource = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) { this.url = url; window.__sources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connected', isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
    window.__feed = event => window.__sources.filter(s => s.readyState === 1).forEach(s => s.onmessage?.({ data: JSON.stringify(event) }));
  });
  const page = await context.newPage();
  await page.route('**/api/agent/*/subagents**', route => route.fulfill({ json: { available: false } }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = () => ({ running: live, state: { isStreaming: live, isPromptRunning: live, messages: [], thinkingLevel: 'off', extensionStatuses: [], extensionWidgets: [] } });
  await page.route(`**/api/sessions/${sid}/state`, route => route.fulfill({ json: state() }));
  await page.route(`**/api/agent/${sid}`, route => route.fulfill({ json: state() }));
  await page.goto(`${base}/?session=${sid}`, { waitUntil: 'networkidle' });
  await page.getByText('正式回答可见', { exact: true }).waitFor();
  await page.getByText('过程中的说明始终可见', { exact: true }).waitFor();
  const quotedMath = page.locator('.markdown-assistant-message blockquote').filter({ hasText: '连续' });
  await quotedMath.locator('.katex-display').waitFor();
  assert.equal(await quotedMath.locator('.katex-error').count(), 0);
  assert.equal(await quotedMath.locator('.katex-display').count(), 1);
  await page.getByText('公式后续正文', { exact: true }).waitFor();
  await quotedMath.screenshot({ path: join(out, 'quoted-display-math.png') });
  assert.equal(await page.getByText('HIDDEN_OUTPUT', { exact: true }).count(), 0);
  assert.equal(await page.getByText('HIDDEN_FAILURE_DETAIL', { exact: true }).count(), 0);
  assert.equal(await page.getByText('有 1 次工具执行失败，可展开过程查看详情。', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-process-details]').count(), 0, 'finished history has no permanent process disclosure');
  const fetchError = page.getByText(/^Error: (fetch failed|FETCH FAILED)$/);
  assert.equal(await fetchError.count(), 0, 'history fetch failures are collapsed');
  await page.getByText('历史部分说明可见', { exact: true }).waitFor();
  await page.getByText('历史重试成功回答', { exact: true }).waitFor();
  await page.getByText(/fetch failed: 403 forbidden/).waitFor();
  await page.getByText(/输出在生成正文前就达到了上限/).waitFor();
  live = true;
  await page.evaluate(() => window.__feed({ type: 'agent_start' }));
  const active = page.locator('[data-process-details][data-running]');
  const activeToggle = active.locator(':scope > button');
  await active.getByText('Pi is working', { exact: true }).waitFor();
  await active.locator('.pi-working-mark').waitFor();
  assert.equal(await active.locator('.pi-working-mark').getAttribute('src'), '/icons/pi-mark.svg');
  assert.equal(await active.locator('.pi-working-mark').getAttribute('width'), '26');
  assert.equal(await active.locator('.pi-working-mark').evaluate(el => getComputedStyle(el).animationDuration), '0s');
  assert.equal(await active.locator('.process-toggle-label').evaluate(el => getComputedStyle(el).animationDuration), '2s');
  assert.equal(await activeToggle.evaluate(el => getComputedStyle(el).fontSize), '14px');
  const answerFont = await page.locator('.markdown-assistant-message').first().evaluate(el => getComputedStyle(el).fontFamily);
  assert.ok(answerFont.includes('Georgia'));
  assert.equal(await page.locator('.markdown-user-message').first().evaluate(el => getComputedStyle(el).fontFamily), answerFont);
  assert.equal(await activeToggle.getAttribute('aria-expanded'), 'false');
  assert.equal((await activeToggle.innerText()).trim(), 'Pi is working');
  assert.equal(await page.getByText('HIDDEN_FAILURE_DETAIL', { exact: true }).count(), 0);
  await activeToggle.click();
  await page.getByRole('button', { name: /read.*HIDDEN_PATH/ }).click();
  await activeToggle.click();
  for (const viewport of [{ width: 1280, height: 900 }, ...(process.env.PI_WEB_TEST_MOBILE === '1' ? [{ width: 390, height: 844 }] : [])]) {
    await page.setViewportSize(viewport);
    await activeToggle.click();
    await page.getByText('HIDDEN_FAILURE_DETAIL', { exact: true }).waitFor();
    await activeToggle.click();
    assert.equal(await page.getByText('HIDDEN_FAILURE_DETAIL', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  const feed = event => page.evaluate(event => window.__feed(event), event);
  await feed({ type: 'message_start', message: assistant([{ type: 'thinking', thinking: 'STREAM_HIDDEN_REASONING' }]) });
  assert.equal(await page.getByText('STREAM_HIDDEN_REASONING', { exact: true }).count(), 0);
  await activeToggle.click();
  await page.getByText('STREAM_HIDDEN_REASONING', { exact: true }).waitFor();
  await activeToggle.click();
  for (let i = 0; i < 3; i++) {
    await feed({ type: 'message_start', message: assistant([{ type: 'text', text: '运行中说明' }, { type: 'thinking', thinking: 'STREAM_HIDDEN_REASONING' + i }]) });
    await page.getByText('运行中说明', { exact: true }).waitFor();
    assert.equal(await activeToggle.getAttribute('aria-expanded'), 'false');
    await activeToggle.click();
    await page.getByText('STREAM_HIDDEN_REASONING' + i, { exact: true }).waitFor();
    await activeToggle.click();
    assert.equal(await activeToggle.getAttribute('aria-expanded'), 'false');
  }
  await feed({ type: 'message_start', message: assistant([{ type: 'text', text: '完整短回复，没有后续新增输出。' }], { provider: 'openai-codex', model: 'gpt-6.1-sol' }) });
  await page.getByText('完整短回复，没有后续新增输出。', { exact: true }).waitFor();
  await page.locator('[data-model-label] use[href="/provider-icons.svg#openai"]').waitFor();
  await delay(1200);
  assert.equal(await page.getByText('0.0 t/s', { exact: true }).count(), 0);
  await page.screenshot({ path: join(out, 'working-font-desktop.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await active.locator('.pi-working-mark').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await feed({ type: 'message_start', message: assistant([{ type: 'thinking', thinking: 'STREAM_HIDDEN_REASONING' }, { type: 'text', text: '流式正式回答' }]) });
  await page.getByText('流式正式回答', { exact: true }).waitFor();
  await feed({ type: 'message_end', message: assistant([], { stopReason: 'error', errorMessage: 'fetch failed' }) });
  assert.equal(await fetchError.count(), 0, 'live empty fetch error stays folded');
  await activeToggle.click();
  await active.getByText('Error: fetch failed', { exact: true }).waitFor();
  await activeToggle.click();
  await feed({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'fetch failed' });
  await feed({ type: 'agent_start' });
  await feed({ type: 'message_start', message: assistant([{ type: 'text', text: '实时重试成功回答' }]) });
  await page.getByText('实时重试成功回答', { exact: true }).waitFor();
  assert.equal(await activeToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await fetchError.count(), 0);
  await feed({ type: 'message_end', message: assistant([{ type: 'text', text: '实时重试成功回答' }]) });
  await feed({ type: 'message_end', message: assistant([{ type: 'text', text: '实时部分回答仍可见' }], { stopReason: 'error', errorMessage: '  FETCH FAILED  ' }) });
  await page.getByText('实时部分回答仍可见', { exact: true }).waitFor();
  assert.equal(await fetchError.count(), 0);
  await activeToggle.click();
  await active.getByText('Error: FETCH FAILED', { exact: true }).waitFor();
  await activeToggle.click();
  await feed({ type: 'message_end', message: assistant([], { stopReason: 'error', errorMessage: 'VISIBLE_PROVIDER_ERROR' }) });
  await page.getByText(/VISIBLE_PROVIDER_ERROR/).waitFor();
  await feed({ type: 'extension_ui_request', id: 'confirm-test', method: 'confirm', title: '权限确认测试', message: '确认提示不能被隐藏' });
  await page.getByText('确认提示不能被隐藏', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, process.env.PI_WEB_TEST_MOBILE === '1' ? 'mobile.png' : 'desktop.png'), fullPage: true });
  await page.keyboard.press('Escape');
  live = false;
  add(assistant([], { stopReason: 'error', errorMessage: 'fetch failed' }));
  add(assistant([{ type: 'text', text: '新的正式回答' }]));
  save();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('新的正式回答', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-process-details][data-running]').count(), 0);
  assert.equal(await page.locator('[data-process-details] button[aria-expanded="true"]').count(), 0);
  assert.equal(await fetchError.count(), 0, 'retry success does not reveal prior failures');
  assert.equal(await page.locator('[data-process-details]').count(), 0, 'completed process controls stay unmounted');
  add({ role: 'user', content: '最终空内容网络失败', timestamp: Date.now() });
  add(assistant([], { stopReason: 'error', errorMessage: 'fetch failed' }));
  save();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('最终空内容网络失败', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-process-details]').count(), 0, 'final failed history does not restore a finished-process entry');
  assert.equal(await fetchError.count(), 0);
  await page.screenshot({ path: join(out, 'fetch-final-error-desktop.png'), fullPage: true });
  const focusChecks = process.env.PI_WEB_TEST_MOBILE === '1' ? [] : await checkComposerFocus(page, { base, sessionId: sid });
  const shortcutChecks = process.env.PI_WEB_TEST_MOBILE === '1' ? [] : await checkQuickActionShortcuts(page, { base, sessionId: sid, outputDir: out, recentSessions: shortcutSessions });
  // Inspect a long synthetic prompt without initializing an agent or calling a model.
  const promptFixture = Array.from({ length: 120 }, (_, index) => `Instruction ${index + 1}: preserve <literal> prompt text and wrap long lines consistently.`).join('\n');
  let promptReads = 0;
  await page.route(`**/api/agent/${sid}`, async route => {
    const command = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (command?.type === 'get_state') {
      promptReads++;
      return route.fulfill({ json: { success: true, data: { systemPrompt: promptFixture } } });
    }
    if (command?.type === 'get_tools') return route.fulfill({ json: { success: true, data: [] } });
    return route.fallback();
  });
  if (!await page.locator('#session-sidebar.sidebar-open').count()) await page.locator('[data-sidebar-toggle]').click();
  await page.locator('.workspace-settings-entry > button').first().click();
  const settings = page.locator('.settings-dialog-surface');
  await settings.waitFor();
  const systemTab = settings.locator('.settings-section-tab').last();
  await systemTab.click();
  const promptPage = settings.locator('.settings-system-prompt');
  const promptText = promptPage.locator('.system-prompt-text');
  await promptText.waitFor();
  assert.equal(await promptText.textContent(), promptFixture);
  assert.equal(await settings.locator('.settings-mobile-section-picker option').last().getAttribute('value'), 'system');
  assert.equal(await systemTab.getAttribute('aria-current'), 'page');
  const promptGeometry = await promptPage.evaluate(node => {
    const header = node.querySelector('.config-detail-header').getBoundingClientRect();
    const panel = node.querySelector('.system-prompt-panel').getBoundingClientRect();
    const scroll = node.querySelector('.system-prompt-scroll');
    const host = node.parentElement;
    return { aligned: Math.abs(header.x - panel.x) < 1 && Math.abs(header.width - panel.width) < 1,
      fillsWidth: panel.width > node.clientWidth * 0.85,
      outerScroll: node.scrollHeight > node.clientHeight + 1 || host.scrollHeight > host.clientHeight + 1,
      innerScroll: scroll.scrollHeight > scroll.clientHeight,
      contained: panel.bottom <= host.getBoundingClientRect().bottom + 1 };
  });
  assert.deepEqual(promptGeometry, { aligned: true, fillsWidth: true, outerScroll: false, innerScroll: true, contained: true });
  const readsBeforeRefresh = promptReads;
  await promptPage.getByRole('button').click();
  await page.waitForFunction(() => !document.querySelector('.settings-system-prompt button')?.disabled);
  assert.ok(promptReads > readsBeforeRefresh, 'Refresh reloads the current prompt');
  await settings.screenshot({ path: join(out, 'settings-system-prompt.png') });
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  const result = { passed: true, buildId: readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), packageRoot: root, isolatedAgentDir: agentDir, desktopAndMobile: process.env.PI_WEB_TEST_MOBILE === '1', tested: ['finished history process controls absent', 'live collapse', 'running expand and collapse', 'streaming reasoning hidden', 'streaming answer visible', 'tool failure summary absent; running details available when expanded', 'provider error visible', 'extension confirm visible', 'completion removes process controls', 'fetch failed history/no-content/final-error hidden; running details expandable', 'partial answer with fetch failure visible', 'retry success keeps fetch errors hidden', 'other model failures and truncation visible', 'quoted glued bracket display math renders boxed integral test without errors and preserves following prose', ...focusChecks, ...shortcutChecks, 'system prompt: last settings tab, shared header, full-width aligned body, single inner scroll, exact text and refresh'], timestamp: new Date().toISOString() };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  log.end();
}
