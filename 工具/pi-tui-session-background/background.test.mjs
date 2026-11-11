import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, cp, symlink, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { installTuiBackground } from './background.mjs';
import { plan, patch } from './install.mjs';
import { patch as interruptPatch, enginePath } from '../pi-interrupt/install.mjs';

const root = realpathSync(process.env.PI_TUI_TEST_SDK ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(join(root, 'dist/index.js')));
const requireSdk = createRequire(join(root, 'package.json'));
const aiEntry = requireSdk.resolve.paths('@earendil-works/pi-ai').map((base) => join(base, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(pathToFileURL(aiEntry));
const { Type } = await import(pathToFileURL(requireSdk.resolve('typebox')));
const { emitSessionShutdownEvent } = await import(pathToFileURL(join(root, 'dist/core/extensions/runner.js')));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((done) => setImmediate(done));

// Keep the real runtime, real AgentSession, queues, persistence and faux model transport.
// Only the terminal rendering boundary is replaced in these lifecycle tests.
class TestUI {
  extensionDialogs = [];
  compactionQueuedMessages = [];
  pendingTools = new Map();
  events = [];
  statuses = [];
  effects = [];
  inputs = new Set();
  text = '';
  constructor(host) {
    this.runtimeHost = host;
    this.editor = { getText: () => this.text, setText: (text) => { this.text = text; } };
    this.defaultEditor = { onEscape() {} };
    host.setBeforeSessionInvalidate(() => { this.effects.push(['reset']); this.inputs.clear(); });
    host.setRebindSession(async () => {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      this.compactionQueuedMessages = [];
      await this.bindCurrentSessionExtensions();
      this.subscribeToAgent();
    });
  }
  get session() { return this.runtimeHost.session; }
  async init() { await this.bindCurrentSessionExtensions(); this.subscribeToAgent(); }
  async bindCurrentSessionExtensions() {
    await this.session.bindExtensions({ uiContext: this.createExtensionUIContext(), mode: 'tui',
      commandContextActions: { waitForIdle: () => this.session.waitForIdle(), newSession: (...args) => this.runtimeHost.newSession(...args),
        navigateTree: () => { this.effects.push(['navigate', this.session.sessionId]); },
        switchSession: (...args) => this.runtimeHost.switchSession(...args) },
      abortHandler: () => this.session.abort(),
      shutdownHandler: () => this.effects.push(['shutdown']),
      onError: (e) => this.effects.push(['error', e.error]),
    });
  }
  subscribeToAgent() { this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event)); }
  async handleEvent(event) { this.events.push({ session: this.session.sessionId, event }); }
  clearStatusIndicator() {}
  updatePendingMessagesDisplay() {}
  showStatus(message) { this.statuses.push(message); }
  showError(message) { this.statuses.push(message); }
  setupExtensionShortcuts(runner) {
    this.shortcuts = runner.getShortcuts({});
  }
  async handleFatalRuntimeError() { throw new Error('unexpected fatal exit'); }
  createExtensionUIContext() {
    return {
      setStatus: (...args) => this.effects.push(['status', ...args]),
      setWidget: (...args) => this.effects.push(['widget', ...args]),
      setTitle: (...args) => this.effects.push(['title', ...args]),
      notify: (...args) => this.effects.push(['notify', ...args]),
      setEditorText: (text) => { this.text = text; },
      getEditorText: () => this.text,
      setTheme: (name) => { this.effects.push(['theme', name]); return { success: true }; },
      onTerminalInput: (handler) => { this.inputs.add(handler); return () => this.inputs.delete(handler); },
      addAutocompleteProvider: (factory) => this.effects.push(['autocomplete', factory]),
      confirm: async (...args) => { this.effects.push(['confirm']); return this.confirmHook ? this.confirmHook(...args) : true; },
    };
  }
}
installTuiBackground(TestUI, emitSessionShutdownEvent);

