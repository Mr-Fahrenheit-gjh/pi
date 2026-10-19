import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatReleaseHandoff, validateReleaseEntry, parseReleaseSnapshot, MAX_ENTRY_BYTES } from "./pending-release-shared.mjs";
import { registerRelease, readReleaseSnapshot, updateRelease, markReleaseDeployed, releaseDirectory, DEFAULT_RELEASE_DIRECTORY, ReleaseConflictError } from "./pending-release-store.mjs";
import { createReleaseLoader } from "./pending-release-client.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/pending-release.mjs", import.meta.url));
function entry(overrides = {}) {
  return {
    schemaVersion: 1, id: randomUUID(), revision: 1, scope: "web", status: "pending",
    title: "测试用 Pi 改动", summary: "仅合成测试数据，不是真实登记。",
    sourceSessions: ["synthetic-session-id"], codeLocations: ["/synthetic/pi/code.ts @ abc123"],
    verification: ["node --test: passed (synthetic)"], releaseSteps: ["人工确认后按守卫上线"],
    rollback: ["恢复已保留备份"], dependencies: [], createdAt: "2026-10-17T10:00:00.000Z", ...overrides,
  };
}
async function fixture(t) {
  // macOS /tmp and /var are symlinks; use the canonical temp root for no-symlink tests.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-pending-release-"));
  const directory = path.join(root, "registry");
  const previous = process.env.PI_PENDING_RELEASE_DIR;
  process.env.PI_PENDING_RELEASE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_PENDING_RELEASE_DIR;
    else process.env.PI_PENDING_RELEASE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory };
}
async function run(directory, args) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { env: { ...process.env, PI_PENDING_RELEASE_DIR: directory }, timeout: 15000 });
    return { code: 0, ...result };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test("schema admits only verified Pi pending/deployed records and bounded evidence", () => {
  for (const scope of ["web", "extension", "memory", "config"]) assert.equal(validateReleaseEntry(entry({ scope })).scope, scope);
  const valid = entry();
  for (const changes of [
    { scope: "project" }, { scope: ["web"] }, { status: "draft" }, { status: "ready" }, { schemaVersion: 2 },
    { revision: 0 }, { id: "../escape" }, { title: " " }, { summary: "x".repeat(501) },
    { title: "bad\u0000title" }, { sourceSessions: [] }, { codeLocations: [] }, { verification: [] },
    { releaseSteps: [] }, { rollback: [] }, { verification: [42] }, { secret: "not allowed" },
    { dependencies: [valid.id] }, { dependencies: ["../path"] },
    { status: "deployed" }, { deployedAt: "2026-10-17T11:00:00.000Z" },
    { createdAt: "2026-02-31T10:00:00.000Z" }, { createdAt: "yesterday" },
    { status: "deployed", deployedAt: "2026-10-16T00:00:00.000Z" },
    { verification: Array(50).fill("x".repeat(4000)) },
  ]) assert.throws(() => validateReleaseEntry({ ...valid, ...changes }), /字段无效/);
  const dependency = randomUUID();
  assert.throws(() => validateReleaseEntry(entry({ dependencies: [dependency, dependency] })));
});

test("default and environment directory, missing reads never create", async (t) => {
  const { directory } = await fixture(t);
  assert.equal(releaseDirectory(), directory);
  assert.deepEqual(await readReleaseSnapshot(), { entries: [], warnings: [], pendingCount: 0 });
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  delete process.env.PI_PENDING_RELEASE_DIR;
  assert.equal(releaseDirectory(), DEFAULT_RELEASE_DIRECTORY); // Does not read the real shared directory.
  for (const bad of ["", "relative", "../relative"]) {
    process.env.PI_PENDING_RELEASE_DIR = bad;
    assert.throws(releaseDirectory, /绝对目录/);
  }
});

