import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { initializePiMeta } from "./pi-meta-config.mjs";

const KEY = Symbol.for("pi-web:meta-worker/v1");
const exec = promisify(execFile);
function state() { return globalThis[KEY] ??= { starting: null, worker: null, child: null, unresolved: false, stopping: false }; }
const metaPath = mainAgentDir => join(dirname(resolve(mainAgentDir)), "meta-agent");
const ownerPath = mainAgentDir => join(metaPath(mainAgentDir), ".pi-meta-worker", "owner.json");

function isPrivateOwned(info) {
  return (info.mode & 0o077) === 0 && (typeof process.getuid !== "function" || info.uid === process.getuid());
}

/** Read the worker's durable identity. An ambiguous/stale owner is never replaced. */
async function readOwner(mainAgentDir, packageDir) {
  const lock = dirname(ownerPath(mainAgentDir));
  let info;
  try { info = await lstat(lock); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || !isPrivateOwned(info)) throw new Error("Pi Meta worker ownership is invalid");
  const file = await lstat(ownerPath(mainAgentDir));
  if (!file.isFile() || file.isSymbolicLink() || !isPrivateOwned(file)) throw new Error("Pi Meta worker ownership record is invalid");
  const owner = JSON.parse(await readFile(ownerPath(mainAgentDir), "utf8"));
  const temporaryRoot = resolve(tmpdir());
  if (owner?.version !== 2 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.groupId !== owner.pid ||
      typeof owner.token !== "string" || !/^[a-f0-9]{64}$/.test(owner.token) ||
      owner.agentDir !== metaPath(mainAgentDir) || owner.packageDir !== resolve(packageDir) ||
      typeof owner.packageIdentity !== "string" || !/^\d+:\d+:[A-Za-z0-9_-]+$/.test(owner.packageIdentity) ||
      typeof owner.socketDir !== "string" || dirname(resolve(owner.socketDir)) !== temporaryRoot ||
      !/^pi-meta-[A-Za-z0-9]+$/.test(basename(owner.socketDir))) {
    throw new Error("Pi Meta worker ownership record is unrecognized");
  }
  const packageStat = await stat(resolve(packageDir), { bigint: true });
  let buildId = null;
  try { buildId = (await readFile(join(resolve(packageDir), ".next/BUILD_ID"), "utf8")).trim(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  // A prior worker may survive a Web update. Authenticate it first and let a
  // later start drain it before replacing it; never kill or silently reuse it.
  const stale = owner.packageIdentity !== `${packageStat.dev}:${packageStat.ino}:${buildId ?? "dev"}`;
  try { process.kill(owner.pid, 0); }
  catch { throw new Error("Pi Meta worker stopped unexpectedly; preserve its ownership record for recovery"); }
  const { stdout } = await exec("/bin/ps", ["-p", String(owner.pid), "-o", "pgid="], { timeout: 3000 });
  if (Number(stdout.trim()) !== owner.groupId) throw new Error("Pi Meta worker process group identity did not match");
  const dir = await lstat(owner.socketDir);
  const socketPath = join(owner.socketDir, "worker.sock");
  const socket = await lstat(socketPath);
  if (!dir.isDirectory() || dir.isSymbolicLink() || !isPrivateOwned(dir) ||
      !socket.isSocket() || socket.isSymbolicLink() || !isPrivateOwned(socket)) {
    throw new Error("Pi Meta worker socket is not private");
  }
  return { ...owner, socketPath, stale };
}

function workerControl(worker, action, leaseId) {
  return new Promise((resolveControl, reject) => {
    const body = JSON.stringify({ action, ...(leaseId ? { leaseId } : {}) });
    const headers = { host: "localhost", "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-pi-meta-control": worker.token };
    if (process.env.PI_WEB_PASSWORD) headers.authorization = `Basic ${Buffer.from(`pi:${process.env.PI_WEB_PASSWORD}`).toString("base64")}`;
    const req = httpRequest({ socketPath: worker.socketPath, path: "/api/pi-meta-control", method: "POST", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; if (data.length > 65536) req.destroy(new Error("Pi Meta control response too large")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Pi Meta control refused"));
        try { resolveControl(JSON.parse(data)); } catch { reject(new Error("Invalid Pi Meta control response")); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("Pi Meta control timed out")));
    req.once("error", reject);
    req.end(body);
  });
}

async function identify(worker) {
  const reply = await workerControl(worker, "identity");
  if (!reply?.ok || reply.pid !== worker.pid || reply.agentDir !== worker.agentDir) throw new Error("Pi Meta worker identity did not match");
  return worker;
}

async function resolveWorker(mainAgentDir, packageDir) {
  const s = state();
  if (s.unresolved) throw new Error("Pi Meta worker requires recovery after an unexpected exit");
  if (s.worker) {
    if (s.worker.agentDir !== metaPath(mainAgentDir) || s.worker.packageDir !== resolve(packageDir)) throw new Error("Pi Meta worker belongs to another runtime");
    return s.worker;
  }
  const owner = await readOwner(mainAgentDir, packageDir);
  if (!owner) return null;
  s.worker = await identify(owner);
  return s.worker;
}

/** Do not signal children: preserve ownership until the dedicated group is empty. */
async function waitForProcessGroupEmpty(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("Invalid Pi Meta process group");
  const deadline = Date.now() + 5000;
  for (;;) {
    try { process.kill(-groupId, 0); }
    catch (error) {
      if (error?.code === "ESRCH") return;
      // EPERM proves neither emptiness nor ownership; keep waiting conservatively.
      if (error?.code !== "EPERM") throw new Error("Pi Meta process group state is unknown", { cause: error });
    }
    if (Date.now() >= deadline) throw new Error("Pi Meta process group still contains processes");
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

async function cleanupOwnedWorker(mainAgentDir, worker, allowMissing = false) {
  const lock = dirname(ownerPath(mainAgentDir));
  let info;
  try { info = await lstat(lock); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") { await rm(worker.socketDir, { recursive: true, force: true }); return; }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !isPrivateOwned(info)) throw new Error("Pi Meta ownership changed during shutdown");
  const ownerInfo = await lstat(ownerPath(mainAgentDir));
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || !isPrivateOwned(ownerInfo)) throw new Error("Pi Meta ownership changed during shutdown");
  const record = JSON.parse(await readFile(ownerPath(mainAgentDir), "utf8"));
  if (record.pid !== worker.pid || record.token !== worker.token || record.groupId !== worker.groupId || record.socketDir !== worker.socketDir) {
    throw new Error("Pi Meta ownership changed during shutdown");
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(lock);
  const latest = await lstat(lock);
  if (entries.length !== 1 || entries[0] !== "owner.json" || latest.dev !== info.dev || latest.ino !== info.ino) throw new Error("Pi Meta ownership is ambiguous");
  await rm(lock, { recursive: true });
  await rm(worker.socketDir, { recursive: true, force: true });
}

function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error("Pi Meta worker startup timed out")), 45_000);
    timer.unref?.();
    function finish(error) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolveReady();
    }
    function onMessage(message) {
      if (message?.type === "ready" && message.pid === child.pid) finish();
      else if (message?.type === "startup-error") finish(new Error("Pi Meta worker failed to start"));
    }
    function onExit() { finish(new Error("Pi Meta worker exited during startup")); }
    function onError() { finish(new Error("Pi Meta worker could not be launched")); }
    child.on("message", onMessage); child.on("exit", onExit); child.on("error", onError);
  });
}

function waitForChildExit(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timer = setTimeout(() => finish(false), 5000);
    timer.unref?.();
    function finish(exited) { clearTimeout(timer); child.off("exit", onExit); resolveExit(exited); }
    function onExit() { finish(true); }
    child.once("exit", onExit);
  });
}