async function fixture(t, tools = [], UIClass = TestUI, options = {}) {
  const { AgentSessionRuntime, createAgentSession, ModelRuntime, SessionManager, SettingsManager } = options.sdk ?? sdk;
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-background-test-'));
  const faux = fauxProvider({ models: [{ id: 'background-test' }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const sessions = [];
  let creations = 0;
  let fail = false;
  let createHook;
  const factory = async ({ sessionManager, cwd, sessionStartEvent }) => {
    if (fail) throw new Error('factory rejected');
    await createHook?.();
    creations++;
    const { session } = await createAgentSession({ cwd, agentDir: dir, modelRuntime,
      model: faux.getModel('background-test'), tools: tools.map((tool) => tool.name), customTools: tools,
      sessionManager, sessionStartEvent,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, images: { autoResize: false } }) });
    if (tools.length) session.setActiveToolsByName(tools.map((tool) => tool.name));
    const counts = { start: 0, shutdown: 0, abort: 0, dispose: 0 };
    const emit = session.extensionRunner.emit.bind(session.extensionRunner);
    const hasHandlers = session.extensionRunner.hasHandlers.bind(session.extensionRunner);
    session.extensionRunner.hasHandlers = (name) => name === 'session_shutdown' || hasHandlers(name);
    session.extensionRunner.emit = async (event) => {
      if (event.type === 'session_start') counts.start++;
      if (event.type === 'session_shutdown') counts.shutdown++;
      return emit(event);
    };
    const abort = session.abort.bind(session);
    session.abort = (...args) => { counts.abort++; return abort(...args); };
    const dispose = session.dispose.bind(session);
    session.dispose = () => { counts.dispose++; dispose(); };
    sessions.push({ session, counts });
    return { session, services: { cwd, agentDir: dir }, diagnostics: [] };
  };
  const initial = await factory({ sessionManager: SessionManager.create(dir, join(dir, 'sessions')), cwd: dir,
    sessionStartEvent: { type: 'session_start', reason: 'startup' } });
  const host = new AgentSessionRuntime(initial.session, initial.services, factory);
  const ui = new UIClass(host, options);
  await ui.init();
  t.after(async () => { await host.dispose(); ui.stop?.(); await rm(dir, { recursive: true, force: true }); });
  return { ui, host, faux, sessions, dir, get creations() { return creations; }, set fail(value) { fail = value; }, set createHook(value) { createHook = value; } };
}

const complete = (text) => fauxAssistantMessage([fauxText(text)]);

test('A keeps streaming across /new; B can run; /resume reuses exact A runtime and start event only once', { timeout: 10000 }, async (t) => {
  const entered = gate(), release = gate();
  const f = await fixture(t);
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return complete('A completed'); }, complete('B completed')]);
  const a = f.host.session;
  const prompt = f.ui.promptInForeground('A request');
  await entered.promise;
  f.ui.text = 'A draft';
  await f.host.newSession();
  await prompt; // Input loop is free although A has not completed.
  assert.equal(a.isIdle, false);
  assert.equal(a.agent.signal.aborted, false);
  assert.equal(f.sessions[0].counts.shutdown, 0);
  assert.equal(f.sessions[0].counts.abort, 0);
  const b = f.host.session;
  await f.ui.promptInForeground('B request');
  assert.equal(b.getLastAssistantText(), 'B completed');
  f.ui.text = 'B draft';
  await f.host.switchSession(a.sessionFile);
  assert.equal(f.host.session, a);
  assert.equal(f.ui.text, 'A draft');
  assert.equal(f.creations, 2);
  assert.equal(f.sessions[0].counts.start, 1);
  await f.host.switchSession(b.sessionFile);
  release.resolve();
  await a.waitForIdle();
  assert.equal(a.getLastAssistantText(), 'A completed');
  assert.equal(f.ui.text, 'B draft');
  assert.equal(b.getLastAssistantText(), 'B completed');
  const file = await readFile(a.sessionFile, 'utf8');
  assert.match(file, /A completed/);
  assert.doesNotMatch(file, /B completed/);
  assert.ok(f.ui.events.filter(({ event }) => event.type === 'message_end').every(({ session, event }) =>
    !event.message.content?.some?.((p) => p.text === 'A completed') || session === a.sessionId));
});

