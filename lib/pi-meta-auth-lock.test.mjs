import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rename, symlink, unlink, utimes, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(process.env.PI_META_TEST_DEPENDENCY_ROOT
  ? join(process.env.PI_META_TEST_DEPENDENCY_ROOT, "package.json")
  : import.meta.url);
const lockfile = require("proper-lockfile");
const lockModule = require.resolve("proper-lockfile");
const dependencyRoot = process.env.PI_META_TEST_DEPENDENCY_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const { resolveOriginalPi } = createRequire(import.meta.url)("../bin/pi-meta-original.cjs");
const originalAuth = pathToFileURL(join(resolveOriginalPi(dependencyRoot).root, "dist/core/auth-storage.js")).href;
const sdkAuth = pathToFileURL(join(dependencyRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href;
const preload = fileURLToPath(new URL("../bin/pi-meta-auth-lock.cjs", import.meta.url));
const SCRIPT = `
const lock = require(process.env.TEST_LOCK_MODULE);
let release;
try {
  release = lock.lockSync(process.env.PI_META_AUTH_PATH, { realpath: false });
  process.send({ acquired: true });
  process.on('message', () => { release(); process.exit(0); });
} catch (error) { process.send({ acquired: false, code: error.code }); process.exitCode = 0; }
`;

async function fixture(t, multiLink = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "main"), meta = join(root, "meta"), legacy = join(root, "legacy");
  await mkdir(main); await mkdir(meta);
  const shared = join(main, "auth.json"), alias = join(meta, "auth.json");
  const actual = multiLink ? join(legacy, "auth.json") : shared;
  if (multiLink) await mkdir(legacy);
  await writeFile(actual, "{}", { mode: 0o600 });
  if (multiLink) await symlink(actual, shared);
  await symlink(shared, alias);
  return { shared, alias, actual };
}

function child(alias, shared) {
  return spawn(process.execPath, ["-e", SCRIPT], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, PI_META_WEB_PACKAGE_DIR: dependencyRoot, PI_META_AUTH_PATH: resolve(alias), PI_META_SHARED_AUTH_PATH: resolve(shared), TEST_LOCK_MODULE: lockModule },
  });
}
function message(p) {
  return new Promise((resolveMessage, reject) => {
    let stderr = "";
    const onData = data => { stderr += String(data).slice(0, 4000); };
    const cleanup = () => { p.off("message", onMessage); p.off("error", onError); p.off("exit", onExit); p.stderr?.off("data", onData); };
    const onMessage = value => { cleanup(); resolveMessage(value); };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`child exited ${code}: ${stderr}`)); };
    p.stderr?.on("data", onData);
    p.once("message", onMessage); p.once("error", onError); p.once("exit", onExit);
  });
}
function exited(p) { return new Promise((resolveExit, reject) => { p.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`child exited ${code}`))); p.once("error", reject); }); }

test("Meta and main mutually exclude the exact same auth lock in both directions", async (t) => {
  const { shared, alias } = await fixture(t);
  const releaseMain = lockfile.lockSync(shared, { realpath: false });
  t.after(() => { try { releaseMain(); } catch {} });
  const blocked = child(alias, shared);
  assert.deepEqual(await message(blocked), { acquired: false, code: "ELOCKED" });
  await exited(blocked);
  releaseMain();

  const holder = child(alias, shared);
  assert.deepEqual(await message(holder), { acquired: true });
  assert.throws(() => lockfile.lockSync(shared, { realpath: false }), { code: "ELOCKED" });
  const done = exited(holder);
  holder.send("release");
  await done;
  const releaseAfter = lockfile.lockSync(shared, { realpath: false });
  releaseAfter();
});

test("Meta cannot acquire its auth lock while either symlink target lock is held", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-multilink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "main"), meta = join(root, "meta"), legacy = join(root, "legacy");
  await Promise.all([mkdir(main), mkdir(meta), mkdir(legacy)]);
  const actual = join(legacy, "auth.json"), shared = join(main, "auth.json"), alias = join(meta, "auth.json");
  await writeFile(actual, "{}", { mode: 0o600 });
  await symlink(actual, shared); await symlink(shared, alias);
  for (const path of [shared, actual]) {
    const release = lockfile.lockSync(path, { realpath: false });
    try {
      const contender = child(alias, shared);
      const result = await message(contender);
      const done = exited(contender);
      if (result.acquired) contender.send("release");
      await done;
      assert.deepEqual(result, { acquired: false, code: "ELOCKED" }, `Meta must respect the lock for ${path}`);
    } finally { release(); }
  }
});

