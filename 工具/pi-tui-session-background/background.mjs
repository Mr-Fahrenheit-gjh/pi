import { resolve, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';

function canonical(path) {
  const full = resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  try { return realpathSync(full); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return full; }
}

const installed = Symbol.for('pi.tui-session-background.v1');
const recoverableErrors = new WeakSet();
function recoverable(error) {
  const result = error instanceof Error ? error : new Error(String(error));
  recoverableErrors.add(result);
  return result;
}
const interactiveMethods = new Set(['select', 'confirm', 'input', 'editor', 'custom']);
const keyedMethods = new Set(['setStatus', 'setWidget']);
const stateMethods = new Set(['setWorkingMessage', 'setWorkingVisible', 'setWorkingIndicator',
  'setHiddenThinkingLabel', 'setFooter', 'setHeader', 'setTitle',
  'setEditorComponent', 'setToolsExpanded']);

async function withDeadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out closing a TUI session')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function snapshot(host) {
  return { session: host.session, services: host.services, diagnostics: host.diagnostics,
    modelFallbackMessage: host.modelFallbackMessage };
}

// This adapter is deliberately enabled by InteractiveMode only, never by SDK/Web hosts.
export function enableBackgroundSessions(ui, emitShutdown) {
  if (Object.hasOwn(ui, installed)) return ui[installed];
  const host = ui.runtimeHost;
  const records = new Map();
  const scopedContexts = new WeakMap();
  let closed = false;
  const current = () => record(host.session);
  const active = (r) => !closed && !r.closed && host.session === r.result.session && !r.parked;
  function record(session) {
    if (!records.has(session)) {
      const r = { result: snapshot(host), parked: false, waiters: new Set(), leaving: new Set(),
        state: new Map(), notices: [], tools: new Map(), inputs: new Set(), autocomplete: [],
        bound: false, draft: '', dialogs: 0, epoch: 0, cancellers: new Set() };
      records.set(session, r);
      r.unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start' || event.type === 'message_update') {
          if (event.message.role === 'assistant') r.stream = event.message;
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') r.stream = undefined;
        if (event.type === 'tool_execution_start') r.tools.set(event.toolCallId, { start: event });
        if (event.type === 'tool_execution_update') {
          const tool = r.tools.get(event.toolCallId);
          if (tool) tool.update = event;
        }
        if (event.type === 'tool_execution_end') r.tools.delete(event.toolCallId);
        if (['compaction_start', 'auto_retry_start'].includes(event.type)) r.activity = event;
        if (['compaction_end', 'auto_retry_end', 'turn_start'].includes(event.type)) r.activity = undefined;
        if (event.type === 'agent_settled') { r.stream = undefined; r.tools.clear(); r.activity = undefined; }
        if (event.type === 'compaction_end' && r.parked && r.compactionQueue?.length) {
          void flushParkedCompaction(r);
        }
      });
      const bind = session.bindExtensions.bind(session);
      session.bindExtensions = async (bindings) => {
        r.lastBindings = bindings;
        const epoch = r.epoch;
        const guarded = { ...bindings };
        if (bindings.uiContext) guarded.uiContext = guardUI(r, bindings.uiContext);
        if (bindings.commandContextActions) guarded.commandContextActions = Object.fromEntries(
          Object.entries(bindings.commandContextActions).map(([name, fn]) => [name, async (...args) => {
            while (!active(r) && !r.closed && epoch === r.epoch) {
              if (!(await foreground(r))) break;
            }
            if (!active(r) || epoch !== r.epoch) throw new Error('TUI session closed or reloaded');
            return fn(...args);
          }]));
        if (bindings.abortHandler) guarded.abortHandler = () => {
          if (epoch !== r.epoch || r.closed) return;
          return active(r) ? bindings.abortHandler() : void session.abort();
        };
        if (bindings.shutdownHandler) guarded.shutdownHandler = () => {
          if (epoch !== r.epoch || r.closed) return;
          if (active(r)) bindings.shutdownHandler();
          else notice(r, 'Background session requested shutdown; switch back to inspect it.');
        };
        if (bindings.onError) guarded.onError = (error) => {
          if (epoch !== r.epoch || r.closed) return;
          if (active(r)) bindings.onError(error);
          else notice(r, `${error.extensionPath}: ${error.error}`);
        };
        if (!r.bound) {
          r.bound = true;
          return bind(guarded);
        }
        // Reattach the existing runtime without replaying session_start/MCP discovery.
        const fields = { uiContext: '_extensionUIContext', mode: '_extensionMode',
          commandContextActions: '_extensionCommandContextActions', abortHandler: '_extensionAbortHandler',
          shutdownHandler: '_extensionShutdownHandler', onError: '_extensionErrorListener' };
        for (const [key, field] of Object.entries(fields)) {
          if (guarded[key] !== undefined) session[field] = guarded[key];
        }
        session._applyExtensionBindings(session.extensionRunner);
      };
      const reload = session.reload.bind(session);
      session.reload = async (options) => {
        r.reloading = true;
        try {
          return await reload({ ...options, beforeSessionStart: async () => {
            r.epoch++;
            for (const cancel of r.cancellers) cancel();
            for (const done of r.waiters) done(false);
            for (const input of r.inputs) input.unsubscribe?.();
            r.state.clear(); r.inputs.clear(); r.autocomplete = [];
            await session.bindExtensions({ ...r.lastBindings, uiContext: ui.createExtensionUIContext() });
            await options?.beforeSessionStart?.();
          } });
        } finally { r.reloading = false; }
      };
    }
    return records.get(session);
  }
  function notice(r, message) {
    r.notices.push(message);
    if (r.notices.length > 30) r.notices.shift();
  }
  function foreground(r, signal) {
    if (closed || r.closed || signal?.aborted) return Promise.resolve(false);
    if (active(r)) return Promise.resolve(true);
    return new Promise((resolveWait) => {
      const done = (value) => { r.waiters.delete(done); signal?.removeEventListener('abort', aborted); resolveWait(value); };
      const aborted = () => done(false);
      r.waiters.add(done);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  async function flushParkedCompaction(r) {
    // Session-owned queues must continue even while no TUI is attached to this slot.
    await Promise.resolve();
    const messages = r.compactionQueue.splice(0);
    for (let i = 0; i < messages.length; i++) {
      if (r.closed) break;
      const message = messages[i];
      try {
        await new Promise((accepted, rejected) => {
          r.result.session.prompt(message.text, {
            streamingBehavior: message.mode, preflightResult: accepted,
          }).then(accepted, rejected);
        });
      } catch (error) {
        r.compactionQueue.push(...messages.slice(i));
        notice(r, `Failed to send queued message: ${error.message}`);
        break;
      }
    }
  }
  function guardUI(r, target) {
    const epoch = r.epoch;
    const existing = scopedContexts.get(target);
    if (existing?.record === r && existing.epoch === epoch) return target;
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (epoch !== r.epoch || r.closed) {
          return interactiveMethods.has(key) ? Promise.resolve(undefined) : undefined;
        }
        if (interactiveMethods.has(key)) {
          return (async () => {
            while (!active(r) && !r.closed && epoch === r.epoch) {
              if (!(await foreground(r, args.at(-1)?.signal))) return undefined;
            }
            if (!active(r) || epoch !== r.epoch || args.at(-1)?.signal?.aborted) return undefined;
            r.dialogs++;
            let cancel, customDone;
            const cancelled = new Promise((done) => { cancel = () => {
              try { customDone?.(undefined); } catch { /* Continue closing other sessions. */ }
              controller.abort(); done(undefined);
            }; });
            const controller = new AbortController();
            r.cancellers.add(cancel);
            if (['select', 'confirm', 'input'].includes(key)) {
              args[2] = { ...args[2], signal: args[2]?.signal
                ? AbortSignal.any([args[2].signal, controller.signal]) : controller.signal };
            }
            if (key === 'custom') {
              const factory = args[0];
              args[0] = (...factoryArgs) => { customDone = factoryArgs[3]; return factory(...factoryArgs); };
            }
            try { return await Promise.race([value(...args), cancelled]); }
            finally { controller.abort(); r.cancellers.delete(cancel); r.dialogs--; }
          })();
        }
        if (key === 'onTerminalInput') {
          const input = { handler: args[0] };
          r.inputs.add(input);
          if (active(r)) input.unsubscribe = value(input.handler);
          return () => { input.unsubscribe?.(); r.inputs.delete(input); };
        }
        if (key === 'addAutocompleteProvider') r.autocomplete.push(args[0]);
        if (key === 'setEditorText') r.draft = args[0];
        if (key === 'pasteToEditor' && !active(r)) r.draft += args[0];
        if (keyedMethods.has(key) || stateMethods.has(key)) {
          r.state.set(keyedMethods.has(key) ? `${key}:${args[0]}` : key, { key, args });
        }
        if (active(r)) return value(...args);
        if (key === 'notify') notice(r, String(args[0]));
        if (key === 'getEditorText') return r.draft;
        // No background theme/editor/terminal mutation is allowed.
        if (key === 'setTheme') return { success: false, error: 'Session is in background' };
        return undefined;
      };
    } });
    scopedContexts.set(proxy, { record: r, epoch, target });
    return proxy;
  }
  function assertCanPark() {
    if (closed) throw recoverable('TUI runtime closed');
    if (ui.extensionDialogs?.length || current().dialogs) throw recoverable('Answer or cancel the current dialog before switching sessions');
    if (host.session.isBashRunning) throw recoverable('Wait for the interactive shell command to finish before switching sessions');
    if (current().reloading) throw recoverable('Wait for extension reload to finish before switching sessions');
  }
  function park() {
    assertCanPark();
    const r = current();
    r.result = snapshot(host);
    r.draft = ui.editor.getText();
    r.compactionQueue = ui.compactionQueuedMessages;
    r.parked = true;
    ui.unsubscribe?.(); ui.unsubscribe = undefined;
    ui.clearStatusIndicator();
    if (ui.autoCompactionEscapeHandler) ui.defaultEditor.onEscape = ui.autoCompactionEscapeHandler;
    if (ui.retryEscapeHandler) ui.defaultEditor.onEscape = ui.retryEscapeHandler;
    ui.autoCompactionEscapeHandler = undefined;
    ui.retryEscapeHandler = undefined;
    for (const input of r.inputs) { input.unsubscribe?.(); input.unsubscribe = undefined; }
    for (const done of r.leaving) done();
    r.leaving.clear();
    host.beforeSessionInvalidate?.(); // Detach UI only; do not invalidate session contexts.
  }
  async function restore() {
    const r = current();
    r.parked = false;
    const wasBound = r.bound;
    r.restoring = true;
    try { await host.finishSessionReplacement(); }
    finally { r.restoring = false; }
    // Rebinding awaits extension/UI setup. Take the history snapshot afterwards so
    // messages finalized during that await are not lost between history and live events.
    ui.renderCurrentSessionState?.();
    ui.editor.setText(r.draft);
    ui.compactionQueuedMessages = r.compactionQueue ?? [];
    // History contains finalized messages. Reconstruct only currently live UI events.
    if (r.stream) {
      void ui.handleEvent({ type: 'message_start', message: r.stream });
      void ui.handleEvent({ type: 'message_update', message: r.stream });
    }
    for (const tool of r.tools.values()) {
      void ui.handleEvent(tool.start);
      if (tool.update) void ui.handleEvent(tool.update);
    }
    if (!host.session.isIdle) void ui.handleEvent(r.activity ?? { type: 'turn_start' });
    const scoped = ui.createExtensionUIContext();
    const context = scopedContexts.get(scoped)?.target ?? scoped;
    if (wasBound) {
      for (const { key, args } of r.state.values()) context[key](...args);
      for (const input of r.inputs) input.unsubscribe = context.onTerminalInput(input.handler);
      for (const factory of r.autocomplete) context.addAutocompleteProvider(factory);
    }
    for (const message of r.notices.splice(0)) ui.showStatus(message);
    ui.updatePendingMessagesDisplay();
    ui.subscribeToAgent();
    if (r.compactionQueue?.length && !host.session.isCompacting) void flushParkedCompaction(r);
  }
  const originals = Object.fromEntries(['newSession', 'switchSession', 'teardownCurrent', 'createRuntime', 'dispose']
    .map((key) => [key, host[key].bind(host)]));
  let switching = false;
  let pendingPark = false;
  host.teardownCurrent = async (reason, target) => {
    if (switching && (reason === 'new' || reason === 'resume')) pendingPark = true;
    else {
      const r = current();
      r.closed = true;
      for (const cancel of r.cancellers) cancel();
      for (const done of r.waiters) done(false);
      await originals.teardownCurrent(reason, target);
      r.unsubscribe(); records.delete(r.result.session);
      for (const done of r.waiters) done(false);
    }
  };
  // The upstream factory still validates/open targets and enforces project trust.
  host.createRuntime = async (options) => {
    const file = options.sessionManager.getSessionFile();
    const saved = file && [...records.values()].find((r) =>
      r.parked && r.result.session.sessionFile && canonical(r.result.session.sessionFile) === canonical(file));
    if (saved && saved.result.services.cwd !== options.cwd) {
      throw new Error('Cannot change the working directory of a running session');
    }
    const result = saved ? saved.result : await originals.createRuntime(options);
    // Build/validate B while A is still attached. Commit only after the factory succeeds.
    if (pendingPark) {
      try { park(); pendingPark = false; }
      catch (error) {
        if (!saved) {
          try { await emitShutdown(result.session.extensionRunner, { type: 'session_shutdown', reason: 'quit' }); }
          finally { result.session.dispose(); }
        }
        throw error;
      }
    }
    return result;
  };
  for (const method of ['newSession', 'switchSession']) {
    host[method] = async (...args) => {
      if (closed) throw recoverable('TUI runtime closed');
      if (switching) throw recoverable('Session switch already in progress');
      assertCanPark();
      if (method === 'switchSession' && host.session.sessionFile &&
          canonical(args[0]) === canonical(host.session.sessionFile)) return { cancelled: false };
      if (method === 'switchSession') {
        const target = [...records.values()].find((r) => r.parked && r.result.session.sessionFile &&
          canonical(r.result.session.sessionFile) === canonical(args[0]));
        if (target) {
          if (args[1]?.cwdOverride && resolve(args[1].cwdOverride) !== resolve(target.result.services.cwd)) {
            throw recoverable('Cannot change the working directory of a running session');
          }
          // Empty or not-yet-finalized sessions may not have a JSONL header on disk yet.
          args[1] = { ...args[1], cwdOverride: target.result.services.cwd };
        }
      }
      const outgoing = snapshot(host);
      switching = true;
      // Upstream finishes rebinding; restore below adds the parked live state.
      const finish = host.finishSessionReplacement;
      host.finishSessionReplacement = async () => {};
      try {
        const result = await originals[method](...args);
        host.finishSessionReplacement = finish;
        if (!result.cancelled) {
          record(host.session);
          await restore();
          const options = method === 'newSession' ? args[0] : args[1];
          if (options?.withSession) await options.withSession(host.session.createReplacedSessionContext());
        }
        return result;
      } catch (error) {
        host.finishSessionReplacement = finish;
        if (host.session !== outgoing.session) {
          const failed = host.session;
          try {
            await failed.abort();
            await emitShutdown(failed.extensionRunner, { type: 'session_shutdown', reason: 'quit' });
          } catch (cleanupError) {
            notice(records.get(outgoing.session), `Failed to close replacement: ${cleanupError.message}`);
          } finally {
            failed.dispose();
            const r = records.get(failed); r?.unsubscribe(); records.delete(failed);
          }
        }
        const wasParked = records.get(outgoing.session)?.parked;
        host.apply(outgoing);
        if (wasParked) {
          ui.resetExtensionUI?.();
          await restore();
        }
        throw recoverable(error);
      } finally {
        host.finishSessionReplacement = finish;
        switching = false;
        pendingPark = false;
        if (!closed) {
          const r = current();
          if (active(r)) for (const done of r.waiters) done(true);
        }
      }
    };
  }
  host.dispose = async () => {
    if (closed) return;
    closed = true;
    const slots = [...records.values()];
    for (const r of slots) {
      r.closed = true;
      for (const cancel of r.cancellers) cancel();
      for (const done of r.waiters) done(false);
      for (const done of r.leaving) done();
      r.unsubscribe();
    }
    host.beforeSessionInvalidate?.();
    // Shutdown handlers may release a tool that abort() is waiting for. Start both,
    // close all slots independently, and bound non-cooperative third-party cleanup.
    const outcomes = await Promise.allSettled(slots.map(async (r) => {
      const session = r.result.session;
      try {
        const abort = Promise.resolve().then(() => session.abort());
        const shutdown = Promise.resolve().then(() => emitShutdown(session.extensionRunner,
          { type: 'session_shutdown', reason: 'quit' }));
        await withDeadline(Promise.all([abort, shutdown]), 2000);
      } finally { session.dispose(); }
    }));
    records.clear();
    const errors = outcomes.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed to close TUI sessions');
  };
  record(host.session);
  Object.defineProperty(ui, installed, { value: { records, current, active, guardUI, notice } });
  return ui[installed];
}