test('CLI initial prompt batches remain owned by A after switching to B', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(), release = gate(), secondInitial = gate();
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return complete('initial A answered'); },
    complete('B answered'),
    () => { secondInitial.resolve(); return complete('second initial A answered'); },
  ]);
  const a = f.host.session;
  const initial = f.ui.runInitialPrompts('initial one', undefined, ['initial two']);
  await entered.promise;
  await f.host.newSession();
  await initial;
  await f.ui.promptInForeground('B input');
  release.resolve(); await secondInitial.promise; await a.waitForIdle();
  const users = a.messages.filter((m) => m.role === 'user').map((m) => m.content.map((p) => p.text).join(''));
  assert.deepEqual(users, ['initial one', 'initial two']);
  assert.equal(f.host.session.getLastAssistantText(), 'B answered');
});

test('a long-running tool executes exactly once, is not aborted, and persists while B is active', { timeout: 10000 }, async (t) => {
  const entered = gate(), release = gate();
  let executions = 0, aborted = false;
  const f = await fixture(t, [{ name: 'hold', label: 'hold', description: 'test', parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      executions++; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      entered.resolve(); await release.promise;
      return { content: [{ type: 'text', text: 'tool result A' }], details: {} };
    } }]);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' }), complete('after tool')]);
  const a = f.host.session;
  void f.ui.promptInForeground('use hold');
  await entered.promise;
  await f.host.newSession();
  release.resolve(); await a.waitForIdle();
  assert.equal(executions, 1); assert.equal(aborted, false);
  assert.match(await readFile(a.sessionFile, 'utf8'), /tool result A/);
  assert.equal(a.getLastAssistantText(), 'after tool');
});

test('cached UI methods and command contexts cannot mutate B; state, draft, input listeners restore to A', async (t) => {
  const f = await fixture(t);
  const a = f.host.session;
  const ctx = a.extensionRunner.createCommandContext();
  const cached = ctx.ui;
  const setStatus = cached.setStatus;
  const listener = () => {};
  const remove = cached.onTerminalInput(listener);
  cached.setEditorText('extension initial draft');
  f.ui.text = 'user draft';
  await f.host.newSession();
  const before = f.ui.effects.length;
  setStatus('background', 'running');
  cached.setTitle('A title');
  cached.setEditorText('updated A draft');
  assert.equal(cached.setTheme('dark').success, false);
  assert.equal(f.ui.effects.length, before);
  assert.equal(f.ui.inputs.size, 0);
  let navigated = false;
  const navigate = ctx.navigateTree('unused').then(() => { navigated = true; });
  await tick(); assert.equal(navigated, false);
  await f.host.switchSession(a.sessionFile);
  await navigate;
  assert.equal(f.ui.text, 'updated A draft');
  assert.equal(f.ui.inputs.size, 1);
  assert.ok(f.ui.effects.some((effect) => effect[0] === 'status' && effect[1] === 'background'));
  assert.deepEqual(f.ui.effects.at(-1), ['navigate', a.sessionId]);
  remove(); assert.equal(f.ui.inputs.size, 0);
});

test('background approval waits for its own foreground; never appears in B or auto-approves', async (t) => {
  const f = await fixture(t);
  const a = f.host.session, cached = a.extensionRunner.getUIContext();
  await f.host.newSession();
  let answered = false;
  const approval = cached.confirm('allow?', 'sensitive').then((value) => { answered = value; });
  await tick(); assert.equal(answered, false);
  assert.equal(f.ui.effects.some((e) => e[0] === 'confirm'), false);
  await f.host.switchSession(a.sessionFile);
  await approval;
  assert.equal(answered, true);
});

test('aborting a background approval cancels its wait without rendering it', async (t) => {
  const f = await fixture(t);
  const cached = f.host.session.extensionRunner.getUIContext();
  await f.host.newSession();
  const controller = new AbortController();
  const approval = cached.confirm('allow?', 'sensitive', { signal: controller.signal });
  controller.abort(); assert.equal(await approval, undefined);
  assert.equal(f.ui.effects.some((e) => e[0] === 'confirm'), false);
});

