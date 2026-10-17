import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { FeynmanRpcSession, validateFeynmanCommand, feynmanEventChannel, feynmanRestartBlockingIds, startFeynmanSession } = await jiti.import("./feynman-rpc.ts");
const { externalFeynmanOwners, lockFeynmanSession, withFeynmanOperation } = await jiti.import("./feynman-ownership.ts");

function fakeChild(reply = () => {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => {} });
  child.stdin.on("data", (chunk) => reply(JSON.parse(chunk.toString()), child));
  return child;
}

test("JSONL handshake ignores bootstrap notices, associates replies and accepts split frames", async () => {
  const child = fakeChild((command, child) => {
    const response = JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "isolated-id", sessionFile: "/isolated/file.jsonl", thinkingLevel: "medium", isStreaming: false } });
    child.stdout.write("Feynman bootstrap\nnull\n[]\n42\n" + response.slice(0, 17));
    child.stdout.write(response.slice(17) + "\n");
  });
  const session = new FeynmanRpcSession(child, "/workspace");
  await session.send({ type: "get_state" });
  assert.equal(session.sessionId, "isolated-id");
  assert.equal(session.cwd, "/workspace");
  assert.equal(session.isRunning(), false);
  child.emit("close", 0);
});

test("streaming events and reconnect snapshots stay in the session that owns them", () => {
  const child = fakeChild();
  const session = new FeynmanRpcSession(child, "/workspace");
  const seen = [];
  const off = session.onEvent((event) => seen.push(event.type));
  for (const event of [{type:"agent_start"}, {type:"message_update",message:{role:"assistant", content:[]}}, {type:"agent_end"}, {type:"agent_settled"}]) {
    child.stdout.write(JSON.stringify(event) + "\n");
    if (event.type === "message_update") { assert.equal(session.isRunning(), true); assert.equal(session.streamingMessage.role, "assistant"); }
  }
  assert.deepEqual(seen, ["agent_start", "message_update", "agent_end", "agent_settled", "prompt_done"]);
  assert.equal(session.streamingMessage, null);
  assert.equal(session.isRunning(), false);
  off(); child.emit("close", 0);
});

test("retry backoff remains a running logical prompt until agent_settled", async () => {
  const child = fakeChild((command, child) => child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "retry-id", isStreaming: false, thinkingLevel: "medium" } }) + "\n"));
  const session = new FeynmanRpcSession(child, "/workspace");
  await session.send({ type: "get_state" });
  for (const type of ["agent_start", "agent_end", "auto_retry_start"]) child.stdout.write(JSON.stringify({ type }) + "\n");
  assert.equal(session.isRunning(), true);
  assert.equal(session.isStreaming, true);
  assert.equal((await session.send({ type: "get_state" })).isPromptRunning, true);
  child.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\n");
  assert.equal(session.isRunning(), false);
  child.emit("close", 0);
});

test("handled extension commands end the Web prompt stage without a model run", async () => {
  const child = fakeChild((command, child) => child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "handled" } }) + "\n"));
  const session = new FeynmanRpcSession(child, "/workspace");
  const events = []; session.onEvent((event) => events.push(event.type));
  await session.send({ type: "prompt", message: "/peer-agent" });
  assert.deepEqual(events, ["prompt_done"]);
  assert.equal(session.isRunning(), false);
  child.emit("close", 0);
});

test("handled or rejected idle steer does not leave a phantom interrupt transaction", async () => {
  for (const success of [true, false]) {
    const child = fakeChild((command, child) => child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success, data: { disposition: "handled" }, error: "admission rejected" }) + "\n"));
    const session = new FeynmanRpcSession(child, "/workspace");
    const events = []; session.onEvent(event => events.push(event.type));
    const run = session.send({ type: "steer", message: "/handled" });
    if (success) await run; else await assert.rejects(run, /admission rejected/);
    assert.equal(session.isRunning(), false);
    assert.equal(events.filter(type => type === "prompt_done").length, success ? 1 : 0);
    child.emit("close", 0);
  }
});

