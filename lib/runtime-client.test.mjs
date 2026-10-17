import assert from "node:assert/strict";
import test from "node:test";
import { pageRuntime, runtimeApi, runtimeStorageKey, runtimeFetch } from "./runtime-client.mjs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { getTabOpen, setTabOpenSession } = await jiti.import("./tab-session.ts");

function memory() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; }

test("runtime identity is page-local and Pi URLs/storage remain unchanged", () => {
  assert.equal(pageRuntime("/"), "pi");
  assert.equal(pageRuntime("/feynman"), "feynman");
  assert.equal(pageRuntime("/feynman-wrong"), "pi");
  assert.equal(runtimeApi("/api/agent/new", "pi"), "/api/agent/new");
  assert.equal(runtimeApi("/api/agent/new", "feynman"), "/api/runtime/feynman/agent/new");
  assert.equal(runtimeApi("/api/models/default", "feynman"), "/api/runtime/feynman/models/default");
  assert.equal(runtimeApi("/api/sessions/ui-state", "feynman"), "/api/runtime/feynman/sessions/ui-state");
  assert.equal(runtimeApi("/api/runtime/feynman/agent/new", "feynman"), "/api/runtime/feynman/agent/new");
  assert.equal(runtimeApi("/api/files/tmp/out.md?type=raw", "feynman"), "/api/files/tmp/out.md?type=raw");
  assert.equal(runtimeApi("https://example.com/api/agent/new", "feynman"), "https://example.com/api/agent/new");
  assert.equal(runtimeStorageKey("pi-web:tab-open-session", "pi"), "pi-web:tab-open-session");
  assert.equal(runtimeStorageKey("pi-web:tab-open-session", "feynman"), "feynman:pi-web:tab-open-session");
});

test("switching runtimes remembers two independent selections in the same tab", () => {
  const original = globalThis.window;
  const storage = memory();
  try {
    globalThis.window = { location: { pathname: "/" }, sessionStorage: storage };
    setTabOpenSession("same-session-id");
    window.location.pathname = "/feynman";
    assert.equal(getTabOpen(), null);
    setTabOpenSession("feynman-session");
    window.location.pathname = "/";
    assert.deepEqual(getTabOpen(), { kind: "session", sessionId: "same-session-id" });
    window.location.pathname = "/feynman";
    assert.deepEqual(getTabOpen(), { kind: "session", sessionId: "feynman-session" });
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
});

test("same-origin absolute URLs and Request bodies cannot bypass runtime scoping", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.window = { location: { pathname: "/feynman", origin: "http://localhost:30159", href: "http://localhost:30159/feynman" } };
    globalThis.fetch = async (input) => { seen.push(input); return new Response("{}"); };
    await runtimeFetch(new URL("http://localhost:30159/api/sessions"));
    await runtimeFetch(new Request("http://localhost:30159/api/agent/new", { method: "POST", body: "message" }));
    await runtimeFetch("https://example.com/api/agent/new");
    assert.equal(seen[0], "http://localhost:30159/api/runtime/feynman/sessions");
    assert.equal(seen[1].url, "http://localhost:30159/api/runtime/feynman/agent/new");
    assert.equal(await seen[1].text(), "message");
    assert.equal(seen[2], "https://example.com/api/agent/new");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});

test("requests are scoped before dispatch; host utilities do not route through a kernel", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.window = { location: { pathname: "/feynman" } };
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response("{}"); };
    const init = { method: "POST", body: "test" };
    await runtimeFetch("/api/agent/new", init);
    window.location.pathname = "/";
    await runtimeFetch("/api/agent/new", init);
    assert.deepEqual(requests.map(({url}) => url), ["/api/runtime/feynman/agent/new", "/api/agent/new"]);
    assert.equal(requests[0].init, init);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});
