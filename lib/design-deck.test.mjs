import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { designDeckUrl, sameDesignDecks } = await jiti.import("./design-deck.ts");
const { createDesignDeckExtension, getDesignDecks } = await jiti.import("./design-deck-bridge.ts");

function host(sessionId) {
  const lifecycle = new Map(), listeners = new Map();
  const api = {
    on: (name, handler) => lifecycle.set(name, handler),
    events: {
      on: (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); },
      emit: (name, value) => listeners.get(name)?.(value),
    },
  };
  createDesignDeckExtension().factory(api);
  lifecycle.get("session_start")({}, { sessionManager: { getSessionId: () => sessionId } });
  return { emit: api.events.emit, stop: () => lifecycle.get("session_shutdown")() };
}
const url = "http://localhost:42001/?session=test-capability";

test("only a token-bearing local deck endpoint becomes a hosted URL", () => {
  assert.equal(designDeckUrl(url), "http://127.0.0.1:42001/?session=test-capability&embedded=1");
  for (const value of ["javascript:alert(1)", "https://example.com/?session=x", "http://localhost/?session=x",
    "http://user@localhost:42001/?session=x", "http://127.0.0.1:42001/admin?session=x",
    "http://127.0.0.1:42001/", null, {}, "http://localhost:42001/?session=x#foo"]) assert.equal(designDeckUrl(value), null);
});

test("host claims synchronously, isolates sessions and clears only its own deck", () => {
  const a = host("deck-a"), b = host("deck-b");
  try {
    const first = { url, title: "A" }, second = { url: url.replace("42001", "42002"), title: "B" };
    a.emit("design-deck:present", first); b.emit("design-deck:present", second);
    assert.equal(first.handled, true); assert.equal(second.handled, true);
    assert.equal(getDesignDecks().length, 2);
    assert.equal(new Set(getDesignDecks().map(d => d.id)).size, 2);
    a.emit("design-deck:closed", { url: second.url });
    assert.equal(getDesignDecks().length, 2);
    a.emit("design-deck:closed", { url });
    assert.deepEqual(getDesignDecks().map(d => d.sessionId), ["deck-b"]);
    b.stop();
    assert.deepEqual(getDesignDecks(), []);
  } finally { a.stop(); b.stop(); }
});

test("late shutdown from an old wrapper cannot clear its replacement", () => {
  const old = host("deck-reload"), next = host("deck-reload");
  try {
    old.emit("design-deck:present", { url });
    next.emit("design-deck:present", { url: url.replace("42001", "42002") });
    old.stop();
    assert.equal(getDesignDecks().length, 1);
    assert.match(getDesignDecks()[0].url, /42002/);
    const invalid = { url: "https://untrusted.test" };
    next.emit("design-deck:present", invalid);
    assert.equal(invalid.handled, undefined);
    assert.equal(getDesignDecks().length, 1);
  } finally { old.stop(); next.stop(); }
});

test("unchanged poll snapshots preserve presentation identity", () => {
  const a = [{ id: "id", sessionId: "session", url, title: "Deck" }];
  assert.equal(sameDesignDecks(a, structuredClone(a)), true);
  assert.equal(sameDesignDecks(a, []), false);
  for (const key of ["id", "sessionId", "url", "title"]) {
    assert.equal(sameDesignDecks(a, [{ ...a[0], [key]: "different" }]), false);
  }
});