test("a valid 30-second main lock is not stolen during its 15-second heartbeat gap", async (t) => {
  const { shared, alias } = await fixture(t, true);
  const release = lockfile.lockSync(shared, { realpath: false, stale: 30_000, update: 15_000 });
  try {
    const elevenSecondsAgo = new Date(Date.now() - 11_000);
    await utimes(`${shared}.lock`, elevenSecondsAgo, elevenSecondsAgo);
    const contender = child(alias, shared);
    const result = await message(contender);
    const done = exited(contender);
    if (result.acquired) contender.send("release");
    await done;
    assert.deepEqual(result, { acquired: false, code: "ELOCKED" });
  } finally { release(); }
});

test("a retargeted auth symlink is rejected before a new transaction", async (t) => {
  const { shared, alias, actual } = await fixture(t, true);
  const replacement = join(dirname(actual), "different-auth.json");
  await writeFile(replacement, "{}", { mode: 0o600 });
  const script = `
    const lock = require(process.env.TEST_LOCK_MODULE); process.send({ready:true});
    process.on('message', () => {
      try { const release=lock.lockSync(process.env.PI_META_AUTH_PATH,{realpath:false}); release(); process.send({refused:false}); }
      catch(error) { process.send({refused:/shared-auth link/.test(error.message)}); }
    });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_LOCK_MODULE: lockModule } });
  assert.deepEqual(await message(p), { ready: true });
  await unlink(shared); await symlink(replacement, shared);
  const reply = message(p); p.send("run");
  assert.deepEqual(await reply, { refused: true });
  if (p.connected) p.disconnect();
  const release = lockfile.lockSync(actual, { realpath: false }); release();
});

test("async auth callers retain their retry behavior without holding a partial lock", async (t) => {
  const { shared, alias } = await fixture(t, true);
  const held = lockfile.lockSync(shared, { realpath: false });
  const script = `
    const lock = require(process.env.TEST_LOCK_MODULE); process.send({ready:true});
    process.once('message', async () => {
      try {
        const release=await lock.lock(process.env.PI_META_AUTH_PATH,
          {realpath:false,retries:{retries:3,minTimeout:80,maxTimeout:80}});
        process.send({acquired:true}); process.once('message', async () => { await release(); process.exit(0); });
      } catch(error) { process.send({acquired:false,code:error.code}); }
    });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_LOCK_MODULE: lockModule } });
  t.after(() => { if (p.connected) p.disconnect(); });
  try {
    assert.deepEqual(await message(p), { ready: true });
    const reply = message(p); p.send("start");
    await new Promise(resolve => setTimeout(resolve, 40));
    held();
    assert.deepEqual(await reply, { acquired: true });
    const done = exited(p); p.send("release"); await done;
  } finally { try { held(); } catch {} }
});

