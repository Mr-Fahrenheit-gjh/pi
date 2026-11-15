import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { saveState, readState, STATE_TYPE } from './engine.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const roots = [
  '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent',
  '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent',
];
for (const root of roots) {
  for (const entrypoint of ['dist/index.js', 'dist/bundle/index.js']) {
  test(`real SDK lifecycle and retry budget: ${root} / ${entrypoint}`, async () => {
    const sdk = await import(join(root, entrypoint));
    const require = createRequire(join(root, 'package.json'));
    const localAi = join(root, 'node_modules/@earendil-works/pi-ai');
    const aiRoot = existsSync(localAi) ? localAi : join(dirname(root), 'pi-ai');
    const ai = await import(join(aiRoot, 'dist/index.js'));
    const compat = await import(join(aiRoot, 'dist/compat.js'));
    const { createJiti } = require('jiti');
    const recovery = await createJiti(import.meta.url).import(join(directory, 'index.ts'), { default: true });
    const temp = mkdtempSync(join(tmpdir(), 'pi-recovery-test-'));
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { enabled: false } });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(temp, 'auth.json'), modelsPath: join(temp, 'models.json') });
    const model = compat.getModel('openai', 'gpt-4o');
    await runtime.setRuntimeApiKey('openai', 'test-only-no-network');
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [recovery] });
    await loader.reload();
    const manager = sdk.SessionManager.create(temp, temp);
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, model, modelRuntime: runtime,
      resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: true });
    let calls = 0;
    let stopReason = 'error';
    session.agent.streamFunction = () => {
      calls++;
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: 'assistant', content: stopReason === 'stop' ? [{ type: 'text', text: 'done' }] : [],
        api: model.api, provider: model.provider, model: model.id, stopReason, errorMessage: stopReason === 'error' ? 'fetch failed' : undefined,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
      stream.push(stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message });
      return stream;
    };
    try {
      await session.bindExtensions({ mode: 'print' });
      await session.prompt('isolated retry test');
      assert.equal(calls, 4, 'original request plus exactly three retries');
      assert.equal(readState(manager).status, 'paused');
      assert.equal(readState(manager).spent, 3);
      assert.ok(manager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'pi-task-recovery-notice' && entry.display === true), 'pause is a visible persisted message');
      stopReason = 'stop'; calls = 0;
      await session.prompt('new authorized task');
      assert.equal(calls, 1); assert.equal(readState(manager).status, 'done');
      // A waiting recovery can be cancelled before any request is active.
      saveState(manager, { version: 1, sessionId: manager.getSessionId(), runId: 'interrupted', status: 'pending', spent: 2,
        admitted: true, tools: [], waitingForInput: false, ownerPid: -999 });
      await session.bindExtensions({ mode: 'print' });
      await session.abort();
      assert.equal(readState(manager).status, 'cancelled');
      // Reopen persisted history in a new manager; cancellation survives.
      const reopened = sdk.SessionManager.open(manager.getSessionFile());
      assert.equal(readState(reopened).status, 'cancelled');
      // Recovery plus native failure share a budget, not three attempts each.
      saveState(manager, { ...readState(manager), status: 'pending', spent: 2 });
      calls = 0; stopReason = 'error';
      session._retryAttempt = 0;
      await session._prepareRetry({ role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' });
      assert.equal(readState(manager).spent, 3);
      assert.equal(await session._prepareRetry({ role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' }), false);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); rmSync(temp, { recursive: true, force: true });
    }
  });
  }
  test(`SIGKILL and automatic resume from disk: ${root}`, { timeout: 30000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'pi-recovery-crash-'));
    const child = fork(join(directory, 'crash-fixture.mjs'), [root, temp, join(directory, 'index.ts')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const exit = once(child, 'exit');
    const started = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exit.then(() => { throw new Error(`Crash fixture exited before admission: ${stderr}`); }),
    ]);
    child.kill('SIGKILL'); await exit;
    const sdk = await import(join(root, 'dist/index.js'));
    const require = createRequire(join(root, 'package.json'));
    const aiRoot = existsSync(join(root, 'node_modules/@earendil-works/pi-ai')) ? join(root, 'node_modules/@earendil-works/pi-ai') : join(dirname(root), 'pi-ai');
    const ai = await import(join(aiRoot, 'dist/index.js'));
    const compat = await import(join(aiRoot, 'dist/compat.js'));
    const recovery = await require('jiti').createJiti(import.meta.url).import(join(directory, 'index.ts'), { default: true });
    const manager = sdk.SessionManager.open(started.sessionFile);
    assert.equal(readState(manager).status, 'pending'); assert.equal(readState(manager).admitted, true);
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(temp, 'auth.json'), modelsPath: join(temp, 'models.json') });
    await runtime.setRuntimeApiKey('openai', 'test-only-no-network');
    const model = compat.getModel('openai', 'gpt-4o');
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [recovery] });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, model, modelRuntime: runtime,
      resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: true });
    let calls = 0;
    session.agent.streamFunction = () => {
      calls++;
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Resumed safely.' }], api: model.api, provider: model.provider,
        model: model.id, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
      stream.push({ type: 'done', reason: 'stop', message }); return stream;
    };
    let deadline;
    try {
      const settled = new Promise(resolve => session.subscribe(event => { if (event.type === 'agent_settled') resolve(); }));
      await session.bindExtensions({ mode: 'print' });
      await Promise.race([settled, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Recovery did not settle')), 20000); })]);
      assert.equal(calls, 1); assert.equal(readState(manager).status, 'done');
      assert.equal(manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 1, 'does not resubmit the original user input');
      assert.ok(manager.getBranch().some(entry => entry.type === 'custom' && entry.customType === STATE_TYPE && entry.data.spent === 1));
    } finally {
      clearTimeout(deadline); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); rmSync(temp, { recursive: true, force: true });
    }
  });
}