test("registration is private, exclusive, history retained and pending counts exclude deployed", async (t) => {
  const { directory } = await fixture(t);
  const first = entry(), second = entry({ scope: "memory" });
  await registerRelease(first); await registerRelease(second);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const file = path.join(directory, `${first.id}.json`);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await assert.rejects(registerRelease({ ...first, title: "do not overwrite" }), ReleaseConflictError);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), first);
  await assert.rejects(markReleaseDeployed(first.id, 7), ReleaseConflictError);
  const deployed = await markReleaseDeployed(first.id, 1);
  assert.equal(deployed.revision, 2); assert.ok(deployed.deployedAt);
  const snapshot = await readReleaseSnapshot();
  assert.equal(snapshot.entries.length, 2); assert.equal(snapshot.pendingCount, 1);
  assert.equal(snapshot.entries.find((e) => e.id === first.id).status, "deployed");
  await assert.rejects(markReleaseDeployed(first.id, 2), ReleaseConflictError);
  await assert.rejects(updateRelease(first.id, 2, { ...first, revision: 3 }), ReleaseConflictError);
  assert.ok((await readdir(directory)).every((name) => name.endsWith(".json")));
});

test("corrupt/unknown-version/oversize/nonregular entries warn, valid entries remain visible", async (t) => {
  const { directory } = await fixture(t);
  const valid = entry(); await registerRelease(valid);
  const bad = randomUUID(), unknown = randomUUID(), large = randomUUID(), mismatch = randomUUID(), folder = randomUUID();
  await writeFile(path.join(directory, `${bad}.json`), "PRIVATE-NOT-TO-BE-QUOTED");
  await writeFile(path.join(directory, `${unknown}.json`), JSON.stringify(entry({ id: unknown, schemaVersion: 999 })));
  await writeFile(path.join(directory, `${large}.json`), " ".repeat(MAX_ENTRY_BYTES + 1));
  await writeFile(path.join(directory, `${mismatch}.json`), JSON.stringify(entry()));
  await mkdir(path.join(directory, `${folder}.json`));
  await writeFile(path.join(directory, "not-a-uuid.json"), "private");
  const snapshot = await readReleaseSnapshot();
  assert.equal(snapshot.pendingCount, 1); assert.deepEqual(snapshot.entries, [valid]);
  assert.equal(snapshot.warnings.length, 6);
  assert.doesNotMatch(snapshot.warnings.join(""), /PRIVATE|private/);
  assert.doesNotMatch(snapshot.warnings.join(""), /\p{Script=Han}/u);
  assert.match(snapshot.warnings.join(""), /Skipped a non-UUID JSON file/);
  assert.match(snapshot.warnings.join(""), /could not be read or validated/);
  parseReleaseSnapshot(snapshot);
  await rm(path.join(directory, `${valid.id}.json`));
  const brokenOnly = await readReleaseSnapshot();
  assert.equal(brokenOnly.entries.length, 0); assert.ok(brokenOnly.warnings.length > 0);
});

test("symlink directories, entries, input and lock paths are refused without touching targets", async (t) => {
  const { root, directory } = await fixture(t);
  const target = path.join(root, "outside"); await mkdir(target);
  await symlink(target, directory);
  await assert.rejects(readReleaseSnapshot(), /符号链接/);
  await assert.rejects(registerRelease(entry()), /符号链接/);
  await rm(directory); await mkdir(directory);
  const privateFile = path.join(root, "private.json"); await writeFile(privateFile, "do not read or overwrite");
  const value = entry(); await symlink(privateFile, path.join(directory, `${value.id}.json`));
  assert.equal((await readReleaseSnapshot()).warnings.length, 1);
  await assert.rejects(registerRelease(value), ReleaseConflictError);
  await assert.rejects(markReleaseDeployed(value.id, 1));
  assert.equal(await readFile(privateFile, "utf8"), "do not read or overwrite");
  const lockId = randomUUID(); await symlink(target, path.join(directory, `.${lockId}.lock`));
  await assert.rejects(registerRelease(entry({ id: lockId })), /锁/);
  const input = path.join(root, "input-link.json"); await symlink(privateFile, input);
  assert.equal((await run(directory, ["register", "--file", input, "--completed-and-verified"])).code, 1);
  process.env.PI_PENDING_RELEASE_DIR = path.join(directory, "linked-parent", "child");
  await symlink(target, path.join(directory, "linked-parent"));
  await assert.rejects(registerRelease(entry()), /符号链接/);
  assert.deepEqual(await readdir(target), []);
});