test('failed target factory leaves A attached, running and with its original draft', async (t) => {
  const f = await fixture(t);
  const a = f.host.session;
  f.ui.text = 'do not lose'; f.fail = true;
  await assert.rejects(f.host.newSession(), /factory rejected/);
  assert.equal(f.host.session, a); assert.equal(f.ui.text, 'do not lose');
  assert.deepEqual(f.sessions[0].counts, { start: 1, shutdown: 0, abort: 0, dispose: 0 });
});

test('same active session is a no-op, switch cancellation remains supported, and active dialogs reject switches', async (t) => {
  const f = await fixture(t);
  await f.host.switchSession(f.host.session.sessionFile);
  assert.equal(f.creations, 1);
  f.ui.extensionDialogs.push({});
  await assert.rejects(f.host.newSession(), /current dialog/);
  f.ui.extensionDialogs.length = 0;
  const emit = f.host.session.extensionRunner.emit.bind(f.host.session.extensionRunner);
  f.host.session.extensionRunner.hasHandlers = (name) => name === 'session_before_switch';
  f.host.session.extensionRunner.emit = (event) => event.type === 'session_before_switch' ? { cancel: true } : emit(event);
  assert.deepEqual(await f.host.newSession(), { cancelled: true });
  assert.equal(f.creations, 1);
});

test('quit aborts and disposes every loaded session exactly once; pending background prompts are released', async (t) => {
  const f = await fixture(t);
  const cached = f.host.session.extensionRunner.getUIContext();
  await f.host.newSession();
  const approval = cached.confirm('allow?', 'question');
  await f.host.dispose();
  await approval;
  await f.host.dispose();
  for (const { counts } of f.sessions) {
    assert.equal(counts.abort, 1); assert.equal(counts.shutdown, 1); assert.equal(counts.dispose, 1);
  }
});

test('a dialog appearing during target creation cancels the commit without losing its Promise', async (t) => {
  const f = await fixture(t);
  const a = f.host.session;
  const entered = gate(), proceed = gate(), answer = gate();
  f.createHook = async () => { entered.resolve(); await proceed.promise; };
  const switching = f.host.newSession();
  await entered.promise;
  f.ui.confirmHook = () => answer.promise;
  const approval = a.extensionRunner.getUIContext().confirm('question', 'answer first');
  proceed.resolve();
  let error;
  try { await switching; } catch (caught) { error = caught; }
  assert.match(error.message, /current dialog/);
  assert.equal(f.host.session, a);
  assert.equal(f.sessions[1].counts.dispose, 1);
  assert.deepEqual(await f.ui.handleFatalRuntimeError('switch failed', error), { cancelled: true });
  answer.resolve(false); assert.equal(await approval, false);
  await f.host.newSession();
  assert.equal(f.sessions[0].counts.abort, 0);
});

test('async extension shortcuts retain owner UI and report errors only to that session', async (t) => {
  const f = await fixture(t);
  const a = f.host.session;
  const runner = a.extensionRunner;
  const proceed = gate();
  runner.getShortcuts = () => new Map([['ctrl+x', { handler: async (ctx) => {
    await proceed.promise;
    ctx.ui.setEditorText('A shortcut draft');
    throw new Error('A shortcut error');
  } }]]);
  f.ui.setupExtensionShortcuts(runner);
  const shortcut = f.ui.shortcuts.get('ctrl+x').handler({});
  await f.host.newSession();
  proceed.resolve(); await shortcut;
  assert.equal(f.ui.text, '');
  assert.equal(f.ui.statuses.some((s) => s.includes('A shortcut error')), false);
  await f.host.switchSession(a.sessionFile);
  assert.equal(f.ui.text, 'A shortcut draft');
  assert.ok(f.ui.statuses.some((s) => s.includes('A shortcut error')));
});

test('reload invalidates cached UI and does not resurrect removed listeners/widgets on reattach', async (t) => {
  const f = await fixture(t);
  const a = f.host.session;
  const oldUI = a.extensionRunner.getUIContext();
  oldUI.onTerminalInput(() => {});
  oldUI.setWidget('old', ['removed widget']);
  oldUI.addAutocompleteProvider(() => {});
  await a.reload();
  assert.equal(f.ui.inputs.size, 0);
  oldUI.setEditorText('stale callback');
  const boundary = f.ui.effects.length;
  await f.host.newSession();
  await f.host.switchSession(a.sessionFile);
  assert.equal(f.ui.inputs.size, 0);
  assert.equal(f.ui.text, '');
  assert.equal(f.ui.effects.slice(boundary).some((e) => e[0] === 'widget' || e[0] === 'autocomplete'), false);
});