export function installTuiBackground(InteractiveMode, emitShutdown) {
  if (Object.hasOwn(InteractiveMode.prototype, installed)) return;
  Object.defineProperty(InteractiveMode.prototype, installed, { value: true });
  const createContext = InteractiveMode.prototype.createExtensionUIContext;
  InteractiveMode.prototype.createExtensionUIContext = function (...args) {
    const manager = enableBackgroundSessions(this, emitShutdown);
    return manager.guardUI(manager.current(), createContext.apply(this, args));
  };
  const shortcuts = InteractiveMode.prototype.setupExtensionShortcuts;
  if (shortcuts) InteractiveMode.prototype.setupExtensionShortcuts = function (runner) {
    const manager = enableBackgroundSessions(this, emitShutdown);
    const r = manager.current();
    const get = runner.getShortcuts;
    runner.getShortcuts = (...args) => new Map([...get.apply(runner, args)].map(([key, shortcut]) => [key, {
      ...shortcut, handler: async () => {
        try { return await shortcut.handler(runner.createContext()); }
        catch (error) {
          const message = `Shortcut handler error: ${error.message ?? error}`;
          if (manager.active(r)) this.showError(message);
          else manager.notice(r, message);
        }
      },
    }]));
    try { return shortcuts.call(this, runner); }
    finally { runner.getShortcuts = get; }
  };
  const fatal = InteractiveMode.prototype.handleFatalRuntimeError;
  InteractiveMode.prototype.handleFatalRuntimeError = async function (prefix, error) {
    if (recoverableErrors.has(error)) {
      this.showError(`${prefix}: ${error.message}`);
      return { cancelled: true };
    }
    return fatal.call(this, prefix, error);
  };
  const bind = InteractiveMode.prototype.bindCurrentSessionExtensions;
  InteractiveMode.prototype.bindCurrentSessionExtensions = async function (...args) {
    enableBackgroundSessions(this, emitShutdown).current();
    return bind.apply(this, args);
  };
  const subscribe = InteractiveMode.prototype.subscribeToAgent;
  InteractiveMode.prototype.subscribeToAgent = function (...args) {
    const manager = enableBackgroundSessions(this, emitShutdown);
    const r = manager.current();
    if (!r.restoring) return subscribe.apply(this, args);
  };
  const init = InteractiveMode.prototype.init;
  InteractiveMode.prototype.init = async function (...args) {
    enableBackgroundSessions(this, emitShutdown);
    return init.apply(this, args);
  };
  // CLI initial messages are one ordered batch owned by the startup session,
  // even if the user switches away before the first message completes.
  InteractiveMode.prototype.runInitialPrompts = async function (message, images, messages) {
    const manager = enableBackgroundSessions(this, emitShutdown);
    const r = manager.current();
    let left;
    const moved = new Promise((done) => { left = done; r.leaving.add(left); });
    const batch = (async () => {
      const prompts = [...(message ? [[message, { images }]] : []), ...(messages ?? []).map((text) => [text])];
      for (const args of prompts) {
        if (r.closed) break;
        try { await r.result.session.prompt(...args); }
        catch (error) {
          if (manager.active(r)) this.showError(error.message ?? String(error));
          else r.notices.push(`Background prompt failed: ${error.message ?? error}`);
        }
      }
    })().finally(() => r.leaving.delete(left));
    await Promise.race([batch, moved]);
  };
  // A running old prompt must not keep the single interactive input loop occupied.
  InteractiveMode.prototype.promptInForeground = async function (...args) {
    const manager = enableBackgroundSessions(this, emitShutdown);
    const r = manager.current();
    let left;
    const moved = new Promise((resolveMoved) => { left = resolveMoved; r.leaving.add(left); });
    const prompt = r.result.session.prompt(...args).catch((error) => {
      if (manager.active(r)) throw error;
      r.notices.push(`Background prompt failed: ${error.message ?? error}`);
    }).finally(() => r.leaving.delete(left));
    await Promise.race([prompt, moved]);
  };
}
