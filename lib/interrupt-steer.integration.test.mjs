import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import * as coreSdk from '@earendil-works/pi-coding-agent';
// Set this to the patched bundled chunk to exercise the actual CLI SDK shape too.
const { AgentSession, createAgentSession, ModelRuntime, SessionManager, SettingsManager } =
  process.env.PI_INTERRUPT_TEST_BUNDLE ? await import(process.env.PI_INTERRUPT_TEST_BUNDLE) : coreSdk;
import { getInterruptSteerState, installInterruptSteer, waitForInterruptSteer } from './interrupt-steer.mjs';

installInterruptSteer(AgentSession);
const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const within = (promise) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Logical interrupt did not settle')), 1500);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); });
});
const text = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=' };

async function fixture(t, customTools = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-interrupt-test-'));
  const faux = fauxProvider({ models: [{ id: 'interrupt-test' }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
    model: faux.getModel('interrupt-test'), tools: customTools.map((tool) => tool.name), customTools,
    sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, images: { autoResize: false } }) });
  await session.bindExtensions({});
  if (customTools.length) session.setActiveToolsByName(customTools.map((tool) => tool.name));
  const events = [];
  session.subscribe((event) => events.push(event));
  t.after(async () => { session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, faux, events };
}

function blockingResponse(entered, unwinding = gate()) {
  return async (_context, options) => {
    entered.resolve();
    if (!options.signal.aborted) await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    await unwinding.promise;
    return fauxAssistantMessage([fauxText('cancelled')]);
  };
}

// Every test is transport/tool-fake only: no configured provider or model request.
test('tool abort -> full settled -> batch user messages/images -> original follow-up; one logical child completion', { timeout: 10000 }, async (t) => {
  const toolEntered = gate(), toolUnwind = gate(), settledEntered = gate(), settledExit = gate();
  const { session, faux, events } = await fixture(t, [{ name: 'hold', label: 'hold', description: 'fake cancellable tool', parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      toolEntered.resolve();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await toolUnwind.promise;
      return { content: [{ type: 'text', text: 'tool unwound' }], details: {} };
    } }]);
  const extensionEmit = session._extensionRunner.emit.bind(session._extensionRunner);
  let physicalSettles = 0;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && ++physicalSettles === 1) { settledEntered.resolve(); await settledExit.promise; }
    return extensionEmit(event);
  };
  const contexts = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' }),
    (context) => { contexts.push(context); return fauxAssistantMessage([fauxText('batch answered')]); },
    (context) => { contexts.push(context); return fauxAssistantMessage([fauxText('follow-up answered')]); },
  ]);
  let logicalFinished = false;
  const logical = session.prompt('original child task').then(() => { logicalFinished = true; });
  await toolEntered.promise;
  assert.equal(await session.steer('A', [image]), 'queued');
  await session.prompt('B', { streamingBehavior: 'steer', source: 'rpc' });
  await session.followUp('F', [image]);
  toolUnwind.resolve();
  await settledEntered.promise;
  assert.equal(logicalFinished, false);
  assert.equal(faux.state.callCount, 1);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 0);
  settledExit.resolve();
  await logical;
  assert.equal(contexts.length, 2);
  const users = contexts[0].messages.filter((message) => message.role === 'user');
  assert.deepEqual(users.slice(-2).map(text), ['A', 'B']);
  assert.equal(users.at(-2).content.some((part) => part.type === 'image'), true);
  assert.equal(text(contexts[1].messages.filter((message) => message.role === 'user').at(-1)), 'F');
  assert.equal(contexts[1].messages.filter((message) => message.role === 'user').at(-1).content.some((part) => part.type === 'image'), true);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
  assert.equal(physicalSettles, 2);
  assert.deepEqual(getInterruptSteerState(session).requests.map((request) => request.status), ['delivered', 'delivered']);
  assert.equal(logicalFinished, true);
});

