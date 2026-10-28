import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { plan } from './install.mjs';
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
const root = process.env.PI_TUI_TEST_SDK ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const changes = plan(root);
if (changes.some((change) => change.before !== change.after)) throw new Error('Run --check on the approved installation before PTY smoke');
const chunk = changes[1].path;
const { InteractiveMode, AgentSessionRuntime, createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(chunk));
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const entered = gate(), release = gate(), bDone = gate();
const dir = await mkdtemp(join(tmpdir(), 'pi-tui-live-smoke-'));
const faux = fauxProvider({ models: [{ id: 'tui-local-smoke' }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);
let executions = 0;
const slots = [];
const factory = async ({ sessionManager, cwd, sessionStartEvent }) => {
  const tool = { name: 'hold_local', label: 'Local smoke', description: 'Synthetic local tool', parameters: { type: 'object', properties: {} },
    async execute() { executions++; entered.resolve(); await release.promise; return { content: [{ type: 'text', text: 'A local tool finished' }], details: {} }; } };
  const { session } = await createAgentSession({ cwd, agentDir: dir, modelRuntime, model: faux.getModel('tui-local-smoke'),
    tools: ['hold_local'], customTools: [tool], sessionManager, sessionStartEvent,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, quietStartup: true, tuiMode: 'regular' }) });
  const counts = { starts: 0, aborts: 0 };
  const emit = session.extensionRunner.emit.bind(session.extensionRunner);
  session.extensionRunner.emit = (event) => { if (event.type === 'session_start') counts.starts++; return emit(event); };
  const abort = session.abort.bind(session);
  session.abort = (...args) => { counts.aborts++; return abort(...args); };
  slots.push({ session, counts });
  return { session, services: { cwd, agentDir: dir }, diagnostics: [] };
};
const first = await factory({ cwd: dir, sessionManager: SessionManager.create(dir, join(dir, 'sessions')), sessionStartEvent: { type: 'session_start', reason: 'startup' } });
const host = new AgentSessionRuntime(first.session, first.services, factory);
const ui = new InteractiveMode(host, { tuiMode: 'regular' });
let result;
try {
  assert.equal(process.stdin.isTTY, true, 'smoke must run in its own real PTY');
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_local', {}, { id: 'local-a-tool' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('B completed while A waited')]),
    fauxAssistantMessage([fauxText('A completed after returning')]),
  ]);
  let inputs = 0;
  const sentinel = new Error('local smoke input complete');
  ui.getUserInput = async () => {
    if (inputs++ === 0) return 'synthetic A request';
    if (inputs === 2) return 'synthetic B request';
    bDone.resolve(); throw sentinel;
  };
  const run = ui.run();
  const runFinished = assert.rejects(run, (error) => error === sentinel);
  await entered.promise;
  const a = host.session;
  ui.editor.setText('synthetic A draft');
  await ui.handleClearCommand();
  await bDone.promise; await runFinished;
  const b = host.session;
  assert.notEqual(a, b);
  assert.equal(a.isIdle, false);
  assert.equal(a.agent.signal.aborted, false);
  assert.equal(b.getLastAssistantText(), 'B completed while A waited');
  await ui.handleResumeSession(a.sessionFile);
  assert.equal(host.session, a);
  assert.equal(ui.editor.getText(), 'synthetic A draft');
  assert.equal(ui.pendingTools.has('local-a-tool'), true);
  release.resolve(); await a.waitForIdle();
  assert.equal(a.getLastAssistantText(), 'A completed after returning');
  assert.equal(slots[0].counts.starts, 1);
  assert.equal(slots[0].counts.aborts, 0);
  assert.equal(executions, 1);
  assert.match(await readFile(a.sessionFile, 'utf8'), /A completed after returning/);
  result = { passed: true, checkedAt: new Date().toISOString(), sdkVersion: '1.4.0', sdkRoot: root, bundledChunk: chunk,
    bundleSha256: createHash('sha256').update(await readFile(chunk)).digest('hex'),
    terminal: 'real isolated tmux PTY / ProcessTerminal', provider: 'faux only; no external model or credentials',
    assertions: { aContinuedWhileBCompleted: true, restoredOriginalSessionObject: true, pendingToolAndDraftRestored: true,
      aAbortCountBeforeShutdown: slots[0].counts.aborts, aSessionStartCount: slots[0].counts.starts, toolExecutions: executions,
      aResultPersistedToOwnJsonl: true },
    limits: ['Existing TUI processes are not hot-reloaded', 'Full personal extension combination and real model not exercised', 'Pi Web was not restarted'] };
} catch (error) {
  result = { passed: false, error: error.stack, checkedAt: new Date().toISOString() };
} finally {
  release.resolve();
  try { await host.dispose(); } catch (error) { result = { ...result, passed: false, cleanupError: error.stack }; }
  ui.stop();
  await rm(dir, { recursive: true, force: true });
}
const resultPath = process.env.PI_TUI_SMOKE_RESULT ?? join(tmpdir(), `pi-tui-background-smoke-${process.pid}.json`);
await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
console.log('\nPI_TUI_BACKGROUND_SMOKE', resultPath, JSON.stringify(result));
process.exit(result.passed ? 0 : 1);
