import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startTerminalBridge } from "../TerminalBridge/terminal-bridge.mjs";

const question = (multiSelect) => ({ question: "是否继续？", header: "确认", multiSelect,
  options: [{ label: "是", description: "原始说明", hasPreview: false }, { label: "否", description: "不继续", hasPreview: false }] });

test("Swift client and terminal extension exchange actual socket frames", { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync("/tmp/pib-wire-");
  const directory = path.join(root, "bridge");
  const events = new EventEmitter();
  const ctx = { cwd: "/work/project", sessionManager: { getSessionId: () => "terminal-session", getSessionName: () => "终端测试" } };
  const executable = path.resolve("build/terminal-bridge-tests");
  const bridge = await startTerminalBridge({ events }, ctx, directory);
  const calls = [];
  events.on("rpiv:ask-user:answer", (payload) => { calls.push(payload); bridge.verdict({ ...payload, ok: true }); });
  bridge.prompt({ toolCallId: "wire-test", questions: [question(false), question(true)] });
  bridge.blocked({ active: true, toolCallId: "wire-test" });
  const child = spawn(executable, [directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    assert.match(output, /PASS: Swift\/Node/);
    assert.equal(calls.length, 1, "rapid submit/cancel sends only one answer");
    assert.match(calls[0].requestId, /^[0-9A-F-]{36}$/);
    assert.deepEqual({ ...calls[0], requestId: "captured" }, { toolCallId: "wire-test", requestId: "captured", answers: [
      { questionIndex: 0, optionIndexes: [1] },
      { questionIndex: 1, optionIndexes: [0, 1], text: " 自定义 " },
    ] });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