/** The singleton includes the pending start so restart admission cannot race it. */
export function piMetaStartingOrUnresolved() {
  const s = state();
  return Boolean(s.starting || s.unresolved);
}

export async function ensurePiMeta({ mainAgentDir, packageDir, canStart }) {
  if (process.platform !== "darwin") throw new Error("Pi Meta requires macOS");
  if (process.env.PI_META_PROCESS === "1") throw new Error("Pi Meta cannot start another Pi Meta worker");
  if (!canStart()) throw new Error("Pi Web is restarting; retry after reconnecting");
  const s = state();
  if (s.starting) return s.starting;
  s.starting = (async () => {
    const agentDir = metaPath(mainAgentDir);
    await initializePiMeta({ mainAgentDir: resolve(mainAgentDir), metaAgentDir: agentDir, packageDir: resolve(packageDir) });
    if (!canStart()) throw new Error("Pi Web is restarting; retry after reconnecting");
    const existing = await resolveWorker(mainAgentDir, packageDir);
    if (existing && !existing.stale) return existing;
    if (existing) {
      const lease = randomUUID();
      const drain = await workerControl(existing, "drain", lease);
      if (!drain?.ok || drain.pending !== true || drain.owned !== true) throw new Error("Previous Pi Meta worker is still busy");
      await shutdownPiMeta({ mainAgentDir, packageDir }, lease);
      if (!canStart()) throw new Error("Pi Web is restarting; retry after reconnecting");
    }
    const socketDir = await mkdtemp(join(tmpdir(), "pi-meta-"));
    const token = randomBytes(32).toString("hex");
    const preload = join(resolve(packageDir), "bin/pi-meta-auth-lock.cjs");
    const kernelPreload = join(resolve(packageDir), "bin/pi-meta-kernel.cjs");
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_META_PROCESS: "1",
      PI_META_AUTH_PATH: join(agentDir, "auth.json"),
      PI_META_SHARED_AUTH_PATH: join(resolve(mainAgentDir), "auth.json"),
      PI_META_SOCKET_DIR: socketDir,
      PI_META_CONTROL_TOKEN: token,
      PI_META_WEB_PACKAGE_DIR: resolve(packageDir),
      PI_WEB_HOSTNAME: "localhost",
      NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), `--require=${JSON.stringify(kernelPreload)}`, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" "),
    };
    // Meta must use the SDK loaded by this Web package; an inherited override disables MCP.
    delete env.PI_PACKAGE_DIR;
    delete env.PI_HY_MEMORY_CONFIG;
    delete env.PI_MEMORY_EXIT_SUMMARY;
    delete env.PI_SUBAGENT_CHILD;
    delete env.PI_SUBAGENT_PI_BINARY;
    // A dedicated process group keeps the worker independent of the Web parent.
    // The worker can be adopted after a parent crash without killing its tasks.
    const log = await open(join(agentDir, "worker.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const logInfo = await log.stat();
    if (!logInfo.isFile() || !isPrivateOwned(logInfo)) { await log.close(); throw new Error("Pi Meta worker log is not private"); }
    let child;
    try {
      // A private file, not a pipe to the parent: logs must not kill an adopted
      // worker with EPIPE if the original Pi Web process exits.
      child = spawn(process.execPath, [join(resolve(packageDir), "bin/pi-meta-worker.cjs")], {
        cwd: resolve(packageDir), env, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"],
      });
    } finally { void log.close().catch(() => {}); }
    s.child = child;
    let ready = false;
    child.once("exit", () => { if (ready) { s.worker = null; s.unresolved = !s.stopping; s.stopping = false; } s.child = null; });
    try {
      await waitForReady(child);
      ready = true;
      const worker = await readOwner(mainAgentDir, packageDir);
      if (!worker || worker.pid !== child.pid || worker.token !== token) throw new Error("Pi Meta worker ownership did not match");
      s.worker = await identify(worker);
      return s.worker;
    } catch (error) {
      if (!ready && await waitForChildExit(child)) {
        try {
          if (child.pid) await waitForProcessGroupEmpty(child.pid);
          await cleanupOwnedWorker(mainAgentDir, { pid: child.pid, groupId: child.pid, token, socketDir }, true);
        } catch { s.unresolved = true; }
      } else s.unresolved = true;
      throw error;
    }
  })();
  try { return await s.starting; }
  finally { s.starting = null; }
}

