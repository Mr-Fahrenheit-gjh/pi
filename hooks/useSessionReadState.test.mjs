import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { renderHook } from "./__fixtures__/react-hook-shim.mjs";
const jiti = createJiti(import.meta.url, { alias: { react: fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url)) }, tsconfigPaths: true });
const { useSessionReadState } = await jiti.import("./useSessionReadState.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, legacy = []) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => false });
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push(JSON.parse(init.body)); return { ok: false, status: 503 }; };
  const save = () => {};
  const hook = renderHook(() => useSessionReadState(null, () => new Set(legacy), save));
  t.after(() => { hook.unmount(); Object.assign(globalThis, previous); });
  return { hook, requests };
}
test("AppShell visibility wiring covers mobile workspace and desktop expansion without hiding a normal split", () => {
  const source = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const expression = source.match(/conversationVisible=\{([^}]+)\}/)?.[1];
  assert.ok(expression);
  const visible = new Function("rightPanelFullWidth", "isMobile", "rightPanelOpen", `return ${expression}`);
  assert.equal(visible(false, true, true), false);
  assert.equal(visible(false, true, false), true);
  assert.equal(visible(true, false, true), false);
  assert.equal(visible(false, false, true), true);
  assert.match(source, /selectedSessionId=\{secondaryActive \? splitContext.sessionId : selectedSession\?\.id/);
});

test("a second explicit failure produces a new notification generation after recovery", async t => {
  const { hook } = fixture(t);
  hook.result.transportFailed(); hook.flush();
  const first = hook.result.syncFailures;
  hook.result.noteRunning({ sessionReadState: { revision: 1, unread: {} } }); hook.flush();
  hook.result.mark(["s"], true); await turn(); hook.flush();
  const second = hook.result.syncFailures;
  assert.notEqual(second, first, "a dismissed toast can be shown again");
  hook.result.mark(["s"], false); await turn(); hook.flush();
  assert.notEqual(hook.result.syncFailures, second);
});
test("catalogue eligibility before protocol discovery filters legacy without mutating shared state", async t => {
  const { hook, requests } = fixture(t, ["child", "deleted", "parent"]);
  hook.result.noteEligible(["parent"]); hook.flush();
  hook.result.noteRunning({ sessionReadState: { revision: 1, unread: { shared: 1 } } });
  await turn(); hook.flush();
  assert.deepEqual(requests, [{ action: "import", ids: ["parent"] }]);
  hook.result.noteEligible([]); hook.flush();
  assert.deepEqual([...hook.result.unreadSessionIds], ["shared"]);
});
