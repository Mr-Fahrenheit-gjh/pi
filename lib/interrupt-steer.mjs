import { AsyncLocalStorage } from 'node:async_hooks';

// AgentSession 1.3.0 adapter. Do not patch agent.steer: custom messages and
// internal budget controls deliberately keep their original queue semantics.
const installed = Symbol.for('pi.interrupt-steer.1');
// The Web source and vendored SDK copy may both be imported in one process.
// Share state so an idempotent second install still exposes the first one's work.
const registry = Symbol.for('pi.interrupt-steer.sessions.1');
const sessions = globalThis[registry] ??= new WeakMap();
const inputs = new AsyncLocalStorage();
const abortError = () => new DOMException('Interrupt submission cancelled by Stop or session disposal', 'AbortError');
const historyLimit = 50;
const errorText = (error) => String(error?.message ?? error).slice(0, 512);
const inputMetadata = (value) => ({ textLength: (value?.text ?? value?.prompt ?? '').length, imageCount: value?.images?.length ?? 0 });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** InterruptState owns one logical task across multiple physical SDK runs.
 * Request: { id, epoch, status, source, original, payload?, error?, ready }.
 * original/payload retain image objects; preprocessing is never replayed.
 * Terminal requests are journalled as non-model custom entries for recovery.
 */
function stateFor(session) {
  let state = sessions.get(session);
  if (!state) {
    state = { phase: 'idle', epoch: 0, sequence: 0, requests: [], pending: [],
      batch: [], task: null, boundary: null, suppressedSettled: null, disposed: false };
    for (const queue of [session.agent.followUpQueue, session.agent.steeringQueue]) {
      if (typeof queue?.drain !== 'function') throw new Error('Interrupt steer requires verified Pi AgentSession 1.3.0 queues');
    }
    sessions.set(session, state);
    let compactionController = session._compactionAbortController;
    Object.defineProperty(session, '_compactionAbortController', {
      configurable: true, enumerable: true,
      get: () => compactionController,
      set: (controller) => {
        compactionController = controller;
        if (controller && state.compactionOperation) {
          if (state.compactionOperation.cancelRequested) controller.abort();
        }
      },
    });
    const prompt = session.agent.prompt;
    session.agent.prompt = function (...args) {
      const context = inputs.getStore();
      if (context?.session === session && (context.ordinary || context.replacement)) {
        // This boundary is inside SDK _startRun's try/finally. Its onStarted
        // callback is not, so cancellation must never throw from that callback.
        assertCurrent(state, context.request ?? context);
      }
      return prompt.apply(this, args);
    };
    // The low-level loop can poll follow-ups even after a tool was aborted.
    // Hold the original queues in place, without reconstructing text-only copies.
    for (const queue of [session.agent.followUpQueue, session.agent.steeringQueue]) {
      const drain = queue.drain;
      queue.drain = function (...args) {
        if (state.phase === 'cancelling' || state.phase === 'submitting') return [];
        return drain.apply(this, args);
      };
    }
  }
  return state;
}

function releaseRequest(state, request) {
  if (request.status === 'preparing' || request.status === 'accepted') return;
  delete request.original;
  delete request.payload;
  const terminal = state.requests.filter((item) => item.status !== 'preparing' && item.status !== 'accepted');
  const retained = new Set(terminal.slice(-historyLimit));
  state.requests = state.requests.filter((item) => item.status === 'preparing' || item.status === 'accepted' || retained.has(item));
}

function record(session, request, status, error) {
  request.status = status;
  if (error) request.error = errorText(error);
  const recoverable = status === 'accepted' || status === 'failed' || status === 'cancelled';
  try {
    const entryId = session.sessionManager.appendCustomEntry('pi-interrupt', {
      id: request.id, status, source: request.source,
      ...(recoverable ? { original: request.original, payload: request.payload } : {}),
      ...(request.error ? { error: request.error } : {}),
    });
    if (recoverable) request.recoveryEntryId = entryId;
  } catch (error) {
    request.journalError = errorText(error);
    if (status === 'accepted') {
      request.status = 'failed';
      request.error = request.journalError;
      throw error;
    }
  } finally {
    releaseRequest(stateFor(session), request);
  }
}

