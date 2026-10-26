import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { recordSessionReadLifecycle, readSessionReadState } = await jiti.import("./session-read-state.ts");
test("wrapper true completion, duplicate ends, stop and child suppression drive serialized read state", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-read-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  for (const suppressed of [false, true]) {
    let listener;
    const writes = [];
    const inner = {
      sessionId: suppressed ? "child" : "main", isStreaming: false, isBashRunning: false,
      extensionRunner: {}, agent: { state: {} }, dispose() {},
      sessionManager: { getCwd: () => root, getSessionName: () => "test" },
      subscribe(fn) { listener = fn; return () => {}; },
    };
    const wrapper = new AgentSessionWrapper(inner, {
      suppressCompletionNotifications: suppressed,
      onAgentRunStart: id => writes.push(recordSessionReadLifecycle(id, "start", path)),
      onAgentRunComplete: id => writes.push(recordSessionReadLifecycle(id, "complete", path)),
    });
    t.after(() => wrapper.destroy()); wrapper.start();
    inner.isStreaming = true; listener({ type: "agent_start" }); listener({ type: "agent_end" });
    await Promise.all(writes); assert.deepEqual(readSessionReadState(path).unread, {});
    inner.isStreaming = false; listener({ type: "agent_settled" }); listener({ type: "agent_settled" });
    await Promise.all(writes);
    assert.equal(writes.length, suppressed ? 0 : 2);
    if (!suppressed) assert.ok(readSessionReadState(path).unread.main);
    inner.isStreaming = true; listener({ type: "agent_start" });
    inner.isStreaming = false; listener({ type: "agent_settled", aborted: true });
    await Promise.all(writes);
    assert.deepEqual(readSessionReadState(path).unread, {});
  }
  const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /onAgentRunStart: \(id\) => persistReadLifecycle\(id, "start"\)/);
  assert.match(source, /persistReadLifecycle\(completedSessionId, "complete"\)/);
});