test('streaming prompt and extension sendUserMessage cancel the live response, without overlap', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const entered = gate(), unwind = gate();
  faux.setResponses([blockingResponse(entered, unwind), fauxAssistantMessage([fauxText('replacement')])]);
  const first = session.prompt('old');
  await entered.promise;
  await session.sendUserMessage([{ type: 'text', text: 'extension steer' }, image], { deliverAs: 'steer' });
  assert.equal(session.agent.signal.aborted, true);
  assert.equal(faux.state.callCount, 1);
  unwind.resolve();
  await first;
  const user = events.filter((event) => event.type === 'message_start' && event.message.role === 'user').at(-1).message;
  assert.equal(text(user), 'extension steer');
  assert.equal(user.content.some((part) => part.type === 'image'), true);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
});

test('already idle steer starts a run; concurrently prepared inputs retain admission order', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const a = gate();
  const original = session._runInputHandlers.bind(session);
  const processed = [];
  session._runInputHandlers = async (value, ...args) => {
    if (value === 'A') await a.promise;
    processed.push(value);
    return original(`expanded ${value}`, ...args);
  };
  faux.setResponses([fauxAssistantMessage([fauxText('done')])]);
  const first = session.steer('A');
  await session.prompt('B', { streamingBehavior: 'steer' });
  await tick();
  assert.equal(faux.state.callCount, 0);
  a.resolve();
  await first;
  // waitForIdle is the physical SDK primitive; the transaction may be between runs.
  await waitForInterruptSteer(session);
  assert.deepEqual(events.filter((event) => event.type === 'message_start' && event.message.role === 'user').map((event) => text(event.message)), ['expanded A', 'expanded B']);
  assert.deepEqual(processed.sort(), ['A', 'B']);
  assert.equal(faux.state.callCount, 1);
});

test('explicit Stop during cancellation prevents automatic resubmit and journals complete payload', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const entered = gate(), unwind = gate();
  faux.setResponses([blockingResponse(entered, unwind)]);
  const first = session.prompt('old');
  await entered.promise;
  await session.steer('not sent', [image]);
  const stop = session.abort();
  unwind.resolve();
  await Promise.all([first, stop]);
  assert.equal(faux.state.callCount, 1);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
  const request = getInterruptSteerState(session).requests.at(-1);
  assert.equal(request.status, 'cancelled');
  assert.equal(request.input.imageCount, 1);
  assert.equal('payload' in request, false);
  const journal = session.sessionManager.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === 'pi-interrupt');
  assert.equal(journal.at(-1).data.status, 'cancelled');
  assert.deepEqual(journal.at(-1).data.payload.images, [image]);
});

test('Stop during asynchronous preprocessing rejects the stale input without restarting', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const ready = gate();
  session._runInputHandlers = async (value, images) => { await ready.promise; return { text: value, images }; };
  const submission = session.steer('late');
  await session.abort();
  ready.resolve();
  await assert.rejects(submission, { name: 'AbortError' });
  assert.equal(faux.state.callCount, 0);
});

test('dispose during an uncooperative tool/response unwind never resurrects the session', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const entered = gate(), unwind = gate();
  faux.setResponses([blockingResponse(entered, unwind)]);
  const first = session.prompt('old');
  await entered.promise;
  await session.steer('pending');
  session.dispose();
  unwind.resolve();
  await first;
  assert.equal(faux.state.callCount, 1);
  assert.equal(getInterruptSteerState(session).phase, 'disposed');
  await assert.rejects(session.steer('after disposal'), { name: 'AbortError' });
});

test('follow_up and ordinary custom steering remain queues, not hard interrupts', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const entered = gate(), finish = gate();
  faux.setResponses([
    async () => { entered.resolve(); await finish.promise; return fauxAssistantMessage([fauxText('first')]); },
    fauxAssistantMessage([fauxText('custom')]), fauxAssistantMessage([fauxText('follow')]),
  ]);
  const first = session.prompt('old');
  await entered.promise;
  await session.prompt('follow', { streamingBehavior: 'followUp', images: [image] });
  await session.sendCustomMessage({ customType: 'notification', content: 'custom', display: false });
  assert.equal(session.agent.signal.aborted, false);
  finish.resolve();
  await first;
  assert.equal(getInterruptSteerState(session).requests.length, 0);
  assert.equal(session.messages.some((message) => message.role === 'custom' && message.customType === 'notification'), true);
});

