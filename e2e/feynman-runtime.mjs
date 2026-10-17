// Actual independent CLI/RPC + reverse bridge, without a provider/model request.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const rpc = await jiti.import("../lib/feynman-rpc.ts");
const peer = await jiti.import("../lib/runtime-peer.ts");
const store = await jiti.import("../lib/feynman-store.ts");
const directory = mkdtempSync(join(tmpdir(), "pi-web-feynman-smoke-"));
let session;
try {
  session = await rpc.startFeynmanSession(`__new__smoke-${Date.now()}`, directory);
  const transient = await store.readFeynmanSession(session.sessionId, new URLSearchParams(), session);
  assert.equal(transient.sessionId, session.sessionId);
  assert.equal(transient.context.model.modelId, "gpt-6.1-sol");
  assert.equal(transient.context.thinkingLevel, "medium");
  const commands = await session.send({ type: "get_commands" });
  assert.ok(commands.commands.some((command) => command.name === "peer-agent"), "the real CLI must have loaded the extension before any slash invocation");
  let timer;
  const notification = new Promise((resolve, reject) => {
    const off = session.onEvent((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "notify") return;
      try {
        const data = JSON.parse(event.message);
        if (data.runtime === "pi") { off(); clearTimeout(timer); resolve(data); }
      } catch { /* unrelated notification */ }
    });
    timer = setTimeout(() => { off(); reject(new Error("Reverse peer bridge did not answer")); }, 10_000);
  });
  // Known extension command: its handler only locates Pi; it cannot call a model.
  await session.send({ type: "prompt", message: "/peer-agent" });
  const result = await notification;
  assert.equal(result.page, "/");
  assert.equal(session.state.model.provider, "openai-codex");
  assert.equal(session.state.model.id, "gpt-6.1-sol");
  assert.equal(session.state.thinkingLevel, "medium");
  console.log(JSON.stringify({ passed: true, cliRpc: true, extensionLoaded: true, feynmanToPiBridge: true, liveHistoryBeforeModel: true, modelCalls: 0 }));
} finally {
  await session?.shutdown();
  rpc.stopFeynmanSessions(); peer.closePeerBridge();
  if (session?.sessionFile && existsSync(session.sessionFile)) unlinkSync(session.sessionFile);
  rmSync(directory, { recursive: true, force: true });
}
