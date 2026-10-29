import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(t, options = {}) {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "context", timestamp: Date.now() });
  const finish = Promise.withResolvers(), requests = [], completions = [];
  let current = true;
  const inner = {
    sessionId: manager.getSessionId(), sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    extensionRunner: {}, agent: { state: {} }, getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    prompt(text, opts) { requests.push(text); manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); opts.preflightResult("started"); return finish.promise; },
    async abort() { finish.resolve(); }, abortBash() {}, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, options);
  t.after(() => { finish.resolve(); wrapper.destroy(); });
  const voice = { expectedLeafId: manager.getLeafId(), isCurrent: () => current, onComplete: (entries) => completions.push(entries) };
  return { wrapper, inner, manager, finish, requests, completions, voice, leave: () => { current = false; } };
}

test("voice uses SDK preflight, acknowledges admission separately, and returns its exact settled branch", async (t) => {
  const s = setup(t);
  await s.wrapper.send({ type: "prompt", message: "Voice handoff: inspect" }, s.voice);
  assert.equal(s.requests.length, 1); assert.equal(s.completions.length, 0);
  s.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: Date.now() });
  s.finish.resolve(); await tick(); assert.equal(s.completions.length, 1); assert.ok(Array.isArray(s.completions[0]));
});

test("busy/queued/stale voice handoffs cannot enter SDK", async (t) => {
  for (const field of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"]) {
    const s = setup(t); s.inner[field] = field === "pendingMessageCount" ? 1 : true;
    await assert.rejects(s.wrapper.send({ type: "prompt", message: "voice" }, s.voice)); assert.equal(s.requests.length, 0);
  }
  const s = setup(t); s.leave();
  await assert.rejects(s.wrapper.send({ type: "prompt", message: "voice" }, s.voice)); assert.equal(s.requests.length, 0);
});

test("new input during MCP admission supersedes voice, without aborting or losing keyboard work", async (t) => {
  const ready = Promise.withResolvers(); let waits = 0;
  const s = setup(t, { mcpHost: { prepareForPrompt: () => ++waits === 1 ? ready.promise : Promise.resolve(), dispose() {} } });
  const voice = assert.rejects(s.wrapper.send({ type: "prompt", message: "voice" }, s.voice), /stale|busy/);
  await tick(); const keyboard = s.wrapper.send({ type: "prompt", message: "keyboard" }); ready.resolve();
  await voice; await keyboard; assert.deepEqual(s.requests, ["keyboard"]);
});

test("hangup during MCP preparation revokes admission before any SDK prompt starts", async (t) => {
  const ready = Promise.withResolvers();
  const s = setup(t, { mcpHost: { prepareForPrompt: () => ready.promise, dispose() {} } });
  const pending = assert.rejects(s.wrapper.send({ type: "prompt", message: "voice" }, s.voice), /stale|busy/);
  await tick(); s.leave(); ready.resolve(); await pending;
  assert.equal(s.requests.length, 0); assert.equal(s.wrapper.isRunning(), false);
});

test("navigation/hangup after acceptance suppresses voice result but does not abort Pi", async (t) => {
  const s = setup(t); await s.wrapper.send({ type: "prompt", message: "voice" }, s.voice);
  s.leave(); assert.equal(s.wrapper.isRunning(), true);
  s.finish.resolve(); await tick(); assert.deepEqual(s.completions, [null]);
});

test("a newer keyboard action cannot lend its answer to a voice operation", async (t) => {
  const s = setup(t); await s.wrapper.send({ type: "prompt", message: "voice" }, s.voice);
  await s.wrapper.send({ type: "prompt", message: "keyboard" });
  s.finish.resolve(); await tick(); assert.deepEqual(s.completions, [null]);
});