test('handled input and slash commands do not cancel; direct steer preserves command rejection', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const entered = gate(), finish = gate();
  faux.setResponses([async () => { entered.resolve(); await finish.promise; return fauxAssistantMessage([fauxText('done')]); }]);
  const first = session.prompt('old');
  await entered.promise;
  const input = session._runInputHandlers.bind(session);
  session._runInputHandlers = async (value, ...args) => value === 'handled' ? undefined : input(value, ...args);
  assert.equal(await session.steer('handled'), 'handled');
  session._tryExecuteExtensionCommand = async (value) => value === '/local';
  await session.prompt('/local', { streamingBehavior: 'steer' });
  session._throwIfExtensionCommand = () => { throw new Error('cannot queue command'); };
  await assert.rejects(session.steer('/local'), /cannot queue command/);
  assert.equal(session.agent.signal.aborted, false);
  finish.resolve();
  await first;
});

test('replacement preparation errors keep failed attachments and emit a recoverable prompt_error', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const prepare = session._prepareRun.bind(session);
  session._prepareRun = async (trigger) => {
    if (trigger.prompt === 'failure') throw new Error('fake preparation failed');
    return prepare(trigger);
  };
  await session.steer('failure', [image], { source: 'rpc' });
  await assert.rejects(waitForInterruptSteer(session), /fake preparation failed/);
  assert.equal(faux.state.callCount, 0);
  const request = getInterruptSteerState(session).requests.at(-1);
  assert.equal(request.status, 'failed');
  assert.equal(request.source, 'rpc');
  assert.equal(request.input.imageCount, 1);
  const recovery = session.sessionManager.getEntries().find((entry) => entry.id === request.recoveryEntryId);
  assert.deepEqual(recovery.data.payload.images, [image]);
  assert.equal(events.some((event) => event.type === 'prompt_error' && event.errorMessage.includes('fake preparation failed')), true);
});

test('steer from awaited extension settled callback does not deadlock or confuse agent_end with settled', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const emit = session._extensionRunner.emit.bind(session._extensionRunner);
  let once = false;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && !once) { once = true; await session.steer('from settled'); }
    return emit(event);
  };
  faux.setResponses([fauxAssistantMessage([fauxText('first')]), fauxAssistantMessage([fauxText('next')])]);
  await session.prompt('old');
  assert.equal(faux.state.callCount, 2);
  assert.equal(events.filter((event) => event.type === 'agent_end').length, 2);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
});

test('a steer arriving after the replacement starts immediately aborts that replacement', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const firstEntered = gate(), firstExit = gate(), nextEntered = gate(), nextExit = gate();
  faux.setResponses([blockingResponse(firstEntered, firstExit), blockingResponse(nextEntered, nextExit), fauxAssistantMessage([fauxText('final')])]);
  const logical = session.prompt('old');
  await firstEntered.promise;
  await session.steer('A');
  firstExit.resolve();
  await nextEntered.promise;
  await session.steer('B');
  assert.equal(session.agent.signal.aborted, true);
  assert.equal(faux.state.callCount, 2);
  nextExit.resolve();
  await logical;
  assert.deepEqual(events.filter((event) => event.type === 'message_start' && event.message.role === 'user').map((event) => text(event.message)), ['old', 'A', 'B']);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
});

test('Stop cancels a prompt deferred from a settled callback before commands or messages execute', { timeout: 10000 }, async (t) => {
  const { session, faux, events } = await fixture(t);
  const emit = session._extensionRunner.emit.bind(session._extensionRunner);
  let once = false;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && !once) {
      once = true;
      await session.prompt('must not revive', { streamingBehavior: 'steer' });
      // Calling SDK abort in an awaited settled handler is itself unsafe;
      // simulate the external Stop epoch without blocking this callback.
      void session.abort();
    }
    return emit(event);
  };
  faux.setResponses([fauxAssistantMessage([fauxText('first')])]);
  await session.prompt('old');
  assert.equal(faux.state.callCount, 1);
  assert.equal(events.filter((event) => event.type === 'agent_settled').length, 1);
  assert.equal(getInterruptSteerState(session).requests.at(-1).status, 'cancelled');
});