export function hasQueuedInterruptSteer(session) {
  return Boolean(sessions.get(session)?.pending.length);
}

export function isInterruptSteerBusy(session) {
  const state = sessions.get(session);
  return Boolean(state && !state.disposed && (state.task || state.pending.length));
}

export async function waitForInterruptSteer(session) {
  const state = sessions.get(session);
  if (!state) return;
  while (state.pending.some((request) => request.status === 'preparing')) {
    await Promise.all(state.pending.map((request) => request.ready.promise));
  }
  if (state.task) await state.task;
  if (state.failure) throw state.failure;
}

// Host task limits belong to the logical child, not each replacement run.
export function setInterruptSteerGuard(session, guard) {
  stateFor(session).guard = guard;
}

export function queueInternalSteer(session, text, images) {
  session._steeringMessages.push(text);
  session._emitQueueUpdate();
  session.agent.steer({ role: 'user', content: [{ type: 'text', text }, ...(images ?? [])], timestamp: Date.now() });
}

export function getInterruptSteerState(session) {
  const state = sessions.get(session);
  if (!state) return { phase: 'idle', busy: false, requests: [] };
  return { phase: state.phase,
    busy: isInterruptSteerBusy(session),
    requests: state.requests.slice(-historyLimit).map(({ id, status, source, input, recoveryEntryId, error, journalError }) =>
      ({ id, status, source, input,
        ...(recoveryEntryId ? { recoveryEntryId } : {}),
        ...(error ? { error } : {}), ...(journalError ? { journalError } : {}) })) };
}

function assertCurrent(state, request) {
  if (state.disposed || request.epoch !== state.epoch) throw abortError();
}

function cancel(session, state, disposed = false) {
  const operation = state.compactionOperation;
  const startsCompaction = inputs.getStore()?.compactionStart === operation && operation?.initialAbortPending;
  if (startsCompaction) operation.initialAbortPending = false;
  if (operation && (disposed || !startsCompaction)) operation.cancelRequested = true;
  state.epoch += 1;
  state.disposed ||= disposed;
  state.phase = disposed ? 'disposed' : 'stopped';
  for (const request of state.requests) {
    if (request.status === 'preparing' || request.status === 'accepted') {
      record(session, request, 'cancelled');
      request.ready.resolve();
    }
  }
  state.pending = [];
}

// Same SDK abort primitives, deliberately not public abort(): task-recovery's
// explicit Stop marker must not turn a replacement into a permanently stopped task.
function requestReplacementAbort(session, state) {
  state.phase = 'cancelling';
  if (state.compactionOperation) state.compactionOperation.cancelRequested = true;
  if (session._isAgentRunActive) session._agentRunAbortRequested = true;
  session.abortRetry();
  session.abortCompaction();
  session.abortBranchSummary();
  if (session._isBeforeSettle) session._abortDuringBeforeSettle = true;
  session.agent.abort();
}

async function abortForReplacement(session, state) {
  const compaction = state.compactionTask;
  requestReplacementAbort(session, state);
  await session.waitForIdle();
  if (compaction) await compaction.catch(() => {});
  // isIdle becomes true before awaited extension agent_settled handlers finish.
  if (state.boundary) await state.boundary.promise;
}

async function validateModel(session) {
  const runtime = session._modelRuntime;
  if (!session.model) throw new Error('No model selected for interrupt submission');
  if (!runtime.hasConfiguredAuth(session.model.provider) &&
      (await runtime.checkAuth(session.model.provider)) === undefined) {
    throw new Error(`No authentication configured for "${session.model.provider}"`);
  }
}

