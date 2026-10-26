import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const failed = (stopReason = "error") => ({ role: "assistant", content: [], stopReason, timestamp: Date.now() });

function setup(t, options = {}) {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "send the original message", timestamp: Date.now() });
  manager.appendMessage(failed(options.stopReason));
  const requests = [];
  const finish = Promise.withResolvers();
  const inner = {
    sessionId: manager.getSessionId(), sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    extensionRunner: {}, agent: { state: {} },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    prompt(text, opts) {
      requests.push({ text, opts });
      manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      opts.preflightResult("started");
      return finish.promise;
    },
    async abort() { finish.resolve(); },
    abortBash() {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, options);
  t.after(() => { finish.resolve(); wrapper.destroy(); });
  const command = { type: "continue_task", expectedLeafId: manager.getLeafId() };
  return { manager, inner, wrapper, requests, finish, command };
}

test("manual recovery uses the ordinary prompt path without replaying input or attachments", async (t) => {
  const state = setup(t);
  await state.wrapper.send({ ...state.command, message: "untrusted replacement", streamingBehavior: "steer", images: [{ data: "private" }] });
  assert.equal(state.requests.length, 1);
  assert.match(state.requests[0].text, /^Continue the interrupted task/);
  assert.doesNotMatch(state.requests[0].text, /send the original message|untrusted replacement|private/);
  assert.equal(state.requests[0].opts.images, undefined);
  assert.equal(state.requests[0].opts.streamingBehavior, undefined);
  assert.equal(state.wrapper.isRunning(), true);
  state.finish.resolve();
  await tick();
  assert.equal(state.wrapper.isRunning(), false);
});

test("stale, missing or completed recovery targets never reach the model", async (t) => {
  for (const expectedLeafId of [undefined, "older-leaf"]) {
    const state = setup(t);
    await assert.rejects(state.wrapper.send({ ...state.command, expectedLeafId }), /conversation changed/);
    assert.equal(state.requests.length, 0);
  }
  const state = setup(t, { stopReason: "stop" });
  await assert.rejects(state.wrapper.send(state.command), /no interrupted task/);
  assert.equal(state.requests.length, 0);
});

test("running work, compaction, shell commands and queued input block recovery", async (t) => {
  for (const field of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"]) {
    const state = setup(t);
    state.inner[field] = field === "pendingMessageCount" ? 1 : true;
    await assert.rejects(state.wrapper.send(state.command), /current work|shell command/);
    assert.equal(state.requests.length, 0);
  }
});

test("two tabs/double click submit at most one continuation; the original leaf stays stale after settlement", async (t) => {
  const state = setup(t);
  const outcomes = await Promise.allSettled([state.wrapper.send(state.command), state.wrapper.send(state.command)]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(state.requests.length, 1);
  state.finish.resolve();
  await tick();
  await assert.rejects(state.wrapper.send(state.command), /conversation changed/);
  assert.equal(state.requests.length, 1);
});

test("Stop while waiting for extension binding invalidates the continuation", async (t) => {
  const state = setup(t);
  const binding = Promise.withResolvers();
  state.inner.bindExtensions = () => binding.promise;
  state.wrapper.beginExtensionBinding();
  const recovering = assert.rejects(state.wrapper.send(state.command), /cancelled by Stop/);
  await tick();
  await state.wrapper.send({ type: "abort" });
  binding.resolve();
  await recovering;
  assert.equal(state.requests.length, 0);
});

test("a new input during MCP preparation supersedes recovery without being lost", async (t) => {
  const prepared = Promise.withResolvers();
  let waits = 0;
  const state = setup(t, { mcpHost: { prepareForPrompt: () => ++waits === 1 ? prepared.promise : Promise.resolve(), dispose() {} } });
  const recovering = assert.rejects(state.wrapper.send(state.command), /conversation changed/);
  await tick();
  const sending = state.wrapper.send({ type: "prompt", message: "new user instruction" });
  prepared.resolve();
  await recovering;
  await sending;
  assert.deepEqual(state.requests.map((request) => request.text), ["new user instruction"]);
});

test("branch changes during MCP preparation are checked again before SDK dispatch", async (t) => {
  const prepared = Promise.withResolvers();
  const state = setup(t, { mcpHost: { prepareForPrompt: () => prepared.promise, dispose() {} } });
  const recovering = assert.rejects(state.wrapper.send(state.command), /conversation changed/);
  await tick();
  state.manager.appendMessage({ role: "user", content: "another source", timestamp: Date.now() });
  prepared.resolve();
  await recovering;
  assert.equal(state.requests.length, 0);
  assert.equal(state.wrapper.isRunning(), false);
});

test("Stop cancels an MCP wait without dispatching a recovery prompt", async (t) => {
  const state = setup(t, { mcpHost: { prepareForPrompt: (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })), dispose() {} } });
  const recovering = assert.rejects(state.wrapper.send(state.command), /Stopped while MCP/);
  await tick();
  await state.wrapper.send({ type: "abort" });
  await recovering;
  assert.equal(state.requests.length, 0);
});