/** Shut down only a drained worker; keep ownership while its process group is alive. */
export async function shutdownPiMeta({ mainAgentDir, packageDir }, leaseId) {
  const s = state();
  const worker = await resolveWorker(mainAgentDir, packageDir);
  if (!worker) return;
  s.stopping = true;
  try {
    const result = await workerControl(worker, "shutdown", leaseId);
    if (!result?.ok) throw new Error("Pi Meta worker refused shutdown");
    await waitForProcessGroupEmpty(worker.groupId);
    await cleanupOwnedWorker(mainAgentDir, worker);
    s.worker = null;
    s.unresolved = false;
    if (!s.child || s.child.pid !== worker.pid) s.stopping = false;
  } catch (error) {
    // A committed shutdown with a still-running or unknown group remains a blocker.
    s.stopping = false;
    s.unresolved = true;
    throw error;
  }
}

export async function piMetaControl({ mainAgentDir, packageDir }, action, leaseId) {
  if (process.env.PI_META_PROCESS === "1") return { ok: true, pending: false, sessions: 0, terminals: 0, available: false };
  if (state().starting) throw new Error("Pi Meta is starting");
  const worker = await resolveWorker(mainAgentDir, packageDir);
  if (!worker) return { ok: true, pending: false, sessions: 0, terminals: 0, available: false };
  const result = await workerControl(worker, action, leaseId);
  if (!result || typeof result.ok !== "boolean") throw new Error("Invalid Pi Meta control response");
  return { ...result, available: true };
}

/** Surface Meta work to the existing external idle/deployment guard. */
export async function piMetaRestartBlockingIds(options) {
  if (process.env.PI_META_PROCESS === "1") return [];
  if (piMetaStartingOrUnresolved()) return ["meta:unknown"];
  try {
    const status = await piMetaControl(options, "status");
    if (!status.ok || !Number.isSafeInteger(status.sessions) || status.sessions < 0 ||
        !Number.isSafeInteger(status.terminals) || status.terminals < 0) throw new Error("Invalid Pi Meta status");
    return [
      ...(status.sessions ? ["meta:session"] : []),
      ...(status.terminals ? ["meta:terminal"] : []),
      ...(status.pending ? ["meta:draining"] : []),
    ];
  } catch { return ["meta:unknown"]; }
}