test("same-process updates require expected revision and preserve identity", async (t) => {
  await fixture(t);
  const value = entry(); await registerRelease(value);
  for (const replacement of [
    { ...value, revision: 2, id: randomUUID() }, { ...value, revision: 2, createdAt: "2026-10-16T10:00:00.000Z" },
    { ...value, revision: 1 }, { ...value, revision: 2, status: "deployed", deployedAt: "2026-10-17T11:00:00.000Z" },
  ]) await assert.rejects(updateRelease(value.id, 1, replacement), ReleaseConflictError);
  const outcomes = await Promise.allSettled([
    updateRelease(value.id, 1, { ...value, revision: 2, title: "writer A" }),
    updateRelease(value.id, 1, { ...value, revision: 2, title: "writer B" }),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  assert.ok(outcomes.find((v) => v.status === "rejected").reason instanceof ReleaseConflictError);
  assert.equal((await readReleaseSnapshot()).entries[0].revision, 2);
  await assert.rejects(updateRelease("../bad", 1, value));
  await assert.rejects(updateRelease(value.id, 0, value));
});

test("independent CLI processes never lose registrations; same-ID publication has one winner", async (t) => {
  const { root, directory } = await fixture(t);
  const values = Array.from({ length: 6 }, () => entry());
  const inputs = await Promise.all(values.map(async (value) => {
    const input = path.join(root, `${value.id}.json`); await writeFile(input, JSON.stringify(value)); return input;
  }));
  const results = await Promise.all(inputs.map((file) => run(directory, ["register", "--file", file, "--completed-and-verified"])));
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal((await readReleaseSnapshot()).pendingCount, 6);
  const duplicate = entry(), input = path.join(root, "duplicate.json"); await writeFile(input, JSON.stringify(duplicate));
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => run(directory, ["register", "--file", input, "--completed-and-verified"])));
  assert.equal(duplicates.filter((r) => r.code === 0).length, 1);
  assert.equal(duplicates.filter((r) => r.code === 3).length, 3);
  const updates = await Promise.all(["A", "B"].map(async (title) => {
    const file = path.join(root, `update-${title}.json`);
    await writeFile(file, JSON.stringify({ ...duplicate, title, revision: 2 }));
    return run(directory, ["update", "--id", duplicate.id, "--expected-revision", "1", "--file", file, "--completed-and-verified"]);
  }));
  assert.deepEqual(updates.map((r) => r.code).sort(), [0, 3]);
  assert.equal((await run(directory, ["mark-deployed", "--id", duplicate.id, "--expected-revision", "2", "--confirm-deployed"])).code, 0);
  const snapshot = await readReleaseSnapshot();
  assert.equal(snapshot.pendingCount, 6); assert.equal(snapshot.entries.length, 7);
});

test("readers only observe complete entries during atomic replacement", async (t) => {
  await fixture(t);
  let value = entry(); await registerRelease(value);
  let done = false, reads = 0;
  const reader = (async () => {
    while (!done) {
      const snapshot = await readReleaseSnapshot();
      assert.equal(snapshot.warnings.length, 0); assert.equal(snapshot.entries.length, 1);
      validateReleaseEntry(snapshot.entries[0]); reads++;
    }
  })();
  try {
    for (let i = 0; i < 20; i++) value = await updateRelease(value.id, value.revision, { ...value, revision: value.revision + 1, summary: `atomic ${i}` });
  } finally { done = true; await reader; }
  assert.ok(reads > 0);
  assert.equal((await readReleaseSnapshot()).entries[0].revision, 21);
});

test("orphan locks fail closed rather than expire and overwrite", async (t) => {
  const { directory } = await fixture(t);
  const value = entry(); await mkdir(directory); await mkdir(path.join(directory, `.${value.id}.lock`));
  await assert.rejects(registerRelease(value), ReleaseConflictError);
  assert.equal((await readReleaseSnapshot()).pendingCount, 0);
  await assert.rejects(lstat(path.join(directory, `${value.id}.json`)), { code: "ENOENT" });
});

