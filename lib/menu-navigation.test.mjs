import assert from "node:assert/strict";
import test from "node:test";
import { createMenuNavigation, loadMenuSession, menuAcknowledgement, menuReadyHash, menuSessionInfo, parseMenuFragment } from "./menu-navigation.ts";

const page = "01234567-89ab-4cde-8fab-0123456789ab";
const otherPage = "11234567-89ab-4cde-8fab-0123456789ab";
const nonce = (n = 0) => `abcdef01-2345-4678-9abc-${String(n).padStart(12, "0")}`;
const requestHash = (session = "target", request = nonce(), identity = page) => `#${new URLSearchParams({ "pi-menu": "1", page: identity, request, session })}`;
const info = (id = "target") => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/work", created: "2026-01-01", modified: "2026-01-01", messageCount: 2, firstMessage: "Hello", projectKey: "/work" });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ cached = null, load = async (id) => info(id), pathname = "/", identity = { page, handled: new Set() } } = {}) {
  let url = new URL(`https://pi.example${pathname}?session=old&cwd=%2Fstale&sidebar=closed&extra=1&extra=2`);
  const selected = [], reads = [], replaced = [];
  const bridge = createMenuNavigation({
    identity,
    readUrl: () => new URL(url),
    replaceUrl: (next) => { url = new URL(next); replaced.push(next.href); },
    cachedSession: () => cached,
    loadSession: (id, signal) => { reads.push({ id, signal }); return load(id, signal); },
    selectSession: (session) => { selected.push(session); bridge.invalidate(); },
  });
  return { bridge, selected, reads, replaced, identity, get url() { return url; }, setUrl(next) { url = new URL(next); },
    request(session, request, identity) { url.hash = requestHash(session, request, identity); return bridge.handleHashChange(); },
  };
}

test("v1 ready, request and ack use exact field sets and URLSearchParams decoding", () => {
  assert.deepEqual(parseMenuFragment(menuReadyHash(page)), { kind: "ready", page });
  assert.deepEqual(parseMenuFragment(requestHash("a._-Z0")), { kind: "request", page, request: nonce(), session: "a._-Z0" });
  assert.equal(parseMenuFragment(requestHash().replace("target", "%74arget")).session, "target");
  assert.equal(parseMenuFragment(`#pi-menu=1&page=${page}&ack=${nonce()}`).kind, "ack");
  assert.ok(parseMenuFragment(requestHash("a".repeat(200))));
});

test("reject malformed versions, UUIDs, fields, duplicates and session IDs", () => {
  for (const hash of ["", "#elsewhere", `#page=${page}`, menuReadyHash(page).replace("=1", "=2"),
    `${menuReadyHash(page)}&extra=1`, `${menuReadyHash(page)}&page=${page}`, `${requestHash()}&session=target`,
    `${requestHash()}&ack=${nonce()}`, `${requestHash()}&unknown=1`, requestHash().replace(page, "not-a-uuid"),
    requestHash().replace(nonce(), "not-a-uuid"), `${menuReadyHash(page)}&request=${nonce()}`,
    ...["", ".hidden", "a/b", "a b", "a?b", "a#b", "a%2Fb", "汉字", "a".repeat(201)].map((id) => requestHash(id)),
  ]) assert.equal(parseMenuFragment(hash), null, hash);
});

test("ack removes all cwd/session parameters but preserves unrelated query, origin and path", () => {
  const source = new URL(`https://pi.example/?cwd=a&session=old&session=older&cwd=b&sidebar=closed&x=1&x=2${requestHash()}`);
  const ack = menuAcknowledgement(source, page, nonce(), "target");
  assert.deepEqual([...ack.searchParams], [["sidebar", "closed"], ["x", "1"], ["x", "2"], ["session", "target"]]);
  assert.equal(ack.origin, source.origin);
  assert.equal(ack.pathname, "/");
  assert.deepEqual(parseMenuFragment(ack.hash), { kind: "ack", page, ack: nonce() });
  assert.equal(source.searchParams.get("session"), "old");
});

test("only matching, structurally valid SessionInfo is accepted", () => {
  const valid = info();
  assert.equal(menuSessionInfo(valid, "target"), valid);
  for (const value of [null, {}, { ...valid, id: "other" }, { ...valid, cwd: "" }, { ...valid, cwd: 1 },
    { ...valid, path: undefined }, { ...valid, messageCount: NaN }, { ...valid, messageCount: 1.5 },
    { ...valid, projectKey: {} }, { ...valid, transient: "true" }, { ...valid, relation: {} },
    { ...valid, relation: { kind: "subagent", status: "bogus" } }]) {
    assert.equal(menuSessionInfo(value, "target"), null);
  }
});