test("a symlink retargeted during an async auth transaction cannot receive an unlocked write", async (t) => {
  const { shared, alias, actual } = await fixture(t, true);
  const replacement = join(dirname(actual), "different-auth.json");
  await writeFile(replacement, '{"untouched":true}', { mode: 0o600 });
  const kernel = fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url));
  const script = `
    import(process.env.TEST_SDK_AUTH).then(async ({FileAuthStorageBackend}) => {
      const backend = new FileAuthStorageBackend(process.env.PI_META_AUTH_PATH);
      try {
        await backend.withLockAsync(async () => {
          process.send({locked:true}); await new Promise(resolve => process.once('message', resolve));
          return {result:null,next:'{"mustNotLand":true}'};
        });
        process.send({refused:false});
      } catch { process.send({refused:true}); }
    }).catch(error => { console.error(error); process.exitCode=1; });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PI_META_PROCESS: "1", PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_SDK_AUTH: originalAuth,
      NODE_OPTIONS: `--require=${JSON.stringify(kernel)} --require=${JSON.stringify(preload)}` } });
  t.after(() => { if (p.connected) p.disconnect(); });
  assert.deepEqual(await message(p), { locked: true });
  await unlink(shared); await symlink(replacement, shared);
  const reply = message(p); p.send("resume");
  assert.deepEqual(await reply, { refused: true });
  assert.equal(await readFile(replacement, "utf8"), '{"untouched":true}');
  assert.equal(await readFile(actual, "utf8"), "{}");
  if (p.connected) p.disconnect();
});

test("the actual Web credential store retries and writes through the locked target", async (t) => {
  const { shared, alias, actual } = await fixture(t, true);
  const source = join(dirname(dirname(actual)), "web-source");
  await mkdir(source);
  await writeFile(join(source, "package.json"), "{}");
  await copyFile(fileURLToPath(new URL("./provider-credential-store.ts", import.meta.url)), join(source, "provider-credential-store.ts"));
  await symlink(join(dependencyRoot, "node_modules"), join(source, "node_modules"), "dir");
  const held = lockfile.lockSync(shared, { realpath: false });
  const kernel = fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url));
  const script = `
    const {createJiti}=require(process.env.TEST_JITI);
    (async () => {
      const api=await createJiti(process.env.TEST_BASE).import(process.env.TEST_STORE);
      process.send({ready:true}); await new Promise(resolve => process.once('message',resolve));
      await api.storeProviderCredential('fixture',{type:'api_key',key:'synthetic'},process.env.PI_META_AUTH_PATH);
      process.send({stored:true});
    })().catch(error => { console.error(error); process.exitCode=1; });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PI_META_PROCESS: "1", PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_JITI: require.resolve("jiti"),
      TEST_BASE: join(source, "package.json"), TEST_STORE: join(source, "provider-credential-store.ts"),
      JITI_FS_CACHE: "0", NODE_OPTIONS: `--require=${JSON.stringify(kernel)} --require=${JSON.stringify(preload)}` } });
  t.after(() => { if (p.connected) p.disconnect(); });
  try {
    assert.deepEqual(await message(p), { ready: true });
    const done = message(p).catch(error => error); p.send("start");
    await new Promise(resolve => setTimeout(resolve, 40));
    held();
    const result = await done;
    if (result instanceof Error) throw result;
    assert.deepEqual(result, { stored: true });
    assert.deepEqual(JSON.parse(await readFile(actual, "utf8")), { fixture: { type: "api_key", key: "synthetic" } });
    if (p.connected) p.disconnect();
  } finally { try { held(); } catch {} }
});