function schedule(session, state, original) {
  if (state.task || state.disposed) return;
  const done = deferred();
  // Install the task before entering abort hooks; reentrant submissions join it.
  state.task = done.promise;
  state.failure = null;
  void (async () => {
    try {
      while (state.pending.length && !state.disposed) {
        const epoch = state.epoch;
        await abortForReplacement(session, state);
        // Include messages received during this same cancellation, in arrival
        // order, even when their asynchronous input handlers finish out of order.
        while (state.pending.some((request) => request.status === 'preparing')) {
          await Promise.all(state.pending.map((request) => request.ready.promise));
          if (state.epoch !== epoch) break;
        }
        if (state.epoch !== epoch || state.disposed) break;
        const batch = state.pending.splice(0).filter((request) => request.status === 'accepted');
        if (!batch.length) break;
        state.batch = batch;
        state.phase = 'submitting';
        try {
          await state.guard?.(batch.map(({ payload }) => payload));
          await validateModel(session);
          assertCurrent(state, batch[0]);
          await inputs.run({ session, replacement: true, request: batch[0] }, () =>
            original.start.call(session, { messageType: 'user', ...batch[0].payload }, () => {
              if (state.disposed || batch[0].epoch !== state.epoch) {
                session._agentRunAbortRequested = true;
                return;
              }
              state.phase = 'running';
              // An input can finish preprocessing between _prepareRun's final
              // await and this callback. Never strand it behind a live run.
              if (state.pending.some((request) => request.status === 'accepted')) requestReplacementAbort(session, state);
            }));
        } catch (error) {
          for (const request of batch) {
            if (request.status === 'accepted') record(session, request,
              state.epoch !== epoch || state.disposed ? 'cancelled' : 'failed', error);
          }
          if (state.epoch === epoch && !state.disposed) {
            state.failure = error;
            session._emit({ type: 'prompt_error', errorMessage: String(error?.message ?? error) });
          }
        } finally {
          state.batch = [];
        }
      }
    } catch (error) {
      state.failure = error;
      for (const request of state.pending.splice(0)) {
        if (request.status === 'accepted' || request.status === 'preparing') {
          record(session, request, 'failed', error);
          request.ready.resolve();
        }
      }
      if (!state.disposed) session._emit({ type: 'prompt_error', errorMessage: String(error?.message ?? error) });
    } finally {
      state.task = null;
      if (!state.disposed && state.phase !== 'stopped') state.phase = 'idle';
      // A cancelled/failed replacement may never have started a new physical run.
      // Deliver the withheld terminal event exactly once in that case.
      if (state.suppressedSettled && !session.isStreaming && !state.disposed) {
        original.emit.call(session, state.suppressedSettled);
      }
      state.suppressedSettled = null;
      if (!state.disposed) original.emit.call(session, { type: 'interrupt_steer_end', aborted: state.phase === 'stopped' });
      done.resolve();
      if (state.pending.length && !state.disposed) schedule(session, state, original);
    }
  })();
}

function enqueue(session, payload, original) {
  const state = stateFor(session);
  const context = inputs.getStore();
  const request = context?.session === session ? context.request : undefined;
  if (!request) throw new Error('Interrupt steer requires a user input admission');
  assertCurrent(state, request);
  request.payload = payload;
  record(session, request, 'accepted');
  if (!state.pending.includes(request)) state.pending.push(request);
  request.ready.resolve();
  // RPC consumers must observe accepted work before admission returns, including
  // idle/preflight windows where no physical agent_start has happened yet.
  original.emit.call(session, { type: 'interrupt_steer_start' });
  // The transaction task is still awaiting the replacement run. A later steer
  // must cancel that run now, not wait for its natural completion.
  if (state.task && state.phase === 'running') requestReplacementAbort(session, state);
  schedule(session, state, original);
}

function admit(session, originalInput, source, callback, original, deferUntilSettled = false) {
  const state = stateFor(session);
  if (state.disposed) return Promise.reject(abortError());
  const request = { id: `${session.sessionId}:interrupt:${Date.now()}:${++state.sequence}`,
    epoch: state.epoch, status: 'preparing', source, original: originalInput, input: inputMetadata(originalInput), ready: deferred() };
  state.requests.push(request);
  state.pending.push(request);
  const execute = () => inputs.run({ session, request }, async () => {
    try {
      assertCurrent(state, request);
      const result = await callback();
      if (request.status === 'preparing') request.status = 'handled';
      return result;
    } catch (error) {
      if (request.status === 'preparing') record(session, request,
        state.epoch === request.epoch && !state.disposed ? 'failed' : 'cancelled', error);
      throw error;
    } finally {
      request.ready.resolve();
      if (request.status !== 'accepted') state.pending = state.pending.filter((item) => item !== request);
      releaseRequest(state, request);
      if (!state.task && !state.pending.length && state.suppressedSettled && !state.disposed) {
        original.emit.call(session, state.suppressedSettled);
        state.suppressedSettled = null;
      }
    }
  });
  if (deferUntilSettled) {
    // SDK settled handlers are notification-only. Preserve its deferred-command
    // behavior without losing the admission epoch (Stop may intervene here).
    session._deferredSettledActions.push(async () => {
      try { await execute(); }
      catch (error) { if (!state.disposed) session._emit({ type: 'prompt_error', errorMessage: String(error?.message ?? error) }); }
    });
    return Promise.resolve();
  }
  return execute();
}

