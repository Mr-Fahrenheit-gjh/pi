import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { SessionReadClient } = await createJiti(import.meta.url).import("./session-read-client.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetch, legacy = []) {
  const requests = [], errors = [], migrations = [];
  const client = new SessionReadClient({ fetch: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return fetch(body);
  }, legacyIds: () => legacy, migrated: () => migrations.push(true), changed() {}, failed: () => errors.push(true) });
  return { client, requests, errors, migrations };
}
const response = (revision, unread = {}) => ({ ok: true, json: async () => ({ state: { revision, unread } }) });
test("only selected visible focused session reads, failures are not retried by polls/focus", async () => {
  const { client, requests, errors } = fixture(() => ({ ok: false, status: 401 }));
  client.noteRunning({ sessionReadState: { revision: 2, unread: { selected: 2, other: 1 } } });
  client.autoRead("selected", false, true); client.autoRead("selected", true, false); client.autoRead(null, true, true);
  await turn(); assert.equal(requests.length, 0);
  client.autoRead("selected", true, true); await turn();
  assert.deepEqual(requests, [{ action: "read", entries: [{ id: "selected", token: 2 }] }]);
  client.noteRunning({ sessionReadState: { revision: 2, unread: { selected: 2, other: 1 } } });
  client.attentionChanged(); client.autoRead("selected", true, true); await turn();
  assert.equal(requests.length, 1); assert.equal(errors.length, 1);
  assert.equal(client.snapshot.unread.selected, 2); assert.equal(client.mode, "shared");
});
test("queued reads capture observed tokens and late POST snapshots never regress", async () => {
  let release;
  const { client, requests } = fixture(() => new Promise(resolve => { release = resolve; }));
  client.noteRunning({ sessionReadState: { revision: 1, unread: { s: 1 } } });
  const pending = client.mark(["s"], true); await turn();
  client.noteRunning({ sessionReadState: { revision: 3, unread: { s: 3 } } });
  release(response(2)); await pending;
  assert.equal(requests[0].entries[0].token, 1);
  assert.equal(client.snapshot.unread.s, 3);
  client.noteRunning({ sessionReadState: { revision: 0, unread: {} } });
  assert.equal(client.snapshot.revision, 3);
});
test("migration uses import once, never treats transport/auth/malformed responses as unsupported", async () => {
  const { client, requests, migrations } = fixture(() => response(4, { legacy: 4 }), ["legacy"]);
  client.noteEligible(["legacy"]);
  client.transportFailed(); assert.equal(client.mode, "unknown");
  client.noteRunning({ sessionReadState: null }); assert.equal(client.mode, "shared");
  client.noteRunning({}); assert.equal(client.mode, "shared");
  client.noteRunning({ sessionReadState: { revision: 3, unread: {} } }); await turn();
  assert.deepEqual(requests, [{ action: "import", ids: ["legacy"] }]); assert.equal(migrations.length, 1);
  client.noteRunning({ sessionReadState: { revision: 5, unread: {} } }); await turn(); assert.equal(requests.length, 1);
  const legacy = fixture(() => { throw Error("offline"); }).client;
  legacy.noteRunning({ runningSessionIds: [] }); assert.equal(legacy.mode, "legacy");
  legacy.transportFailed(); assert.equal(legacy.mode, "legacy");
});
test("migration waits for full catalogue eligibility and never prunes shared authority", async () => {
  const { client, requests, migrations } = fixture(() => response(4, { parent: 4 }), ["child", "deleted", "parent"]);
  client.noteRunning({ sessionReadState: { revision: 3, unread: { shared: 3 } } });
  await turn(); assert.equal(requests.length, 0, "no import before a complete catalogue");
  client.noteEligible(["parent"]);
  await turn();
  assert.deepEqual(requests, [{ action: "import", ids: ["parent"] }]);
  assert.equal(migrations.length, 1);
  client.noteRunning({ sessionReadState: { revision: 5, unread: { shared: 5 } } });
  client.noteEligible([]);
  assert.deepEqual(client.snapshot.unread, { shared: 5 }, "catalogue filtering is migration-only");
});

test("poll errors deduplicate until recovery while every explicit failure reports again", async () => {
  const { client, errors } = fixture(() => ({ ok: false, status: 503 }));
  client.transportFailed(); client.transportFailed();
  assert.equal(errors.length, 1);
  client.noteRunning({ sessionReadState: { revision: 1, unread: {} } });
  client.transportFailed(); assert.equal(errors.length, 2);
  await client.mark(["s"], false); await client.mark(["s"], false);
  assert.equal(errors.length, 4);
});

test("refused explicit unread does not suppress a later completion or retry the refused write", async () => {
  const { client, requests } = fixture(body => body.action === "unread" ? { ok: false, status: 503 } : response(3));
  client.noteRunning({ sessionReadState: { revision: 1, unread: {} } });
  assert.equal(await client.mark(["s"], false), false);
  client.noteRunning({ sessionReadState: { revision: 2, unread: { s: 2 } } });
  client.autoRead("s", true, true); await turn();
  assert.deepEqual(requests.map(r => r.action), ["unread", "read"]);
  assert.equal(requests[1].entries[0].token, 2);
});

test("ambiguous unread preserves one reconciled token, not every future completion", async () => {
  const { client, requests } = fixture(body => {
    if (body.action === "unread") throw Error("lost response");
    return response(5);
  });
  client.noteRunning({ sessionReadState: { revision: 1, unread: {} } });
  await client.mark(["s"], false);
  client.noteRunning({ sessionReadState: { revision: 2, unread: { s: 2 } } });
  client.autoRead("s", true, true); await turn(); assert.equal(requests.length, 1);
  client.noteRunning({ sessionReadState: { revision: 4, unread: { s: 4 } } });
  client.autoRead("s", true, true); await turn();
  assert.deepEqual(requests.map(r => r.action), ["unread", "read"]);
  assert.equal(requests[1].entries[0].token, 4);
});

test("an ambiguous response after a newer poll reconciles once and releases future tokens", async () => {
  let reject;
  const { client, requests } = fixture(body => body.action === "unread"
    ? new Promise((_, fail) => { reject = fail; }) : response(5));
  client.noteRunning({ sessionReadState: { revision: 1, unread: {} } });
  const pending = client.mark(["s"], false); await turn();
  client.noteRunning({ sessionReadState: { revision: 2, unread: { s: 2 } } });
  client.autoRead("s", true, true); await turn(); assert.equal(requests.length, 1);
  reject(Error("response lost")); await pending;
  client.autoRead("s", true, true); await turn(); assert.equal(requests.length, 1);
  client.noteRunning({ sessionReadState: { revision: 4, unread: { s: 4 } } });
  client.autoRead("s", true, true); await turn();
  assert.deepEqual(requests.map(r => r.action), ["unread", "read"]);
});

test("explicit unread remains until attention changes, but a new completion can auto-read", async () => {
  let revision = 1;
  const { client, requests } = fixture(body => body.action === "unread" ? response(++revision, { s: revision }) : response(++revision));
  client.noteRunning({ sessionReadState: { revision: 1, unread: {} } });
  await client.mark(["s"], false);
  client.autoRead("s", true, true); await turn(); assert.equal(requests.length, 1);
  client.attentionChanged(); client.autoRead("s", true, true); await turn(); assert.equal(requests.length, 2);
  await client.mark(["s"], false);
  client.noteRunning({ sessionReadState: { revision: 20, unread: { s: 20 } } });
  client.autoRead("s", true, true); await turn(); assert.equal(requests.at(-1).entries[0].token, 20);
});
