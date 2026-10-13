import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { createBrowserWriter } = await createJiti(import.meta.url).import("./browser-client.ts");
test("ambiguous browser input is never replayed and old queued input cannot reappear on manual navigation", async () => {
  const original = globalThis.fetch; const seen = []; let reject;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    if (seen.length === 1) await new Promise((_r, fail) => { reject = fail; });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  try {
    const errors = []; const writer = createBrowserWriter("a".repeat(32), e => errors.push(e.message));
    const first = writer.send({ type: "text", text: "submit-once" });
    await Promise.resolve();
    const queued = writer.send({ type: "text", text: "stale-input" });
    reject(new Error("Connection lost after send")); await first; await queued;
    await writer.send({ type: "text", text: "must-not-send" });
    await writer.send({ type: "navigate", url: "https://example.test/" }, true);
    assert.equal(errors.length, 1); assert.deepEqual(seen.map(x => x.type), ["text", "navigate"]);
    await writer.stop();
  } finally { globalThis.fetch = original; }
});