test("replacing the locked auth inode is detected before truncation", async (t) => {
  const { shared, alias, actual } = await fixture(t, true);
  const backup = `${actual}.original`;
  const kernel = fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url));
  const script = `
    import(process.env.TEST_SDK_AUTH).then(async ({FileAuthStorageBackend}) => {
      try {
        await new FileAuthStorageBackend(process.env.PI_META_AUTH_PATH).withLockAsync(async () => {
          process.send({locked:true}); await new Promise(resolve => process.once('message', resolve));
          return {result:null,next:'{"mustNotLand":true}'};
        }); process.send({refused:false});
      } catch { process.send({refused:true}); }
    }).catch(error => { console.error(error); process.exitCode=1; });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PI_META_PROCESS: "1", PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_SDK_AUTH: originalAuth,
      NODE_OPTIONS: `--require=${JSON.stringify(kernel)} --require=${JSON.stringify(preload)}` } });
  t.after(() => { if (p.connected) p.disconnect(); });
  assert.deepEqual(await message(p), { locked: true });
  await rename(actual, backup); await writeFile(actual, '{"untouched":true}', { mode: 0o600 });
  const reply = message(p); p.send("resume");
  assert.deepEqual(await reply, { refused: true });
  assert.equal(await readFile(actual, "utf8"), '{"untouched":true}');
  assert.equal(await readFile(backup, "utf8"), "{}");
  if (p.connected) p.disconnect();
});

test("async dual-lock rollback, abort, and callback failures release both paths", async (t) => {
  const { shared, alias, actual } = await fixture(t, true);
  const kernel = fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url));
  const env = { ...process.env, PI_META_PROCESS: "1", PI_META_WEB_PACKAGE_DIR: dependencyRoot,
    PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_SDK_AUTH: originalAuth,
    NODE_OPTIONS: `--require=${JSON.stringify(kernel)} --require=${JSON.stringify(preload)}` };
  const held = lockfile.lockSync(shared, { realpath: false });
  try {
    const script = `
      import(process.env.TEST_SDK_AUTH).then(async ({FileAuthStorageBackend}) => {
        const controller = new AbortController(); setTimeout(() => controller.abort(), 40);
        try { await new FileAuthStorageBackend(process.env.PI_META_AUTH_PATH).withLockAsync(
          () => ({result:null}), {signal:controller.signal}); process.send({aborted:false}); }
        catch(error) { process.send({aborted:error.name === 'AbortError'}); }
      }).catch(error => { console.error(error); process.exitCode=1; });`;
    const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"], env });
    assert.deepEqual(await message(p), { aborted: true });
    const afterAbort = lockfile.lockSync(actual, { realpath: false });
    afterAbort();
    if (p.connected) p.disconnect();
  } finally { held(); }

  const script = `
    import(process.env.TEST_SDK_AUTH).then(async ({FileAuthStorageBackend}) => {
      const backend = new FileAuthStorageBackend(process.env.PI_META_AUTH_PATH); let failures=0;
      try { backend.withLock(() => { throw new Error('fixture'); }); } catch { failures++; }
      try { await backend.withLockAsync(async () => { throw new Error('fixture'); }); } catch { failures++; }
      process.send({failures});
    }).catch(error => { console.error(error); process.exitCode=1; });`;
  const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"], env });
  assert.deepEqual(await message(p), { failures: 2 });
  for (const target of [shared, actual]) { const release = lockfile.lockSync(target, { realpath: false }); release(); }
  if (p.connected) p.disconnect();
});

async function exerciseConcurrentAuth(t, childSdkAuth, withKernel, parentUsesActual = false) {
  const { shared, alias, actual } = await fixture(t, withKernel);
  await writeFile(shared, "{\"count\":0}");
  const script = `
    import(process.env.TEST_SDK_AUTH).then(async ({ FileAuthStorageBackend }) => {
      const backend = new FileAuthStorageBackend(process.env.PI_META_AUTH_PATH);
      for (let i = 0; i < 12; i++) await backend.withLockAsync(async (current) => {
        const data = JSON.parse(current); await new Promise(resolve => setTimeout(resolve, 3));
        return { result: null, next: JSON.stringify({ count: data.count + 1 }) };
      });
      process.send({ done: true });
    }).catch(error => { console.error(error); process.exitCode = 1; });`;
  const p = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env,
      NODE_OPTIONS: [
        ...(withKernel ? [`--require=${JSON.stringify(fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url)))}`] : []),
        `--require=${JSON.stringify(preload)}`].join(" "),
      PI_META_WEB_PACKAGE_DIR: dependencyRoot,
      ...(withKernel ? { PI_META_PROCESS: "1" } : {}),
      PI_META_AUTH_PATH: alias, PI_META_SHARED_AUTH_PATH: shared, TEST_SDK_AUTH: childSdkAuth },
  });
  const done = message(p);
  const { FileAuthStorageBackend } = await import(sdkAuth);
  const backend = new FileAuthStorageBackend(parentUsesActual ? actual : shared);
  for (let i = 0; i < 12; i++) await backend.withLockAsync(async (current) => {
    const data = JSON.parse(current);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 3));
    return { result: null, next: JSON.stringify({ count: data.count + 1 }) };
  });
  assert.deepEqual(await done, { done: true });
  assert.equal(JSON.parse(await readFile(shared, "utf8")).count, 24);
  if (p.connected) p.disconnect();
}

test("actual Pi auth backends serialize concurrent changes across the two paths", (t) => exerciseConcurrentAuth(t, sdkAuth, false));

test("original child SDK and patched Web SDK serialize through the shared auth lock", async (t) => {
  await exerciseConcurrentAuth(t, originalAuth, true);
});

test("original Meta child also serializes with the canonical shared auth path", async (t) => {
  await exerciseConcurrentAuth(t, originalAuth, true, true);
});