test('background session commands wake only after the restore transaction commits', async (t) => {
  const f = await fixture(t);
  const a = f.host.session, ctx = a.extensionRunner.createCommandContext();
  await f.host.newSession();
  const b = f.host.session;
  const command = ctx.newSession();
  await tick(); assert.equal(f.creations, 2);
  await f.host.switchSession(a.sessionFile);
  assert.deepEqual(await command, { cancelled: false });
  assert.equal(f.creations, 3);
  assert.notEqual(f.host.session, a); assert.notEqual(f.host.session, b);
});

test('quit releases active modal tools and shutdown-owned tool resources without blocking other sessions', { timeout: 10000 }, async (t) => {
  const shutdownTool = gate(), shutdownEntered = gate(), confirmEntered = gate();
  const f = await fixture(t, [
    { name: 'shutdown_hold', label: 'hold', description: 'test', parameters: Type.Object({}),
      async execute() { shutdownEntered.resolve(); await shutdownTool.promise; return { content: [{ type: 'text', text: 'released' }], details: {} }; } },
    { name: 'confirm_hold', label: 'confirm', description: 'test', parameters: Type.Object({}),
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        await ctx.ui.confirm('pending approval', 'wait');
        return { content: [{ type: 'text', text: 'released approval' }], details: {} };
      } },
  ]);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('shutdown_hold', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('confirm_hold', {})], { stopReason: 'toolUse' }),
  ]);
  const a = f.host.session;
  const emit = a.extensionRunner.emit.bind(a.extensionRunner);
  a.extensionRunner.emit = (event) => { if (event.type === 'session_shutdown') shutdownTool.resolve(); return emit(event); };
  const aRun = f.ui.promptInForeground('hold resource');
  await shutdownEntered.promise; await f.host.newSession(); await aRun;
  f.ui.confirmHook = () => { confirmEntered.resolve(); return new Promise(() => {}); };
  const bRun = f.ui.promptInForeground('confirm resource');
  await confirmEntered.promise;
  await f.host.dispose(); await bRun;
  for (const { counts } of f.sessions) {
    assert.equal(counts.abort, 1); assert.equal(counts.shutdown, 1); assert.equal(counts.dispose, 1);
  }
});

test('manual compaction completes in background and continues its queued messages in A', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const compacting = gate(), summary = gate(), queuedDone = gate();
  f.faux.setResponses([
    complete('seed '.repeat(200)),
    async () => { compacting.resolve(); await summary.promise; return complete('compact summary'); },
    complete('first queued answer'),
    () => { queuedDone.resolve(); return complete('second queued answer'); },
  ]);
  const a = f.host.session;
  await f.ui.promptInForeground('seed question');
  const settings = a.settingsManager.getCompactionSettings.bind(a.settingsManager);
  a.settingsManager.getCompactionSettings = (model) => ({ ...settings(model), keepRecentTokens: 0 });
  const compact = a.compact();
  await compacting.promise;
  f.ui.compactionQueuedMessages.push({ text: 'first queued', mode: 'steer' }, { text: 'second queued', mode: 'followUp' });
  await f.host.newSession();
  const b = f.host.session;
  summary.resolve(); await compact;
  await queuedDone.promise; await a.waitForIdle();
  assert.equal(a.getLastAssistantText(), 'second queued answer');
  assert.equal(b.messages.length, 0);
  assert.equal(f.ui.events.some(({ session, event }) => session === b.sessionId && event.type === 'compaction_end'), false);
});