test('different source/vendored engine imports observe the same state without double installing', { timeout: 10000 }, async (t) => {
  const other = await import('./interrupt-steer.mjs?second-module');
  const { session, faux } = await fixture(t);
  other.installInterruptSteer(AgentSession);
  faux.setResponses([fauxAssistantMessage([fauxText('done')])]);
  await session.steer('one');
  await waitForInterruptSteer(session);
  assert.deepEqual(other.getInterruptSteerState(session), getInterruptSteerState(session));
  assert.equal(faux.state.callCount, 1);
});

const runnerFile = join(process.env.PI_SUBAGENTS_PACKAGE_ROOT ?? join(homedir(), '.pi/agent/npm/node_modules/pi-subagents'), 'src/runs/background/run-child-session.js');
test('actual npm background runner keeps the child alive through replacement, consumes steer and finalizes once',
  { timeout: 10000, skip: !existsSync(runnerFile) && 'pi-subagents not installed' }, async (t) => {
  const { createJiti } = await import('jiti');
  // Use the candidate's independent SDK peers, just like the upstream detached
  // runner's alias bootstrap; do not repair global npm links during tests.
  const alias = Object.fromEntries(['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui'].map((name) =>
    [`@earendil-works/${name}`, new URL(`../node_modules/@earendil-works/${name}/dist/index.js`, import.meta.url).pathname]));
  const { runChildSession } = await createJiti(import.meta.url, { alias }).import(runnerFile);
  const { session, faux } = await fixture(t);
  const firstEntered = gate(), firstExit = gate(), nextEntered = gate(), nextExit = gate();
  faux.setResponses([blockingResponse(firstEntered, firstExit), async () => {
    nextEntered.resolve(); await nextExit.promise; return fauxAssistantMessage([fauxText('child final result')]);
  }]);
  let steerControl, stopControl, disposed = 0, finished = false;
  const outcomes = [];
  const created = {
    subscribe: (listener) => session.subscribe(listener), prompt: (value) => session.prompt(value),
    steer: (value) => session.steer(value), followUp: (value) => session.followUp(value), abort: () => session.abort(),
    // Exactly the factory adapter prepared in apply-subagents.mjs.
    hasQueuedMessages: () => session.hasPendingInterruptSteer?.() === true || session.agent.hasQueuedMessages(),
    get messages() { return session.messages; },
    dispose: async () => { disposed += 1; session.dispose(); },
  };
  const child = runChildSession({
    factory: { create: async () => created }, prompt: 'child task',
    launch: { session: { hooks: [] }, config: { agent: 'fixture' }, toolPlan: {}, capture: { finalDrainHeld: () => false } },
    writeOutputLine() {}, registerSteer: (control) => { steerControl = control; },
    registerStop: (control) => { stopControl = control; },
    onSteerOutcome: (request, outcome) => outcomes.push({ request, outcome }),
  }).then((result) => { finished = true; return result; });
  await firstEntered.promise;
  assert.equal(typeof stopControl, 'function');
  const receipt = await steerControl({ id: 'request-1', message: 'change the child direction', mode: 'steer' });
  assert.equal(receipt.state, 'queued');
  firstExit.resolve();
  await nextEntered.promise;
  assert.equal(finished, false);
  assert.equal(disposed, 0);
  nextExit.resolve();
  const result = await child;
  assert.equal(result.exitCode, 0);
  assert.match(result.finalOutput, /child final result/);
  assert.equal(disposed, 1);
  assert.equal(outcomes.filter(({ outcome }) => outcome.state === 'delivered').length, 1);
});

test('Web explicit steer reports pending state and one completion only after the transaction is over', { timeout: 10000 }, async (t) => {
  const { createJiti } = await import('jiti');
  const { AgentSessionWrapper } = await createJiti(import.meta.url).import('./rpc-manager.ts');
  const { session, faux } = await fixture(t);
  let completed = 0;
  const wrapper = new AgentSessionWrapper(session, { onAgentRunComplete: () => { completed += 1; } });
  wrapper.start();
  t.after(() => wrapper.destroy());
  faux.setResponses([fauxAssistantMessage([fauxText('done')])]);
  await wrapper.send({ type: 'steer', message: 'idle RPC steer', images: [image] });
  await waitForInterruptSteer(session);
  const state = await wrapper.send({ type: 'get_state' });
  assert.equal(state.interruptSteer.busy, false);
  assert.equal(state.interruptSteer.requests.at(-1).status, 'delivered');
  assert.equal(completed, 1);
});