test("interrupt admission remains busy before agent_start and ends only at the logical boundary", async () => {
  const child = fakeChild((command, child) => child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { sessionId: "interrupt-id", isStreaming: false, thinkingLevel: "medium" } : { disposition: "queued" } }) + "\n"));
  const session = new FeynmanRpcSession(child, "/workspace");
  const events = []; session.onEvent(event => events.push(event.type));
  const feed = type => child.stdout.write(JSON.stringify({ type }) + "\n");
  await session.send({ type: "get_state" });
  feed("interrupt_steer_start");
  await session.send({ type: "steer", message: "idle admission" });
  assert.equal(session.isRunning(), true);
  assert.equal((await session.send({ type: "get_state" })).isPromptRunning, true);
  feed("agent_start"); feed("agent_end"); feed("agent_settled");
  assert.equal(session.isRunning(), true, "physical settled is not the interrupt transaction boundary");
  assert.equal(events.filter(type => type === "prompt_done").length, 0);
  feed("interrupt_steer_end");
  assert.equal(session.isRunning(), false);
  assert.equal(events.filter(type => type === "prompt_done").length, 1);
  assert.deepEqual(events.filter(type => ["agent_settled", "prompt_done"].includes(type)), ["agent_settled", "prompt_done"]);
  child.emit("close", 0);
});

test("interrupt Stop, failure and continuous admissions do not strand busy state or finish twice", () => {
  for (const aborted of [false, true]) {
    const child = fakeChild(); const session = new FeynmanRpcSession(child, "/workspace");
    const events = []; session.onEvent(event => events.push(event.type));
    const feed = (type, fields = {}) => child.stdout.write(JSON.stringify({ type, ...fields }) + "\n");
    feed("interrupt_steer_start"); feed("interrupt_steer_start"); feed("agent_start"); feed("agent_end");
    if (!aborted) feed("prompt_error", { errorMessage: "failed preparation" });
    feed("agent_settled", { aborted });
    assert.equal(session.isRunning(), true);
    feed("interrupt_steer_end", { aborted });
    assert.equal(session.isRunning(), false);
    assert.equal(events.filter(type => type === "prompt_done").length, 1);
    assert.deepEqual(events.filter(type => ["agent_settled", "prompt_done"].includes(type)), ["agent_settled", "prompt_done"], "the actual Web hook must receive its terminal SDK event before prompt_done");
    child.emit("close", 0);
  }
});

test("process exit rejects pending commands, settles state and reports failure", async () => {
  const child = fakeChild();
  const session = new FeynmanRpcSession(child, "/workspace");
  const pending = session.send({ type: "get_state" });
  child.emit("close", 1);
  await assert.rejects(pending, /Feynman.*退出/);
  assert.equal(session.isAlive(), false);
  assert.equal(session.isRunning(), false);
  await assert.rejects(session.send({ type: "prompt", message: "test" }), /进程已退出/);
});

test("fixed model policy cannot be bypassed by UI commands or switching session paths", () => {
  for (const command of [{type:"cycle_model"}, {type:"cycle_thinking_level"}, {type:"set_model",provider:"other",modelId:"anything"}, {type:"set_thinking_level",level:"high"}, {type:"switch_session",sessionPath:"/pi/history.jsonl"}, {type:"new_session"}]) assert.throws(() => validateFeynmanCommand(command));
  for (const command of [{type:"get_state"}, {type:"prompt",message:"test"}, {type:"set_model",provider:"openai-codex",modelId:"gpt-6.1-sol"}, {type:"set_thinking_level",level:"medium"}]) assert.doesNotThrow(() => validateFeynmanCommand(command));
});

test("unowned independent CLI groups are distinguished from Web-owned children and unrelated Pi", () => {
  const snapshot = ["10 10 /usr/bin/node node /feynman/node_modules/@companion-ai/feynman/bin/feynman.js", "11 11 /usr/bin/node node /pi/node_modules/pi.js", "12 12 /usr/bin/node node /feynman/node_modules/pi.js", "13 13 /bin/sh sh /feynman/node_modules/anything"].join("\n");
  assert.deepEqual(externalFeynmanOwners(snapshot, "/feynman", new Set([12])), [10]);
});