/** Idempotent prototype/instance adapter; supported only on verified SDK 1.3.0. */
export function installInterruptSteer(target) {
  const prototype = typeof target === 'function' ? target.prototype : target;
  if (prototype[installed]) return;
  for (const name of ['prompt', 'steer', '_queueSteer', '_startRun', '_prepareRun', '_emitAgentSettled', '_emit', 'abort', 'dispose']) {
    if (typeof prototype[name] !== 'function' && !['_emit'].includes(name)) {
      throw new Error(`Unsupported AgentSession interrupt adapter: missing ${name}`);
    }
  }
  const original = { prompt: prototype.prompt, steer: prototype.steer, start: prototype._startRun,
    prepare: prototype._prepareRun, settled: prototype._emitAgentSettled,
    emit: prototype._emit, abort: prototype.abort, dispose: prototype.dispose, compact: prototype.compact };
  // _emit is a prototype method on the supported SDK, not a class field.
  if (typeof original.emit !== 'function') throw new Error('Unsupported AgentSession event emitter');
  Object.defineProperty(prototype, installed, { value: true });
  prototype.prompt = function (text, options) {
    if (options?.streamingBehavior !== 'steer') {
      const state = stateFor(this);
      if (state.disposed) return Promise.reject(abortError());
      const parent = inputs.getStore();
      const nestedPhysical = parent?.session === this && Boolean(parent.request || parent.nestedPhysical || state.boundary);
      return inputs.run({ session: this, ordinary: true, epoch: state.epoch, nestedPhysical,
        followUp: options?.streamingBehavior === 'followUp' }, () => original.prompt.call(this, text, options));
    }
    return admit(this, { text, images: options?.images }, options?.source ?? 'interactive', async () => {
      if (!this._compactionAbortController) return original.prompt.call(this, text, options);
      // Native prompt rejects manual compaction before input handlers. Preserve
      // commands/handled input, then use the SDK's existing steer preprocessing.
      const expand = options?.expandPromptTemplates ?? true;
      if (expand && text.startsWith('/') && await this._tryExecuteExtensionCommand(text)) {
        options?.preflightResult?.('handled');
        return;
      }
      let disposition;
      if (expand) {
        disposition = await original.steer.call(this, text, options?.images, { source: options?.source ?? 'interactive' });
      } else {
        const processed = await this._runInputHandlers(text, options?.images, options?.source ?? 'interactive', 'steer');
        if (processed) await this._queueSteer(processed.text, processed.images);
        disposition = processed ? 'queued' : 'handled';
      }
      options?.preflightResult?.(disposition);
    }, original, this._isEmittingAgentSettled);
  };
  prototype.steer = function (text, images, options) {
    return admit(this, { text, images }, options?.source ?? 'interactive', () =>
      original.steer.call(this, text, images, options), original);
  };
  prototype.hasPendingInterruptSteer = function () { return isInterruptSteerBusy(this); };
  prototype._queueSteer = async function (text, images) {
    enqueue(this, { prompt: text, images }, original);
  };
  prototype._startRun = async function (trigger, onStarted) {
    const context = inputs.getStore();
    if (context?.session === this && context.ordinary) assertCurrent(stateFor(this), context);
    if (context?.session === this && context.request && !context.replacement && trigger.messageType === 'user') {
      enqueue(this, { prompt: trigger.prompt, images: trigger.images }, original);
      onStarted?.();
      return;
    }
    const state = sessions.get(this);
    if (context?.session === this && context.followUp && trigger.messageType === 'user' && state?.task &&
        (state.pending.length || state.phase === 'cancelling' || state.phase === 'submitting')) {
      await this._queueFollowUp(trigger.prompt, trigger.images);
      onStarted?.();
      return;
    }
    if (state && !state.task) state.failure = null;
    await original.start.call(this, trigger, onStarted);
    // Physical aborted runs are not terminal child tasks. Foreground/background
    // factories await this same logical promise; no dispose/receipt/budget reset.
    if (!context?.request && !context?.nestedPhysical) await waitForInterruptSteer(this);
  };
  prototype._prepareRun = async function (trigger) {
    const messages = await original.prepare.call(this, trigger);
    const context = inputs.getStore();
    if (context?.session === this && context.ordinary) assertCurrent(stateFor(this), context);
    if (context?.session === this && context.replacement) {
      const state = stateFor(this);
      assertCurrent(state, context.request);
      // Input received while before_agent_start/compaction prepared this run
      // still belongs to the same cancellation batch, not a throwaway new run.
      while (state.pending.some((request) => request.status === 'preparing')) {
        await Promise.all(state.pending.map((request) => request.ready.promise));
        assertCurrent(state, context.request);
      }
      state.batch.push(...state.pending.splice(0).filter((request) => request.status === 'accepted'));
      const extra = [];
      for (const request of state.batch.slice(1)) {
        const normalized = await this._normalizePromptImages(request.payload.images);
        const text = normalized.hints.length ? `${request.payload.prompt}\n\n${normalized.hints.join('\n')}` : request.payload.prompt;
        extra.push({ role: 'user', content: [{ type: 'text', text }, ...normalized.images], timestamp: Date.now() });
      }
      assertCurrent(state, context.request);
      const index = messages.findIndex((message) => message.role === 'user');
      messages.splice(index + 1, 0, ...extra);
    }
    return messages;
  };
  prototype._emitAgentSettled = async function (...args) {
    const state = sessions.get(this);
    if (!state) return original.settled.apply(this, args);
    const boundary = deferred();
    const previousBoundary = state.boundary;
    state.boundary = boundary;
    try { return await original.settled.apply(this, args); }
    finally {
      boundary.resolve();
      if (state.boundary === boundary) state.boundary = previousBoundary;
    }
  };
  prototype._emit = function (event) {
    const state = sessions.get(this);
    if (state && event.type === 'message_start' && event.message?.role === 'user') {
      const context = inputs.getStore();
      if (context?.session === this && context.replacement) {
        // message_start is emitted after SDK preparation and prior to model/tool work.
        const text = event.message.content.find((part) => part.type === 'text')?.text;
        const request = state.batch.find((item) => item.status === 'accepted' &&
          (text === item.payload.prompt || text?.startsWith(`${item.payload.prompt}\n\n`)));
        if (request) record(this, request, 'delivered');
      }
    }
    if (state && event.type === 'agent_settled') {
      if (state.pending.length || state.phase === 'cancelling' || state.phase === 'submitting') {
        state.suppressedSettled = event;
        return;
      }
      state.suppressedSettled = null;
    }
    return original.emit.call(this, event);
  };
  if (typeof original.compact === 'function') prototype.compact = function (...args) {
    const state = stateFor(this);
    const operation = { initialAbortPending: true, cancelRequested: false };
    state.compactionOperation = operation;
    const task = inputs.run({ session: this, compactionStart: operation }, () => original.compact.apply(this, args));
    state.compactionTask = task;
    void task.finally(() => {
      if (state.compactionTask === task) state.compactionTask = null;
      if (state.compactionOperation === operation) state.compactionOperation = null;
    }).catch(() => {});
    return task;
  };
  prototype.abort = async function (...args) {
    const state = sessions.get(this);
    const task = state?.task;
    if (state) cancel(this, state);
    await original.abort.apply(this, args);
    if (task) await task;
  };
  prototype.dispose = function (...args) {
    const state = sessions.get(this);
    if (state) cancel(this, state, true);
    return original.dispose.apply(this, args);
  };
}