for (const bundled of [false, true]) {
  test(`${bundled ? 'bundled CLI' : 'SDK'} interrupt while A is docked waits for full settled and never touches B`, { timeout: 10000 }, async (t) => {
    const runtime = bundled ? await import(pathToFileURL(plan(root)[1].path)) : sdk;
    const { installInterruptSteer, getInterruptSteerState, waitForInterruptSteer } = await import(pathToFileURL(enginePath));
    installInterruptSteer(runtime.AgentSession);
    const f = await fixture(t, [], TestUI, { sdk: runtime });
    const entered = gate(), unwind = gate(), settling = gate(), settled = gate();
    const a = f.host.session;
    const emit = a.extensionRunner.emit.bind(a.extensionRunner);
    let physicalSettles = 0;
    a.extensionRunner.emit = async (event) => {
      if (event.type === 'agent_settled' && ++physicalSettles === 1) { settling.resolve(); await settled.promise; }
      return emit(event);
    };
    f.faux.setResponses([
      async (_context, options) => {
        entered.resolve();
        if (!options.signal.aborted) await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        await unwind.promise;
        return complete('cancelled A');
      },
      complete('B unaffected'), complete('A replacement'),
    ]);
    const prompt = f.ui.promptInForeground('A original');
    await entered.promise;
    await f.host.newSession(); await prompt;
    const b = f.host.session;
    await f.ui.promptInForeground('B original');
    f.ui.text = 'B draft';
    await a.steer('A corrected');
    assert.equal(a.agent.signal.aborted, true);
    assert.notEqual(b.agent.signal?.aborted, true);
    unwind.resolve(); await settling.promise;
    assert.equal(f.faux.state.callCount, 2, 'replacement cannot start before awaited settled finishes');
    settled.resolve(); await waitForInterruptSteer(a); await a.waitForIdle();
    assert.equal(a.getLastAssistantText(), 'A replacement');
    assert.equal(b.getLastAssistantText(), 'B unaffected');
    assert.equal(f.ui.text, 'B draft');
    assert.equal(physicalSettles, 2);
    assert.equal(getInterruptSteerState(a).requests.at(-1).status, 'delivered');
    assert.equal(f.sessions[0].counts.start, 1);
    await f.host.switchSession(a.sessionFile);
    assert.equal(f.host.session, a);
  });
}

test('installer patches SDK and actual bundled TUI, validates before writes, and is idempotent', async () => {
  const changes = plan(root);
  assert.equal(changes.length, 3);
  for (const [i, change] of changes.slice(0, 2).entries()) {
    assert.equal(patch(change.after, i === 1), change.after);
    assert.match(change.after, /promptInForeground/);
    if (i === 1) {
      const composed = interruptPatch(change.after, true);
      assert.equal(interruptPatch(composed, true), composed, 'preserve the existing interrupt maintenance contract');
      assert.throws(() => interruptPatch('// unknown adapter header\n' + composed, true), /Unrecognized interrupt patch shape/);
    }
    assert.throws(() => patch(change.before.replace('async run()', 'async incompatibleRun()'), i === 1), /shape/);
  }
});