test("a persisted session permits only one Web writer until the owner releases its lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-feynman-lock-"));
  const path = join(directory, "session.jsonl"); writeFileSync(path, "fixture");
  let release;
  try {
    release = await lockFeynmanSession(path, () => {});
    await assert.rejects(lockFeynmanSession(path, () => {}), /另一 Pi Web/);
    await release(); release = undefined;
    release = await lockFeynmanSession(path, () => {});
  } finally { await release?.(); rmSync(directory, { recursive: true, force: true }); }
});

test("a deletion transaction retains its cross-process lease through child shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-feynman-delete-"));
  const path = join(directory, "session.jsonl"); writeFileSync(path, "fixture");
  const child = fakeChild();
  const session = new FeynmanRpcSession(child, directory);
  session.holdWriterLease(await lockFeynmanSession(path, () => {}));
  try {
    const deleting = session.stopAndMutate(async () => {
      await assert.rejects(lockFeynmanSession(path, () => {}), /另一 Pi Web/);
      return "deleted";
    });
    queueMicrotask(() => child.emit("close", 0));
    assert.equal(await deleting, "deleted");
    const release = await lockFeynmanSession(path, () => {});
    await release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("per-session operations serialize writers and permit nested operations by the current owner", async () => {
  const events = [];
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const first = withFeynmanOperation("test-session", async () => {
    events.push("first");
    await withFeynmanOperation("test-session", async () => { events.push("nested"); });
    started(); await barrier; events.push("end");
  });
  await ready;
  const second = withFeynmanOperation("test-session", async () => { events.push("second"); });
  assert.deepEqual(events, ["first", "nested"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "nested", "end", "second"]);
});

test("restart draining protects queued Feynman operations and rejects new work but permits status and abort", async () => {
  const { serviceRestartState } = await jiti.import("./service-restart-state.ts");
  const { restartBlockers } = await jiti.import("./service-restart.ts");
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const state = serviceRestartState();
  const first = withFeynmanOperation("restart-test", async () => { started(); await barrier; });
  await ready;
  const second = withFeynmanOperation("restart-test", async () => assert.fail("queued mutation ran during restart"));
  const child = fakeChild((command, child) => child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "restart-test", isStreaming: false } }) + "\n"));
  const session = new FeynmanRpcSession(child, "/workspace");
  await session.send({ type: "get_state" });
  try {
    assert.ok(feynmanRestartBlockingIds().includes("feynman:restart-test"));
    assert.ok(restartBlockers().sessions >= 1);
    const registry = globalThis[Symbol.for("pi-web:feynman-rpc:v1")];
    registry.sessions.set("restart-test", session);
    state.pending = true;
    assert.equal(await startFeynmanSession("restart-test"), session);
    assert.throws(() => startFeynmanSession("not-started"), /restarting/);
    assert.throws(() => withFeynmanOperation("new-work", async () => {}), /restarting/);
    await assert.rejects(session.send({ type: "prompt", message: "blocked" }), /restarting/);
    await session.send({ type: "get_state" });
    await session.send({ type: "abort" });
    const rejected = assert.rejects(second, /restarting/);
    release(); await first; await rejected;
  } finally {
    state.pending = false; release(); child.emit("close", 0);
    globalThis[Symbol.for("pi-web:feynman-rpc:v1")].sessions.delete("restart-test");
  }
  assert.ok(!feynmanRestartBlockingIds().includes("feynman:restart-test"));
});

test("UI confirmations stay pending until the authenticated response and are never model replies", async () => {
  const child = fakeChild();
  const session = new FeynmanRpcSession(child, "/workspace");
  child.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "ui-id", title: "Question", message: "confirm?" }) + "\n");
  assert.equal(session.awaitingInput, true);
  assert.equal(session.pendingUiRequests.length, 1);
  await session.send({ type: "extension_ui_response", id: "ui-id", confirmed: false });
  assert.equal(session.awaitingInput, false);
  child.emit("close", 0);
});

test("opening a passive history event channel never launches a process", () => {
  const channel = feynmanEventChannel("offline-history");
  assert.equal(channel.isStreaming, false);
  assert.equal(channel.streamingMessage, null);
  const off = channel.onEvent(() => {});
  off();
});
