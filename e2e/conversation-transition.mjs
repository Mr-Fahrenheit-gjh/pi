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

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.env.PI_WEB_CHAT_PACKAGE_ROOT || source;
const out = process.env.PI_WEB_TEST_OUTPUT_DIR || join(source, 'test-results/conversation-transition');
mkdirSync(out, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), 'pi-web-transition-'));
const project = join(agentDir, 'project');
mkdirSync(project);
mkdirSync(join(agentDir, 'sessions/test'), { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [] }));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'test', model: 'test', usage, stopReason: 'stop', timestamp: Date.now() });
for (const letter of ['a', 'b', 'c']) {
  const timestamp = new Date().toISOString();
  const id = `transition-${letter}`;
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd: project },
    { type: 'session_info', id: 'title', timestamp, name: `动效测试 ${letter.toUpperCase()}` },
    { type: 'message', id: 'user', parentId: 'title', timestamp, message: { role: 'user', content: `问题 ${letter}`, timestamp: Date.now() } },
    { type: 'message', id: 'answer', parentId: 'user', timestamp, message: assistant(`对话 ${letter.toUpperCase()} 的正文。切换时只有轻微明暗过渡，没有位移或缩放。`) },
  ];
  writeFileSync(join(agentDir, 'sessions/test', `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const log = createWriteStream(join(out, 'server.log'));
const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: '', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(r => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    await delay(200);
  }
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
  await context.addInitScript(() => {
    localStorage.setItem('pi-locale', 'zh-CN');
    localStorage.setItem("pi-ui-language-version", "english-interface-v1"); // Explicit test locale after migration.
    window.__motion = [];
    document.addEventListener('animationstart', e => {
      if (e.animationName === 'conversation-enter') window.__motion.push({ type: 'enter', at: performance.now() });
    }, true);
    document.addEventListener('transitionstart', e => {
      if (e.target.classList.contains('conversation-transition')) window.__motion.push({ type: 'exit', inert: e.target.inert, at: performance.now() });
    }, true);
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/agent/*/subagents**', route => route.fulfill({ json: { available: false } }));
  const state = { running: false, state: { isStreaming: false, isPromptRunning: false, messages: [], thinkingLevel: 'off', extensionStatuses: [], extensionWidgets: [] } };
  await page.route('**/api/sessions/*/state', route => route.fulfill({ json: state }));
  await page.route('**/api/agent/transition-*', route => route.fulfill({ json: state }));
  const link = letter => page.locator(`a.session-tree-main[href="?session=transition-${letter}"]`);
  const answer = letter => page.getByText(`对话 ${letter.toUpperCase()} 的正文。切换时只有轻微明暗过渡，没有位移或缩放。`, { exact: true });
  const settled = async letter => {
    await answer(letter).waitFor();
    await page.waitForFunction(() => !document.querySelector('.conversation-transition.is-leaving') && document.querySelector('.chat-content')?.getAnimations().every(a => a.playState === 'finished'));
  };
  await page.goto(`${base}/?session=transition-a`, { waitUntil: 'networkidle' });
  await settled('a');
  await link('b').click();
  await settled('b');
  const motion = await page.evaluate(() => window.__motion);
  assert.ok(motion.some(e => e.type === 'exit' && e.inert), 'Outgoing conversation must be inert while fading');
  assert.ok(motion.filter(e => e.type === 'enter').length >= 2, 'Loaded incoming content must fade in');
  assert.equal(await page.locator('.chat-content').evaluate(el => getComputedStyle(el).transform), 'none');
  const baseline = motion.length;
  await link('b').click();
  await delay(300);
  assert.equal(await page.evaluate(() => window.__motion.length), baseline, 'Same-session click must not animate or remount');
  await page.evaluate(message => { window.__feed({ type: 'agent_start' }); window.__feed({ type: 'message_start', message }); }, assistant('流式更新保持稳定'));
  await page.getByText('流式更新保持稳定', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__motion.length), baseline, 'Streaming update must not replay navigation animation');

  // Two selections inside one exit interval: no queue and no stale destination.
  await page.evaluate(() => {
    document.querySelector('a.session-tree-main[href="?session=transition-a"]').click();
    setTimeout(() => document.querySelector('a.session-tree-main[href="?session=transition-c"]').click(), 15);
  });
  await settled('c');
  assert.ok(page.url().endsWith('?session=transition-c'));
  await delay(250);
  assert.equal(await answer('a').count(), 0);
  await answer('c').waitFor();

  // A cold delayed load must still animate when the actual content arrives.
  await page.reload({ waitUntil: 'networkidle' });
  await settled('c');
  await page.route('**/api/sessions/transition-a', async route => { await delay(450); await route.continue(); });
  const beforeSlow = await page.evaluate(() => window.__motion.filter(e => e.type === 'enter').length);
  await link('a').click();
  await settled('a');
  assert.equal(await page.evaluate(() => window.__motion.filter(e => e.type === 'enter').length), beforeSlow + 1);
  await page.screenshot({ path: join(out, 'desktop.png') });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const beforeReduced = await page.evaluate(() => window.__motion.length);
  await link('b').click();
  await settled('b');
  assert.equal(await page.locator('.chat-content').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await page.evaluate(() => window.__motion.length), beforeReduced);
  assert.equal(await page.locator('.conversation-transition').evaluate(el => el.inert), false);
  assert.deepEqual(errors, []);
  const result = { passed: true, packageRoot: root, buildId: readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), desktop: true, checks: ['fade-out-in', 'outgoing-inert', 'no-transform', 'same-session-no-replay', 'streaming-no-replay', 'rapid-latest-wins', 'slow-history-entrance', 'reduced-motion'], formalDeploymentVerified: false };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await once(server, 'exit');
  log.end();
}