test("readiness is root-only, preserves unrelated/invalid/request hashes, and replaces old ready/ack identities", () => {
  for (const hash of ["#section", "#pi-menu=2", requestHash(), `${menuReadyHash(page)}&unknown=1`]) {
    const f = fixture(); f.url.hash = hash; f.bridge.announce(); assert.equal(f.url.hash, hash);
  }
  for (const hash of ["", menuReadyHash(otherPage), `#pi-menu=1&page=${otherPage}&ack=${nonce()}`]) {
    const f = fixture(); f.url.hash = hash; f.bridge.announce(); assert.equal(f.url.hash, menuReadyHash(page));
  }
  const other = fixture({ pathname: "/feynman" });
  other.bridge.announce(); assert.equal(other.url.hash, "");
});

test("cached metadata selects and acknowledges synchronously without a GET", async () => {
  const cached = info(); const f = fixture({ cached });
  const finished = f.request("target");
  assert.deepEqual(f.selected, [cached]);
  assert.equal(f.reads.length, 0);
  assert.equal(parseMenuFragment(f.url.hash).ack, nonce());
  assert.equal(f.url.searchParams.get("session"), "target");
  assert.deepEqual(f.replaced.map((url) => parseMenuFragment(new URL(url).hash).kind), ["ack"], "successful selection must not publish an intermediate ready marker");
  f.bridge.queryChanged(); // Next observes replaceState, but native still needs the ack.
  assert.equal(parseMenuFragment(f.url.hash).kind, "ack");
  await finished;
});

test("metadata GET stays same-origin, carries ordinary auth and refuses HTTP failures/malformed responses", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetcher = async (url, options) => {
    calls += 1;
    assert.equal(url, "/api/sessions?summary=1");
    assert.deepEqual(options, { signal: controller.signal, cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error" });
    return Response.json({ sessions: [info("other"), info()] });
  };
  assert.deepEqual(await loadMenuSession("target", controller.signal, fetcher), info());
  assert.equal(calls, 1);
  for (const status of [401, 403, 404, 500]) {
    assert.equal(await loadMenuSession("target", controller.signal, async () => Response.json({ sessions: [info()] }, { status })), null);
  }
  for (const body of [null, {}, { sessions: "invalid" }, { sessions: [null, 42, {}] }]) {
    assert.ok(await loadMenuSession("target", controller.signal, async () => Response.json(body)) == null);
  }
});

test("queued hash/popstate events neither cancel the newest read nor erase its ack", async () => {
  const delayed = deferred(); const f = fixture({ load: () => delayed.promise });
  const pending = f.request("target");
  await f.bridge.handleHashChange();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].signal.aborted, false);
  delayed.resolve(info()); await pending;
  await f.bridge.handleHashChange();
  assert.equal(parseMenuFragment(f.url.hash).ack, nonce());
});

test("a late query effect for the previous ack cannot cancel a newer hash request", async () => {
  const delayed = deferred(); const f = fixture({ load: (id) => id === "new" ? delayed.promise : Promise.resolve(info(id)) });
  await f.request("target");
  const pending = f.request("new", nonce(2)); f.bridge.queryChanged();
  delayed.resolve(info("new")); await pending;
  assert.deepEqual(f.selected.map((session) => session.id), ["target", "new"]);
});

test("fallback resolution is necessary only for uncached sessions", async () => {
  const f = fixture(); await f.request("target");
  assert.equal(f.reads.length, 1);
  assert.equal(f.selected[0].id, "target");
});

test("missing, malformed, unauthorized and failed metadata never select or ack", async () => {
  for (const load of [async () => null, async () => ({}), async () => info("wrong"), async () => { throw new Error("401/403/network"); }]) {
    const f = fixture({ load }); await f.request("target");
    assert.deepEqual(f.selected, []); assert.equal(parseMenuFragment(f.url.hash).kind, "request");
  }
});

test("wrong document, non-root paths and replayed request IDs are ignored", async () => {
  const f = fixture(); await f.request("target", nonce(), otherPage); assert.equal(f.reads.length, 0);
  await f.request("target", nonce()); await f.request("different", nonce());
  await f.request("different", nonce().toUpperCase());
  assert.equal(f.selected.length, 1); assert.equal(f.reads.length, 1);
  const other = fixture({ pathname: "/feynman" }); await other.request("target"); assert.equal(other.reads.length, 0);
  const remount = fixture({ identity: f.identity }); await remount.request("target", nonce()); assert.equal(remount.reads.length, 0);
});

test("newest request wins even when aborted reads resolve later", async () => {
  const old = deferred(); const latest = deferred();
  const f = fixture({ load: (id) => id === "old" ? old.promise : latest.promise });
  const first = f.request("old", nonce(1)); const second = f.request("new", nonce(2));
  assert.equal(f.reads[0].signal.aborted, true);
  latest.resolve(info("new")); await second; old.resolve(info("old")); await first;
  assert.deepEqual(f.selected.map((s) => s.id), ["new"]);
  assert.equal(parseMenuFragment(f.url.hash).ack, nonce(2));
});

