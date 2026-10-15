import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Stub before Jiti imports the module: its named imports capture the current
// native function. These tests must never raise real desktop windows.
const spawnCalls = [];
const spawnStub = mock.method(childProcess, "spawn", (command, args, options) => {
  spawnCalls.push({ command, args, options });
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
});
syncBuiltinESMExports();
test.after(() => { spawnStub.mock.restore(); syncBuiltinESMExports(); });

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

function open(cwd, host = "localhost:30141", reveal) {
  return POST(new Request("http://localhost/api/open-in-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ cwd, reveal }),
  }));
}

test("rejects a path outside the allowed roots before looking at it", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // Existing and missing paths answer the same, so the route is no existence oracle.
  for (const cwd of [outside, path.join(outside, "missing")]) {
    const response = await open(cwd);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "access-denied" });
  }
});

test("refuses requests that are not addressed to this machine", async () => {
  const response = await open(os.tmpdir(), "192.168.1.20:30141");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "remote" });
});

test("availability hides native actions for remote browsers", async () => {
  const response = await GET(new Request("http://localhost/api/open-in-explorer", { headers: { Host: "192.168.1.20:30141" } }));
  assert.equal((await response.json()).supported, false);
});

test("reveal validates its flag and still rejects remote requests", async () => {
  assert.equal((await open(agentDir, undefined, "yes")).status, 400);
  const remote = await open(agentDir, "192.168.1.20:30141", true);
  assert.equal(remote.status, 403);
  assert.deepEqual(await remote.json(), { error: "remote" });
});

test("revealing a file uses the original path and no shell; opening files remains disallowed by default", async (t) => {
  const root = await realpath(agentDir);
  const target = `${root}/my notes ; $(unused).md`;
  await writeFile(target, "# Test");
  const cache = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(() => { globalThis.__piAllowedRootsCache = cache; });
  spawnCalls.length = 0;
  const calls = spawnCalls;
  const response = await open(target, undefined, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { opened: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, process.platform === "darwin" ? ["-R", target] : process.platform === "win32" ? [`/select,${target}`] : [root]);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal((await open(target)).status, 400);
  assert.equal((await open(root, undefined, true)).status, 400);
  assert.equal(calls.length, 1);
});

test("reveal never launches a file outside allowed roots, including a symbolic link escape", async (t) => {
  const root = await realpath(agentDir);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-reveal-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, "private.md");
  await writeFile(target, "private");
  const link = path.join(root, "escape.md");
  await symlink(target, link);
  const cache = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(() => { globalThis.__piAllowedRootsCache = cache; });
  const previousCalls = spawnCalls.length;
  for (const location of [target, `${target}.missing`, link]) assert.equal((await open(location, undefined, true)).status, 403);
  assert.equal(spawnCalls.length, previousCalls);
});
