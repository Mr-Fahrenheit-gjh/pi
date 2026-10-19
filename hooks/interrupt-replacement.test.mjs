import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const cases = ["interrupt_steer_start", "interrupt_steer_end", "agent_start", "agent_end"].map((type) => {
  const clause = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === `"${type}"`);
  assert.ok(clause, `missing case ${type}`);
  return clause.getText(source);
});
const refresh = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "refreshRunEnd");
assert.ok(refresh);
const handler = new Script(ts.transpileModule(`((event) => { ${refresh.getText(source)} switch (event.type) { ${cases.join("\n")} } })`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
function setup() {
  const reads = [], phases = [], stateReads = [], applied = {};
  const context = createContext({
    agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true },
    sessionIdRef: { current: "session-a" }, interruptReplacementSessionRef: { current: null },
    promptRunIdRef: { current: 1 }, contextUsageRequestIdRef: { current: 0 },
    loadSession: (sid) => { reads.push(sid); },
    fetch: (url) => { stateReads.push(url); return Promise.resolve({ ok: true, json: () => ({ state: { model: 'replacement-model', systemPrompt: 'replacement-system', extensionStatuses: [], extensionWidgets: [], queuedMessages: {} } }) }); },
    sessionHookMountedRef: { current: true },
    syncLiveModel: (state) => { applied.model = state.model; }, applyContextUsage() {},
    setSystemPrompt: (value) => { applied.systemPrompt = value; },
    setExtensionStatuses() {}, setExtensionWidgets() {}, setQueuedMessages() {}, normalizeQueuedMessages: (value) => value,
    setRetryInfo() {}, cancelEventStreamGrace() {}, setAgentRunning() {}, dispatch() {},
    setAgentPhase: (phase) => { phases.push(phase); },
  });
  return { handle: handler.runInContext(context), context, reads, phases, stateReads, applied };
}
test("interrupt physical ends keep busy feedback; transaction end refreshes", () => {
  const { handle, reads, phases } = setup();
  handle({ type: "interrupt_steer_start" });
  handle({ type: "agent_end" });
  assert.deepEqual(reads, []);
  assert.equal(phases.at(-1).kind, "waiting_model");
  handle({ type: "agent_start" });
  handle({ type: "agent_end" });
  assert.deepEqual(reads, []);
  assert.equal(phases.at(-1).kind, "waiting_model");
  handle({ type: "interrupt_steer_end" });
  assert.deepEqual(reads, ["session-a"]);
  handle({ type: "agent_end" });
  assert.equal(phases.at(-1), null);
  assert.equal(reads.length, 2);
});
test("failed or cancelled replacement refreshes once without inventing settlement", () => {
  for (const aborted of [true, false]) {
    const { handle, reads, context } = setup();
    handle({ type: "interrupt_steer_start" });
    handle({ type: "agent_end" });
    handle({ type: "interrupt_steer_end", aborted });
    handle({ type: "interrupt_steer_end", aborted });
    assert.deepEqual(reads, ["session-a"]);
    assert.equal(context.agentRunningRef.current, true);
  }
});
test("ordinary ends and another session are not suppressed", () => {
  const { handle, reads, context } = setup();
  handle({ type: "agent_end" });
  handle({ type: "interrupt_steer_start" });
  context.sessionIdRef.current = "session-b";
  handle({ type: "agent_end" });
  handle({ type: "interrupt_steer_end" });
  assert.deepEqual(reads, ["session-a", "session-b"]);
});
test("consecutive interrupts suppress physical ends until the transaction ends", () => {
  const { handle, reads } = setup();
  for (let i = 0; i < 2; i++) {
    handle({ type: "interrupt_steer_start" });
    handle({ type: "agent_end" });
    handle({ type: "agent_start" });
  }
  assert.equal(reads.length, 0);
  handle({ type: "agent_end" });
  assert.equal(reads.length, 0);
  handle({ type: "interrupt_steer_end" });
  assert.deepEqual(reads, ["session-a"]);
});
test("transaction end restores live model/system state; stale session responses are ignored", async () => {
  for (const switchSession of [false, true]) {
    const { handle, context, stateReads, applied } = setup();
    handle({ type: "interrupt_steer_start" });
    handle({ type: "agent_start" });
    handle({ type: "agent_end" });
    assert.deepEqual(stateReads, []);
    handle({ type: "interrupt_steer_end" });
    if (switchSession) context.sessionIdRef.current = "session-b";
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stateReads, ["/api/agent/session-a"]);
    assert.deepEqual(applied, switchSession ? {} : { model: "replacement-model", systemPrompt: "replacement-system" });
  }
});
test("old preflight agent_start cannot clear an accepted interrupt guard", () => {
  const { handle, reads } = setup();
  handle({ type: "interrupt_steer_start" });
  handle({ type: "agent_start" }); // old run finishes preflight, then aborts
  handle({ type: "agent_end" });
  handle({ type: "agent_start" }); // actual replacement
  assert.deepEqual(reads, []);
  handle({ type: "agent_end" });
  assert.deepEqual(reads, []);
  handle({ type: "interrupt_steer_end" });
  assert.deepEqual(reads, ["session-a"]);
});
