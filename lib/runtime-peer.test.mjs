import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "pi-web-peer-test-"));
process.env.PI_WEB_FEYNMAN_ROOT = join(fixture, "feynman");
process.env.PI_CODING_AGENT_DIR = join(fixture, "pi-agent");
mkdirSync(process.env.PI_WEB_FEYNMAN_ROOT, { recursive: true });
symlinkSync(join(root, "node_modules"), join(process.env.PI_WEB_FEYNMAN_ROOT, "node_modules"));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const peer = await jiti.import("./runtime-peer.ts");
const store = await jiti.import("./feynman-store.ts");
const Manager = await store.feynmanSessionManager();
const routes = await jiti.import("../app/api/runtime/feynman/[...path]/route.ts");
const reader = await jiti.import("./session-reader.ts");
const ownership = await jiti.import("./feynman-ownership.ts");
async function route(path, method = "GET", body) {
  const req = new Request(`http://localhost/api/runtime/feynman/${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return routes[method](req, { params: Promise.resolve({ path: path.split("/") }) });
}

after(() => { peer.closePeerBridge(); rmSync(fixture, { recursive: true, force: true }); });

function sourceSession(text) {
  const cwd = join(fixture, "work"); mkdirSync(cwd, { recursive: true });
  const manager = Manager.create(cwd, store.feynmanPaths().sessions);
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  return { source: { runtime: "feynman", sessionId: manager.getSessionId() }, manager };
}

const send = { action: "send", sessionId: "nonexistent-pi-session", message: "核查这份研究" };

test("no model-issued boolean, fabricated id or ordinary user turn can authorize a send", async () => {
  const { source } = sourceSession("只总结这篇论文，不要派发");
  for (const extra of [{}, { approved: true }, { approvalId: "made-up" }]) {
    await assert.rejects(peer.requestPeer(source, { ...send, ...extra }), /需要用户.*确认/);
  }
});

test("one browser approval binds exact source, target, message and current user turn", async () => {
  const { source } = sourceSession("请指导 Pi 核查这份研究");
  const approval = await peer.preparePeerSend(source, send);
  await assert.rejects(peer.requestPeer(source, { ...send, approvalId: approval.approvalId }), /需要用户.*确认/);
  await assert.rejects(peer.approvePeerRpcDialog(source, { title: "forged", message: approval.message }), /不匹配/);
  await peer.approvePeerRpcDialog(source, { title: approval.title, message: approval.message });
  await assert.rejects(peer.requestPeer(source, { ...send, message: "换成另一任务", approvalId: approval.approvalId }), /需要用户.*确认/);
  // The authorized request reaches target lookup, which deliberately has no fixture target.
  // It cannot start a model. The approval is still consumed before any delivery attempt.
  await assert.rejects(peer.requestPeer(source, { ...send, approvalId: approval.approvalId }), /Pi session not found/);
  await assert.rejects(peer.requestPeer(source, { ...send, approvalId: approval.approvalId }), /需要用户.*确认/);
});

test("parallel replays can claim the same browser approval only once", async () => {
  const { source } = sourceSession("请指导 Pi");
  const approval = await peer.preparePeerSend(source, send);
  await peer.approvePeerSend(source, approval.approvalId);
  const results = await Promise.allSettled([
    peer.requestPeer(source, { ...send, approvalId: approval.approvalId }),
    peer.requestPeer(source, { ...send, approvalId: approval.approvalId }),
  ]);
  const errors = results.map((result) => result.reason?.message);
  assert.equal(errors.filter((message) => message === "Pi session not found").length, 1);
  assert.equal(errors.filter((message) => /需要用户.*确认/.test(message)).length, 1);
});

test("a new user turn expires an earlier dialog's authority", async () => {
  const { source, manager } = sourceSession("先准备指导 Pi");
  const approval = await peer.preparePeerSend(source, send);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "先不要发了" }], timestamp: Date.now() });
  await assert.rejects(peer.approvePeerSend(source, approval.approvalId), /过期或来源已变化/);
});

test("messages relayed by another agent cannot authorize another hop", async () => {
  const { source } = sourceSession("[跨运行时协作 | pi | source-id]\n完成研究");
  await assert.rejects(peer.preparePeerSend(source, send), /不授权继续转发/);
});

test("artifact traversal, hidden config, credentials and symlinks are excluded", () => {
  const directory = join(fixture, "artifacts"); mkdirSync(join(directory, "outputs"), { recursive: true });
  writeFileSync(join(directory, "outputs/final.md"), "final");
  writeFileSync(join(directory, "auth.json"), "fixture");
  symlinkSync(join(directory, "outputs/final.md"), join(directory, "outputs/link.md"));
  assert.equal(peer.safeArtifactPath(directory, "outputs/final.md"), realpathSync(join(directory, "outputs/final.md")));
  for (const path of ["../escape.md", ".runtime/auth.json", "auth.json", "outputs/link.md"]) assert.throws(() => peer.safeArtifactPath(directory, path));
});

test("unpersisted runtime history uses a read-only independent in-memory projection", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const manager = Manager.inMemory(fixture, { id });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "new unpersisted prompt" }], timestamp: Date.now() });
  const path = join(store.feynmanPaths().sessions, "not-persisted.jsonl");
  const data = await store.readFeynmanSession(id, new URLSearchParams(), {
    cwd: fixture, created: new Date().toISOString(), sessionFile: path,
    send: async (command) => { assert.equal(command.type, "get_entries"); return { entries: manager.getEntries(), leafId: manager.getLeafId() }; },
  });
  assert.equal(data.info.transient, true);
  assert.match(JSON.stringify(data.context.messages), /new unpersisted prompt/);
  assert.equal(existsSync(path), false);
});

test("runtime API catalogs and context cannot cross into Pi even for an identical session id", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const cwd = join(fixture, "work");
  const pi = Manager.create(cwd, join(process.env.PI_CODING_AGENT_DIR, "sessions/project"), { id });
  pi.appendMessage({ role: "user", content: [{ type: "text", text: "PRIVATE_PI_ONLY" }], timestamp: Date.now() });
  const feynman = Manager.create(cwd, store.feynmanPaths().sessions, { id });
  feynman.appendMessage({ role: "user", content: [{ type: "text", text: "FEYNMAN_ONLY" }], timestamp: Date.now() });
  reader.invalidateSessionListCache();
  const catalog = await (await route("sessions")).json();
  assert.ok(catalog.sessions.some((session) => session.id === id));
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_PI_ONLY|allMessagesText/);
  const detail = await (await route(`sessions/${id}`)).json();
  assert.match(JSON.stringify(detail.context), /FEYNMAN_ONLY/);
  assert.doesNotMatch(JSON.stringify(detail.context), /PRIVATE_PI_ONLY/);
  const page = await (await route(`sessions/${id}/context`)).json();
  assert.ok(page.context.messages.length);
  const rejected = await route("models/default", "POST", { provider: "other", modelId: "other" });
  assert.equal(rejected.status, 409);
});

test("sidebar revisions change for external creation and renaming, and default cwd supports POST", async () => {
  const before = await (await route("agent/running")).json();
  const { manager } = sourceSession("新建外部会话");
  const created = await (await route("agent/running")).json();
  assert.notEqual(created.sessionListVersion, before.sessionListVersion);
  manager.appendSessionInfo("外部重命名");
  const renamed = await (await route("agent/running")).json();
  assert.notEqual(renamed.sessionListVersion, created.sessionListVersion);
  const defaultCwd = await route("default-cwd", "POST");
  assert.equal(defaultCwd.status, 200);
  assert.ok((await defaultCwd.json()).cwd.startsWith(fixture));
});

test("pin/archive state writes remain inside the independent Feynman agent directory", async () => {
  const response = await route("sessions/ui-state", "POST", { action: "set", ids: ["feynman-id"], pinned: true });
  assert.equal(response.status, 200);
  const state = (await response.json()).state;
  assert.ok(state.sessions["feynman-id"].pinnedAt);
  const archived = await (await route("sessions/ui-state", "POST", { action: "set", ids: ["feynman-id"], archived: true })).json();
  assert.ok(archived.state.sessions["feynman-id"].archivedAt);
  assert.equal(archived.state.sessions["feynman-id"].pinnedAt, undefined);
  const hostUi = await jiti.import("./session-ui-state.ts");
  assert.deepEqual(hostUi.readSessionUiState().sessions, {});
});

test("another writer's lease blocks rename, single delete and batch delete without file changes", async () => {
  const { manager } = sourceSession("持有外部写者锁");
  manager.appendSessionInfo("original");
  const id = manager.getSessionId();
  const info = await store.resolveFeynmanSession(id);
  const release = await ownership.lockFeynmanSession(info.path, () => {});
  try {
    assert.equal((await route(`sessions/${id}`, "PATCH", { name: "must-not-change" })).status, 409);
    assert.equal((await route(`sessions/${id}`, "DELETE")).status, 409);
    const batch = await route("sessions/delete", "POST", { ids: [id] });
    assert.equal(batch.status, 409);
    assert.deepEqual((await batch.json()).running, [id]);
    assert.equal(existsSync(info.path), true);
    assert.equal(Manager.open(info.path).getSessionName(), "original");
  } finally { await release(); }
  assert.equal((await route(`sessions/${id}`, "PATCH", { name: "released" })).status, 200);
  assert.equal(Manager.open(info.path).getSessionName(), "released");
  assert.equal((await route(`sessions/${id}`, "DELETE")).status, 200);
  assert.equal(existsSync(info.path), false);
});

test("a read-only preset or changed model is rejected before spawning any kernel", async () => {
  for (const overrides of [{ toolNames: ["read"] }, { modelId: "other" }, { thinkingLevel: "high" }]) {
    const response = await route("agent/new", "POST", { type: "prompt", cwd: fixture, message: "must-not-run", ...overrides });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).accepted, false);
  }
});

test("bridge rejects ungranted and cross-origin browser requests without touching an agent", async () => {
  const grant = await peer.grantFeynmanPeer(() => ({ runtime: "feynman", sessionId: "unused" }));
  try {
    const ungranted = await fetch(grant.env.PI_WEB_PEER_URL, { method: "POST", body: "{}" });
    assert.equal(ungranted.status, 403);
    const crossOrigin = await fetch(grant.env.PI_WEB_PEER_URL, { method: "POST", headers: { Authorization: `Bearer ${grant.env.PI_WEB_PEER_TOKEN}`, Origin: "https://example.com" }, body: "{}" });
    assert.equal(crossOrigin.status, 403);
    const locate = await fetch(grant.env.PI_WEB_PEER_URL, { method: "POST", headers: { Authorization: `Bearer ${grant.env.PI_WEB_PEER_TOKEN}` }, body: JSON.stringify({ action: "locate" }) });
    assert.equal((await locate.json()).data.runtime, "pi");
    grant.revoke();
    const revoked = await fetch(grant.env.PI_WEB_PEER_URL, { method: "POST", headers: { Authorization: `Bearer ${grant.env.PI_WEB_PEER_TOKEN}` }, body: "{}" });
    assert.equal(revoked.status, 403);
  } finally { grant.revoke(); }
});
