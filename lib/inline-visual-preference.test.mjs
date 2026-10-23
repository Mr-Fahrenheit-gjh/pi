import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { INLINE_VISUAL_STORAGE_KEY: key, getInlineVisualsEnabled, setInlineVisualsEnabled, subscribeInlineVisuals } = await jiti.import("./inline-visual-preference.ts");

test("inline diagrams default on and synchronize saved, same-page and cross-tab changes", t => {
  const original = globalThis.window;
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  delete globalThis.window;
  assert.equal(getInlineVisualsEnabled(), true);
  const storage = new Map();
  const handlers = new Map();
  globalThis.window = {
    localStorage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) },
    addEventListener: (event, listener) => handlers.set(event, listener),
    removeEventListener: event => handlers.delete(event),
  };
  assert.equal(getInlineVisualsEnabled(), true);
  const observed = [];
  const unsubscribe = subscribeInlineVisuals(() => observed.push(getInlineVisualsEnabled()));
  setInlineVisualsEnabled(false);
  assert.equal(storage.get(key), "false");
  assert.equal(getInlineVisualsEnabled(), false);
  assert.deepEqual(observed, [false]);
  storage.set(key, "true");
  handlers.get("storage")({ key });
  assert.deepEqual(observed, [false, true]);
  handlers.get("storage")({ key: "unrelated" });
  assert.equal(observed.length, 2);
  storage.clear();
  handlers.get("storage")({ key: null });
  assert.equal(observed.at(-1), true);
  unsubscribe();
  assert.equal(handlers.size, 0);
});

test("readable but unwritable storage does not override the page-local choice", t => {
  const original = globalThis.window;
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  globalThis.window = { localStorage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } } };
  setInlineVisualsEnabled(false);
  assert.equal(getInlineVisualsEnabled(), false);
});

test("blocked storage still allows the current page to disable diagrams", t => {
  const original = globalThis.window;
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  globalThis.window = { get localStorage() { throw new Error("Storage blocked"); } };
  assert.doesNotThrow(() => setInlineVisualsEnabled(false));
  assert.equal(getInlineVisualsEnabled(), false);
  setInlineVisualsEnabled(true);
  assert.equal(getInlineVisualsEnabled(), true);
});