for (const type of ['prompt', 'steer']) test(`Web ${type} steer redoes MCP preparation after withdrawing the old wait`, { timeout: 10000 }, async (t) => {
  const { createJiti } = await import('jiti');
  const { AgentSessionWrapper } = await createJiti(import.meta.url).import('./rpc-manager.ts');
  const { session, faux } = await fixture(t);
  const entered = gate();
  let preparations = 0;
  const mcpHost = {
    async prepareForPrompt(signal) {
      if (++preparations !== 1) return;
      entered.resolve();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    }, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(session, { mcpHost });
  wrapper.start();
  t.after(() => wrapper.destroy());
  faux.setResponses([fauxAssistantMessage([fauxText('replacement')])]);
  const old = wrapper.send({ type: 'prompt', message: 'never sent' }).then(() => null, (error) => error);
  await entered.promise;
  await wrapper.send({ type, message: 'new input', streamingBehavior: 'steer', images: [image] });
  await waitForInterruptSteer(session);
  assert.equal(preparations, 2);
  assert.match((await old).message, /stopped|Stop/);
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(session.messages.filter((message) => message.role === 'user').map(text), ['new input']);
});

test('Web Stop cancels both an SDK input preflight and another prompt waiting for admission', { timeout: 10000 }, async (t) => {
  const { createJiti } = await import('jiti');
  const { AgentSessionWrapper } = await createJiti(import.meta.url).import('./rpc-manager.ts');
  const { session, faux } = await fixture(t);
  const entered = gate(), finish = gate();
  const input = session._runInputHandlers.bind(session);
  session._runInputHandlers = async (...args) => { entered.resolve(); await finish.promise; return input(...args); };
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  t.after(() => wrapper.destroy());
  const first = wrapper.send({ type: 'prompt', message: 'first' }).then(() => null, (error) => error);
  await entered.promise;
  const second = wrapper.send({ type: 'prompt', message: 'second', streamingBehavior: 'steer' }).then(() => null, (error) => error);
  await tick();
  await wrapper.send({ type: 'abort' });
  finish.resolve();
  assert.match((await first).message, /cancelled/);
  assert.match((await second).message, /cancelled/);
  assert.equal(faux.state.callCount, 0);
});

test('a failed admission journal does not abort the old run or lose the rejected payload', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const entered = gate(), finish = gate();
  faux.setResponses([async () => { entered.resolve(); await finish.promise; return fauxAssistantMessage([fauxText('old done')]); }]);
  const run = session.prompt('old');
  await entered.promise;
  const append = session.sessionManager.appendCustomEntry.bind(session.sessionManager);
  session.sessionManager.appendCustomEntry = (type, data) => {
    if (type === 'pi-interrupt') throw new Error('fake disk full');
    return append(type, data);
  };
  await assert.rejects(session.steer('rejected', [image]), /fake disk full/);
  assert.equal(session.agent.signal.aborted, false);
  const request = getInterruptSteerState(session).requests.at(-1);
  assert.equal(request.status, 'failed');
  assert.equal(request.input.imageCount, 1);
  assert.equal('payload' in request, false);
  assert.equal(request.recoveryEntryId, undefined);
  finish.resolve();
  await run;
});

test('a steer accepted during final attachment preparation cannot strand behind the newly starting run', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const extraEntered = gate(), extraExit = gate();
  const normalize = session._normalizePromptImages.bind(session);
  let normalized = 0;
  session._normalizePromptImages = async (images) => {
    if (++normalized === 2) { extraEntered.resolve(); await extraExit.promise; }
    return normalize(images);
  };
  faux.setResponses([
    async (_context, options) => {
      if (!options.signal.aborted && !session.messages.some((message) => message.role === 'user' && text(message) === 'C')) {
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      }
      return fauxAssistantMessage([fauxText('first')]);
    },
    fauxAssistantMessage([fauxText('final')]),
  ]);
  await Promise.all([session.steer('A', [image]), session.steer('B', [image])]);
  await extraEntered.promise;
  await session.steer('C');
  extraExit.resolve();
  await waitForInterruptSteer(session);
  assert.deepEqual(session.messages.filter((message) => message.role === 'user').map(text), ['A', 'B', 'C']);
  assert.deepEqual(getInterruptSteerState(session).requests.map((request) => request.status), ['delivered', 'delivered', 'delivered']);
});

