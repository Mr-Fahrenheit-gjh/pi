import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeRunningSendMode, setRunningSendMode, RUNNING_SEND_MODE_DEFAULT, RUNNING_SEND_MODE_STORAGE_KEY } = await jiti.import("./useRunningSendMode.ts");

test("steering is the default, and only the explicit follow-up preference opts into queuing", () => {
  assert.equal(RUNNING_SEND_MODE_DEFAULT, "steer");
  assert.equal(normalizeRunningSendMode("followup"), "followup");
  for (const value of [null, undefined, "", "steer", "followUp", "unknown", 0, {}]) assert.equal(normalizeRunningSendMode(value), "steer");
});

test("the running-send preference is a browser preference, not a model or server setting", () => {
  const previous = globalThis.window;
  const writes = [];
  globalThis.window = { localStorage: { setItem: (...args) => writes.push(args) } };
  try {
    setRunningSendMode("followup");
    setRunningSendMode("steer");
    assert.deepEqual(writes, [[RUNNING_SEND_MODE_STORAGE_KEY, "followup"], [RUNNING_SEND_MODE_STORAGE_KEY, "steer"]]);
  } finally { globalThis.window = previous; }
});

test("unavailable storage does not break changing the running-send preference", () => {
  const previous = globalThis.window;
  globalThis.window = { localStorage: { setItem() { throw new Error("blocked"); } } };
  try { assert.doesNotThrow(() => setRunningSendMode("steer")); }
  finally { globalThis.window = previous; }
});