test("CLI requires completion/deployment confirmation and emits no source on invalid JSON", async (t) => {
  const { root, directory } = await fixture(t);
  const input = path.join(root, "input.json"); await writeFile(input, JSON.stringify(entry()));
  assert.equal((await run(directory, ["register", "--file", input])).code, 1);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  const list = await run(directory, ["list"]); assert.equal(JSON.parse(list.stdout).pendingCount, 0);
  assert.equal((await run(directory, ["list", "--directory", root])).code, 1);
  assert.equal((await run(directory, ["mark-deployed", "--id", randomUUID(), "--expected-revision", "1"])).code, 1);
  assert.equal((await run(directory, ["register", "--file", input, "--completed-and-verified", "--completed-and-verified"])).code, 1);
  await writeFile(input, "private-credential-like-test-not-real");
  const invalid = await run(directory, ["register", "--file", input, "--completed-and-verified"]);
  assert.equal(invalid.code, 1); assert.doesNotMatch(invalid.stderr, /private-credential/);
});

test("handoff includes every evidence field and no implicit action authorization", () => {
  const value = entry({ dependencies: [randomUUID()] });
  const text = formatReleaseHandoff(value);
  for (const field of [value.id, value.title, value.summary, value.createdAt, ...value.sourceSessions, ...value.codeLocations, ...value.verification, ...value.releaseSteps, ...value.rollback, ...value.dependencies]) assert.ok(text.includes(field), field);
  assert.match(text, /不构成上线、重启或发送消息的授权/);
  assert.match(text, /登记后停止/);
  const deployed = { ...value, status: "deployed", deployedAt: "2026-10-17T11:00:00.000Z" };
  assert.match(formatReleaseHandoff(deployed), /上线: 2026-10-17T11:00:00.000Z/);
  assert.throws(() => parseReleaseSnapshot({ entries: [value], warnings: [], pendingCount: 0 }));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (entries = []) => ({ ok: true, json: async () => ({ entries, warnings: [], pendingCount: entries.filter((e) => e.status === "pending").length }) });
test("loader suppresses old/out-of-order responses and aborts prior requests", async () => {
  const calls = [], states = [];
  const loader = createReleaseLoader((state) => states.push(state), (url, options) => {
    const pending = deferred(); calls.push({ ...pending, url, options }); return pending.promise;
  });
  const older = loader.refresh(), newer = loader.refresh();
  assert.equal(calls[0].url, "/api/pending-releases"); assert.equal(calls[0].options.cache, "no-store");
  assert.ok(calls[0].options.signal.aborted);
  calls[1].resolve(response([entry()])); await newer;
  calls[0].resolve(response([])); await older;
  assert.equal(states.at(-1).snapshot.pendingCount, 1);
  const after = loader.refresh(); loader.dispose(); const length = states.length;
  calls[2].resolve(response([])); await after;
  assert.equal(states.length, length); assert.ok(calls[2].options.signal.aborted);
});

test("loader HTTP/business/schema/network failures show unavailable, never a fake zero", async () => {
  for (const reply of [
    async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ error: "business" }) }),
    async () => ({ ok: true, json: async () => ({ entries: [], warnings: [], pendingCount: 10 }) }),
    async () => { throw new Error("network"); },
  ]) {
    const states = []; let request = async () => response([entry()]);
    const loader = createReleaseLoader((state) => states.push(state), (...args) => request(...args));
    await loader.refresh(); assert.equal(states.at(-1).snapshot.pendingCount, 1);
    request = reply; await loader.refresh();
    assert.equal(states.at(-1).snapshot, null); assert.ok(states.at(-1).error); assert.equal(states.at(-1).loading, false);
    loader.dispose();
  }
});

test("loader uses manual timeout abort and reports unavailable", async () => {
  const states = [];
  const loader = createReleaseLoader((state) => states.push(state), (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  }), 5);
  await loader.refresh(); assert.equal(states.at(-1).loading, false); assert.ok(states.at(-1).error);
  loader.dispose();
});
