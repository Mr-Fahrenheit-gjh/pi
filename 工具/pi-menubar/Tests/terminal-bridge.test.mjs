import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { startTerminalBridge } from "../TerminalBridge/terminal-bridge.mjs";

const question = (multiSelect = false, hasPreview = false) => ({
  question: "是否继续？", header: "确认", multiSelect,
  options: [{ label: "是", description: "原始说明", hasPreview }, { label: "否", description: "不继续", hasPreview: false }],
});

function frames(socket) {
  let buffer = "";
  const values = [];
  const waiting = [];
  socket.on("data", (data) => {
    buffer += data.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      values.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
    while (waiting.length && values.length) waiting.shift()(values.shift());
  });
  return async (predicate = () => true) => {
    for (;;) {
      const value = values.length ? values.shift() : await Promise.race([
        new Promise((resolve) => waiting.push(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for bridge frame")), 2000).unref()),
      ]);
      if (predicate(value)) return value;
    }
  };
}

async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  const next = frames(socket);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, next };
}

function fixture() {
  const root = fs.mkdtempSync("/tmp/pib-");
  const directory = path.join(root, "bridge");
  const events = new EventEmitter();
  const ctx = { cwd: "/work/project", sessionManager: { getSessionId: () => "terminal-session", getSessionName: () => "终端测试" } };
  return { root, directory, events, ctx, pi: { events } };
}

const command = (bridge, id, extra = {}) => ({ type: "answer", instanceId: bridge.instanceId,
  sessionId: "terminal-session", toolCallId: id, requestId: `request-${id}`, ...extra });
const write = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);

test("terminal bridge snapshots, exact answers, race handling, preview fallback and cleanup", async () => {
  const f = fixture();
  const bridge = await startTerminalBridge(f.pi, f.ctx, f.directory);
  const calls = [];
  f.events.on("rpiv:ask-user:answer", (value) => { calls.push(value); bridge.verdict({ ...value, ok: true }); });
  try {
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(bridge.socketPath).mode & 0o777, 0o600);
    const first = await connect(bridge.socketPath);
    assert.deepEqual((await first.next()).prompts, []);
    bridge.prompt({ toolCallId: "one", questions: [question(), question(true)] });
    bridge.blocked({ active: true, toolCallId: "one" });
    let state = await first.next((value) => value.type === "snapshot" && value.prompts.length === 1);
    assert.equal(state.instanceId, bridge.instanceId);
    assert.equal(state.sessionId, "terminal-session");
    assert.equal(state.prompts[0].questions[0].options[0].description, "原始说明");
    assert.equal(state.prompts[0].canRespond, true);
    assert.equal(calls.length, 0, "opening or rendering never submits an answer");

    const answers = [{ questionIndex: 0, optionIndexes: [1] }, { questionIndex: 1, optionIndexes: [0, 1], text: " 自定义 " }];
    write(first.socket, command(bridge, "one", { answers }));
    const verdict = await first.next((value) => value.type === "verdict");
    assert.equal(verdict.ok, true);
    assert.deepEqual(calls[0], { toolCallId: "one", requestId: "request-one", answers });
    state = await first.next((value) => value.type === "snapshot" && value.prompts.length === 0);
    write(first.socket, command(bridge, "one", { cancel: true }));
    assert.equal((await first.next((value) => value.type === "verdict")).code, "not_available");
    assert.equal(calls.length, 1, "a stale target cannot answer again");

    bridge.prompt({ toolCallId: "preview", questions: [question(false, true)] });
    bridge.blocked({ active: true, toolCallId: "preview" });
    state = await first.next((value) => value.type === "snapshot" && value.prompts.some((p) => p.toolCallId === "preview"));
    assert.equal(state.prompts[0].canRespond, false);
    write(first.socket, command(bridge, "preview", { answers: [{ questionIndex: 0, optionIndexes: [0] }] }));
    assert.equal((await first.next((value) => value.type === "verdict")).code, "not_available");
    assert.equal(calls.length, 1, "missing previews cannot be approved by the bridge");

    bridge.prompt({ toolCallId: "terminal-wins", questions: [question()] });
    bridge.blocked({ active: true, toolCallId: "terminal-wins" });
    bridge.blocked({ active: false, toolCallId: "terminal-wins" });
    write(first.socket, command(bridge, "terminal-wins", { cancel: true }));
    assert.equal((await first.next((value) => value.type === "verdict" && value.toolCallId === "terminal-wins")).code, "not_available");
    assert.equal(calls.length, 1);
    first.socket.destroy();

    const second = await connect(bridge.socketPath);
    state = await second.next();
    assert.deepEqual(state.prompts.map((p) => p.toolCallId), ["preview"], "reconnect is a fresh authoritative snapshot");
    bridge.blocked({ active: false, toolCallId: "preview" });
    assert.equal((await second.next((value) => value.type === "snapshot" && value.prompts.length === 0)).prompts.length, 0);
    const closing = bridge.close();
    assert.equal((await second.next((value) => value.type === "session-closed")).instanceId, bridge.instanceId);
    second.socket.destroy();
    await closing;
    assert.equal(fs.existsSync(bridge.socketPath), false);
  } finally {
    await bridge.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("unknown verdict locks an answer; unsafe directories are rejected", async () => {
  const f = fixture();
  const bridge = await startTerminalBridge(f.pi, f.ctx, f.directory);
  try {
    const peer = await connect(bridge.socketPath);
    await peer.next();
    bridge.prompt({ toolCallId: "uncertain", questions: [question()] });
    bridge.blocked({ active: true, toolCallId: "uncertain" });
    await peer.next((value) => value.type === "snapshot" && value.prompts.length === 1);
    write(peer.socket, command(bridge, "uncertain", { cancel: true }));
    assert.equal((await peer.next((value) => value.type === "verdict")).code, "uncertain");
    peer.socket.destroy();
    const again = await connect(bridge.socketPath);
    assert.equal((await again.next()).prompts[0].canRespond, false, "reconnect cannot unlock an uncertain answer");
    again.socket.destroy();
  } finally {
    await bridge.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  const unsafe = fixture();
  try {
    fs.mkdirSync(unsafe.directory, { mode: 0o755 });
    fs.chmodSync(unsafe.directory, 0o755);
    await assert.rejects(startTerminalBridge(unsafe.pi, unsafe.ctx, unsafe.directory), /unsafe/);
    fs.rmdirSync(unsafe.directory);
    fs.symlinkSync(unsafe.root, unsafe.directory);
    await assert.rejects(startTerminalBridge(unsafe.pi, unsafe.ctx, unsafe.directory), /unsafe/);
  } finally { fs.rmSync(unsafe.root, { recursive: true, force: true }); }
});