test('a follow-up deferred from settled cannot await its ancestor interrupt transaction', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const emit = session._extensionRunner.emit.bind(session._extensionRunner);
  let once = false;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && !once) {
      once = true;
      await session.sendUserMessage('deferred follow-up', { deliverAs: 'followUp' });
    }
    return emit(event);
  };
  faux.setResponses([fauxAssistantMessage([fauxText('first')]), fauxAssistantMessage([fauxText('followed')])]);
  await session.steer('start');
  await within(waitForInterruptSteer(session));
  assert.equal(faux.state.callCount, 2);
  assert.equal(session.isIdle, true);
  assert.equal(getInterruptSteerState(session).busy, false);
});

for (const action of ['abort', 'dispose']) test(`${action} after preparation leaves no active SDK run or model request`, { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const prepare = session._prepareRun.bind(session);
  let stop;
  session._prepareRun = async (...args) => {
    const messages = await prepare(...args);
    queueMicrotask(() => { stop = session[action](); });
    return messages;
  };
  await session.steer('cancel before model');
  await within(waitForInterruptSteer(session));
  await within(stop);
  assert.equal(faux.state.callCount, 0);
  assert.equal(session.isStreaming, false);
  assert.equal(session.isIdle, true);
  assert.equal(getInterruptSteerState(session).busy, false);
});

for (const expand of [true, false]) test(`prompt-steer interrupts full manual compaction lifecycle (expand=${expand})`, { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage([fauxText('history')]), fauxAssistantMessage([fauxText('replacement')])]);
  await session.prompt('history to compact');
  const entered = gate(), failedEntered = gate(), failedExit = gate();
  t.after(() => failedExit.resolve());
  const compactFailed = session._emitSessionCompactFailed.bind(session);
  session._emitSessionCompactFailed = async (...args) => {
    failedEntered.resolve();
    await failedExit.promise;
    return compactFailed(...args);
  };
  const compactionSettings = session.settingsManager.getCompactionSettings.bind(session.settingsManager);
  session.settingsManager.getCompactionSettings = (model) => ({ ...compactionSettings(model), keepRecentTokens: 1 });
  session._runDefaultCompaction = async (_preparation, _model, _instructions, signal) => {
    entered.resolve(signal);
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Compaction cancelled');
  };
  const compaction = session.compact().then(() => null, (error) => error);
  const signal = await within(entered.promise);
  const input = session._runInputHandlers.bind(session);
  session._runInputHandlers = async (value, ...args) => value === 'handled' ? undefined : input(value, ...args);
  session._tryExecuteExtensionCommand = async (value) => value === '/local';
  await session.prompt('/local', { streamingBehavior: 'steer' });
  await session.prompt('handled', { streamingBehavior: 'steer' });
  assert.equal(signal.aborted, false);
  const message = expand ? 'interrupt' : '/literal';
  await session.prompt(message, { streamingBehavior: 'steer', expandPromptTemplates: expand, images: [image] });
  await within(failedEntered.promise);
  assert.equal(faux.state.callCount, 1, 'No replacement before awaited compaction-failure handlers finish');
  failedExit.resolve();
  await within(waitForInterruptSteer(session));
  assert.match((await compaction).message, /cancelled/);
  assert.equal(signal.aborted, true);
  assert.equal(text(session.messages.filter((message) => message.role === 'user').at(-1)), message);
  assert.equal(faux.state.callCount, 2);
  assert.equal(session.isIdle, true);
});

test('a settled follow-up during cancellation stays behind pending user steering', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const entered = gate(), unwind = gate();
  const emit = session._extensionRunner.emit.bind(session._extensionRunner);
  let once = false;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && !once) {
      once = true;
      await session.sendUserMessage('F', { deliverAs: 'followUp' });
    }
    return emit(event);
  };
  faux.setResponses([blockingResponse(entered, unwind), fauxAssistantMessage([fauxText('A answered')]), fauxAssistantMessage([fauxText('F answered')])]);
  const logical = session.prompt('old');
  await entered.promise;
  await session.steer('A');
  unwind.resolve();
  await within(logical);
  assert.deepEqual(session.messages.filter((message) => message.role === 'user').map(text), ['old', 'A', 'F']);
  assert.equal(faux.state.callCount, 3);
  assert.equal(getInterruptSteerState(session).busy, false);
});