test('patched SDK and bundled CLI import successfully in an isolated copy (no global writes)', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-candidate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(dir, 'package.json'));
  // Merge nested and hoisted dependency search paths into a temporary link
  // farm. Never symlink a directory that an installer might later write into.
  const modules = join(dir, 'node_modules');
  await mkdir(modules);
  for (const base of requireSdk.resolve.paths('typebox')) {
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const source = join(base, entry.name), target = join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        await mkdir(target, { recursive: true });
        for (const name of await readdir(source)) {
          if (!existsSync(join(target, name))) await symlink(join(source, name), join(target, name));
        }
      } else if (!existsSync(target)) await symlink(source, target);
    }
  }
  if ((await readFile(join(dir, 'dist/modes/interactive/interactive-mode.js'), 'utf8')).includes('// pi-tui-session-background:1')) {
    // When testing after activation, restore only this isolated copy to the saved
    // pre-activation baseline. Never invoke rollback on the real installation.
    const receipt = JSON.parse(await readFile(join(root, 'dist/pi-tui-session-background-backup/last-apply.json'), 'utf8'));
    assert.ok(receipt.files.some((file) => file.path.endsWith('/interactive-mode.js')), 'use an unpatched SDK if the latest receipt only covers an incremental adapter update');
    for (const file of receipt.files) {
      const local = relative(root, file.path);
      assert.ok(!local.startsWith('..') && !local.startsWith('/'));
      const target = join(dir, local);
      if (file.backup) await cp(file.backup, target);
      else await rm(target);
    }
  }
  const changes = plan(dir);
  const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
  const install = (mode) => execFileSync(process.execPath, [installer, '--sdk', dir, mode, '--allow-external'], { encoding: 'utf8', stdio: 'pipe' });
  install('--apply');
  for (const c of plan(dir)) assert.equal(c.before, c.after);
  install('--apply');
  install('--check');
  const core = await import(pathToFileURL(join(dir, 'dist/modes/interactive/interactive-mode.js')));
  const bundled = await import(pathToFileURL(changes[1].path));
  assert.equal(typeof core.InteractiveMode.prototype.promptInForeground, 'function');
  assert.equal(typeof bundled.InteractiveMode.prototype.promptInForeground, 'function');
  for (const [name, UIClass, tuiMode] of [['SDK', core.InteractiveMode, 'regular'], ['bundle', bundled.InteractiveMode, 'fullscreen']]) {
    await t.test(`${name} real ${tuiMode} TUI: input loop accepts B while A tool is still running, then restores A`, async (child) => {
      const entered = gate(), release = gate(), bDone = gate();
      const f = await fixture(child, [{ name: 'hold', label: 'hold', description: 'test', parameters: Type.Object({}),
        async execute() {
          entered.resolve(); await release.promise;
          return { content: [{ type: 'text', text: 'A tool finished' }], details: {} };
        } }], UIClass, { terminal: new FakeTerminal(), tuiMode });
      f.faux.setResponses([fauxAssistantMessage([fauxToolCall('hold', {}, { id: 'a-hold' })], { stopReason: 'toolUse' }),
        complete('B independently finished'), complete('A independently finished')]);
      const a = f.host.session;
      let inputs = 0;
      const sentinel = new Error('test input loop complete');
      f.ui.getUserInput = async () => {
        if (inputs++ === 0) return 'A request';
        if (inputs === 2) return 'B request';
        bDone.resolve(); throw sentinel;
      };
      const oldOffline = process.env.PI_OFFLINE;
      process.env.PI_OFFLINE = '1';
      child.after(() => { if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline; });
      const running = f.ui.run();
      const runResult = assert.rejects(running, (error) => error === sentinel);
      await entered.promise;
      f.ui.editor.setText('A draft');
      await f.host.newSession();
      await bDone.promise; await runResult;
      assert.equal(a.isIdle, false);
      assert.equal(a.agent.signal.aborted, false);
      const b = f.host.session;
      assert.equal(b.getLastAssistantText(), 'B independently finished');
      await f.host.switchSession(a.sessionFile);
      assert.equal(f.host.session, a);
      assert.equal(f.ui.editor.getText(), 'A draft');
      assert.equal(f.ui.pendingTools.has('a-hold'), true);
      release.resolve(); await a.waitForIdle();
      assert.equal(a.getLastAssistantText(), 'A independently finished');
      assert.equal(f.ui.pendingTools.size, 0);
      assert.equal(f.sessions[0].counts.start, 1);
      f.fail = true;
      await f.ui.handleClearCommand(); // A recovered factory failure must not invoke process.exit().
      assert.equal(f.host.session, a);
    });
  }
  await writeFile(changes[1].path, changes[1].after + '\n// concurrent unrelated patch\n');
  assert.throws(() => install('--rollback'), /refusing to overwrite other patches/);
  assert.equal(await readFile(changes[0].path, 'utf8'), changes[0].after);
  await writeFile(changes[1].path, changes[1].after);
  install('--rollback');
  assert.equal(await readFile(changes[0].path, 'utf8'), changes[0].before);
  assert.equal(await readFile(changes[1].path, 'utf8'), changes[1].before);
  await assert.rejects(readFile(changes[2].path), { code: 'ENOENT' });
});

class FakeTerminal {
  columns = 100;
  rows = 32;
  kittyProtocolActive = false;
  output = '';
  start(onInput) { this.onInput = onInput; }
  stop() {}
  async drainInput() {}
  write(text) { this.output = (this.output + text).slice(-20000); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