test("internal selection, same-session selection, disposal and user navigation invalidate pending work", async () => {
  for (const cancel of [
    (f) => f.bridge.invalidate(),
    (f) => f.bridge.dispose(),
    (f) => { f.url.hash = "#unrelated"; },
    (f) => { f.url.searchParams.set("session", "user-choice"); f.bridge.queryChanged(); },
    (f) => { f.url.pathname = "/feynman"; },
  ]) {
    const delayed = deferred(); const f = fixture({ load: () => delayed.promise });
    const pending = f.request("target"); cancel(f); const afterCancel = f.url.href;
    delayed.resolve(info()); await pending;
    assert.deepEqual(f.selected, []); assert.equal(f.url.href, afterCancel);
  }
});

test("same-session user navigation cancels an uncached request and allows the next menu request", async () => {
  const delayed = deferred();
  const f = fixture({ load: (id) => id === "target" ? delayed.promise : Promise.resolve(info(id)) });
  const before = f.url.search;
  const pending = f.request("target");
  f.bridge.cancelForNavigation(); // The current-session handler returns without changing the query.
  assert.equal(f.url.hash, menuReadyHash(page));
  assert.equal(f.url.search, before, "cancellation changes only the owned request fragment");
  assert.equal(f.reads[0].signal.aborted, true);
  await f.request("next", nonce(2));
  const nextUrl = f.url.href;
  delayed.resolve(info()); await pending;
  assert.deepEqual(f.selected.map((session) => session.id), ["next"]);
  assert.equal(f.url.href, nextUrl);
  assert.equal(parseMenuFragment(f.url.hash).ack, nonce(2));
});

test("user selection consumes the current owned request even before its hash event runs", async () => {
  for (const withOlderPending of [false, true]) {
    const delayed = deferred();
    const f = fixture({ load: (id) => id === "target" ? delayed.promise : Promise.resolve(info(id)) });
    const pending = withOlderPending ? f.request("target") : Promise.resolve();
    f.url.hash = requestHash("new", nonce(2));
    f.url.searchParams.set("session", "user-picked");
    f.bridge.cancelForNavigation(); // User clicked the visible session, with no router update.
    assert.equal(f.url.hash, menuReadyHash(page));
    assert.equal(f.url.searchParams.get("session"), "user-picked");
    await f.bridge.handleHashChange();
    delayed.resolve(info()); await pending;
    assert.deepEqual(f.selected, [], "neither old metadata nor queued hash events override the user");
    await f.request("new", nonce(2));
    assert.deepEqual(f.selected, [], "the cancelled nonce is consumed, including a replay");
    await f.request("after-user", nonce(3));
    assert.deepEqual(f.selected.map((session) => session.id), ["after-user"]);
    assert.equal(parseMenuFragment(f.url.hash).ack, nonce(3));
  }
});

test("explicit navigation cancellation never clears a foreign or unrelated URL", async () => {
  for (const move of [
    (f) => { f.url.hash = requestHash("target", nonce(), otherPage); },
    (f) => { f.url.hash = "#unrelated"; },
    (f) => { f.url.pathname = "/feynman"; },
  ]) {
    const delayed = deferred();
    const f = fixture({ load: (id) => id === "target" ? delayed.promise : Promise.resolve(info(id)) });
    const pending = f.request("target"); move(f);
    const movedUrl = f.url.href;
    f.bridge.cancelForNavigation();
    assert.equal(f.url.href, movedUrl, "only the exact owned URL can be replaced");
    delayed.resolve(info()); await pending;
    assert.deepEqual(f.selected, []);
    assert.equal(f.url.href, movedUrl);
  }
});

test("ordinary internal navigation wins after ready recovery, without a stale ack or query overwrite", async () => {
  const delayed = deferred(); const f = fixture({ load: () => delayed.promise });
  const pending = f.request("target");
  f.bridge.cancelForNavigation();
  assert.equal(f.url.hash, menuReadyHash(page));
  f.setUrl("https://pi.example/?session=user-picked&sidebar=closed");
  f.bridge.queryChanged();
  const pickedUrl = f.url.href;
  delayed.resolve(info()); await pending;
  assert.equal(f.url.href, pickedUrl);
  assert.equal(f.url.searchParams.get("session"), "user-picked");
  assert.equal(f.url.hash, menuReadyHash(page));
  assert.deepEqual(f.selected, []);
});

test("leaving and returning to the same request cannot revive it", async () => {
  const delayed = deferred(); const f = fixture({ load: () => delayed.promise });
  const pending = f.request("target");
  f.url.hash = "#unrelated"; await f.bridge.handleHashChange();
  await f.request("target"); delayed.resolve(info()); await pending;
  assert.deepEqual(f.selected, []);
});

test("ordinary query navigation reannounces the same document UUID; another tab is independent", async () => {
  const f = fixture(); const other = fixture({ identity: { page: otherPage, handled: new Set() } });
  other.bridge.announce(); const otherUrl = other.url.href;
  await f.request("target"); f.setUrl("https://pi.example/?session=user-picked"); f.bridge.queryChanged();
  assert.equal(f.url.hash, menuReadyHash(page)); assert.equal(other.url.href, otherUrl);
  f.setUrl("https://pi.example/?sidebar=closed&extra=1&extra=2&session=target"); f.bridge.queryChanged();
  assert.equal(f.url.hash, menuReadyHash(page), "returning to the ack's session still announces readiness");
});