test('a steer received inside ordinary settled keeps deferred follow-up after the replacement', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  const settled = gate(), exit = gate();
  t.after(() => exit.resolve());
  const emit = session._extensionRunner.emit.bind(session._extensionRunner);
  let once = false;
  session._extensionRunner.emit = async (event) => {
    if (event.type === 'agent_settled' && !once) {
      once = true;
      await session.sendUserMessage('F', { deliverAs: 'followUp' });
      settled.resolve();
      await exit.promise;
    }
    return emit(event);
  };
  faux.setResponses([fauxAssistantMessage([fauxText('old')]), fauxAssistantMessage([fauxText('A answered')]), fauxAssistantMessage([fauxText('F answered')])]);
  const logical = session.prompt('old');
  await settled.promise;
  await session.steer('A');
  exit.resolve();
  await within(logical);
  assert.deepEqual(session.messages.filter((message) => message.role === 'user').map(text), ['old', 'A', 'F']);
  assert.equal(getInterruptSteerState(session).busy, false);
});

test('immediate steering cancels compaction before its controller has been created', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage([fauxText('history')]), fauxAssistantMessage([fauxText('replacement')])]);
  await session.prompt('history to compact');
  const settings = session.settingsManager.getCompactionSettings.bind(session.settingsManager);
  session.settingsManager.getCompactionSettings = (model) => ({ ...settings(model), keepRecentTokens: 1 });
  let compactionSignal;
  t.after(() => session.abortCompaction());
  session._runDefaultCompaction = async (_preparation, _model, _instructions, signal) => {
    compactionSignal = signal;
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Compaction cancelled');
  };
  const compaction = session.compact().then(() => null, (error) => error);
  await session.steer('immediate');
  await within(waitForInterruptSteer(session));
  assert.match((await compaction).message, /cancelled/);
  assert.equal(compactionSignal.aborted, true);
  assert.equal(faux.state.callCount, 2);
  assert.equal(getInterruptSteerState(session).busy, false);
});

test('only the first compact-internal abort is exempt from a pre-controller Stop', { timeout: 10000 }, async (t) => {
  const { session, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage([fauxText('history')])]);
  await session.prompt('history to compact');
  const settings = session.settingsManager.getCompactionSettings.bind(session.settingsManager);
  session.settingsManager.getCompactionSettings = (model) => ({ ...settings(model), keepRecentTokens: 1 });
  const abort = session.abort.bind(session);
  let first = true, stop, signal;
  session.abort = async () => {
    await abort();
    if (first) { first = false; queueMicrotask(() => { stop = abort(); }); }
  };
  t.after(() => session.abortCompaction());
  session._runDefaultCompaction = async (_preparation, _model, _instructions, currentSignal) => {
    signal = currentSignal;
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Compaction cancelled');
  };
  const compaction = session.compact().then(() => null, (error) => error);
  assert.match((await within(compaction)).message, /cancelled/);
  await within(stop);
  assert.equal(signal.aborted, true);
  assert.equal(faux.state.callCount, 1);
  assert.equal(session.isIdle, true);
});

test('interrupt status history is bounded metadata; failed images stay only in recovery entries', { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t);
  session._prepareRun = async () => { throw new Error('preparation failed'); };
  const attachment = { ...image, data: 'x'.repeat(65536) };
  for (let index = 0; index < 70; index += 1) {
    await session.steer(`failed ${index}`, [attachment]);
    await assert.rejects(waitForInterruptSteer(session), /preparation failed/);
  }
  const state = getInterruptSteerState(session);
  assert.ok(state.requests.length <= 50);
  assert.ok(JSON.stringify(state).length < 100000);
  assert.equal(JSON.stringify(state).includes(attachment.data), false);
  const request = state.requests.at(-1);
  assert.equal(request.input.imageCount, 1);
  const recovery = session.sessionManager.getEntries().find((entry) => entry.id === request.recoveryEntryId);
  assert.deepEqual(recovery.data.payload.images, [attachment]);
});
