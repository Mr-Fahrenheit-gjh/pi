import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleContinueTask") callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const script = new Script(ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);

function setup() {
  const connection = Promise.withResolvers();
  const acceptance = Promise.withResolvers();
  const dispatched = Promise.withResolvers();
  const sent = [], reconciled = [], waited = [], notices = [], loaded = [];
  const context = createContext({
    taskCanContinue: true,
    sessionIdRef: { current: "session" }, activeLeafIdRef: { current: "leaf" },
    agentRunningRef: { current: false }, bashRunningRef: { current: false },
    continuationIntentRef: { current: 0 }, promptRunIdRef: { current: 0 },
    rpcPromptPendingRef: { current: false }, optimisticUserMessageKeyRef: { current: null },
    sessionHookMountedRef: { current: true },
    cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {}, dispatch() {},
    ensureEventsConnected: () => connection.promise,
    sendAgentCommand: (id, command) => { sent.push({ id, ...command }); dispatched.resolve(); return acceptance.promise; },
    reconcileAgentState: (id) => reconciled.push(id),
    waitForPromptSettlement: (id) => waited.push(id),
    loadSession: (id) => loaded.push(id),
    addNotice: (notice) => notices.push(notice),
    isPromptRejectedError: (error) => error.rejected === true,
  });
  return { context, connection, acceptance, dispatched, sent, reconciled, waited, notices, loaded, run: script.runInContext(context) };
}

test("continuation sends only a branch token, once, and leaves model instructions to the host", async () => {
  const state = setup();
  const first = state.run();
  const duplicate = state.run();
  state.connection.resolve();
  state.acceptance.resolve();
  await Promise.all([first, duplicate]);
  assert.deepEqual(state.sent, [{ id: "session", type: "continue_task", expectedLeafId: "leaf" }]);
  assert.deepEqual(state.waited, ["session"]);
});

test("stop, user takeover, navigation and branch changes cancel a continuation before dispatch", async () => {
  for (const invalidate of [
    (ctx) => ctx.continuationIntentRef.current++,
    (ctx) => { ctx.sessionIdRef.current = "other"; },
    (ctx) => { ctx.activeLeafIdRef.current = "other"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
  ]) {
    const state = setup();
    const pending = state.run();
    invalidate(state.context);
    state.connection.resolve();
    await pending;
    assert.deepEqual(state.sent, []);
  }
});

test("unknown acceptance reconciles without replay, draft restoration or an error claiming rejection", async () => {
  const state = setup();
  const pending = state.run();
  state.connection.resolve();
  state.acceptance.reject(new TypeError("connection lost"));
  await pending;
  assert.equal(state.sent.length, 1);
  assert.deepEqual(state.waited, ["session"]);
  assert.deepEqual(state.notices, []);
  assert.deepEqual(state.loaded, []);
});

test("a definite rejection reloads the branch and keeps the draft untouched", async () => {
  const state = setup();
  const pending = state.run();
  state.connection.resolve();
  state.acceptance.reject({ rejected: true, message: "stale" });
  await pending;
  assert.deepEqual(state.waited, []);
  assert.deepEqual(state.reconciled, ["session"]);
  assert.deepEqual(state.loaded, ["session"]);
  assert.equal(state.notices.length, 1);
  assert.equal(state.context.rpcPromptPendingRef.current, false);
});

test("a late response cannot reconcile a different session or a newer run", async () => {
  for (const invalidate of [
    (ctx) => { ctx.sessionIdRef.current = "other"; },
    (ctx) => ctx.promptRunIdRef.current++,
  ]) {
    const state = setup();
    const pending = state.run();
    state.connection.resolve();
    await state.dispatched.promise;
    invalidate(state.context);
    state.acceptance.reject({ rejected: true });
    await pending;
    assert.deepEqual(state.reconciled, []);
    assert.deepEqual(state.notices, []);
  }
});
