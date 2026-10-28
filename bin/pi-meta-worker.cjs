"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- The worker is a Node CommonJS entrypoint. */

const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const next = require("next");

const agentDir = process.env.PI_CODING_AGENT_DIR;
const socketDir = process.env.PI_META_SOCKET_DIR;
const token = process.env.PI_META_CONTROL_TOKEN;
if (process.platform !== "darwin" || process.env.PI_META_PROCESS !== "1" || !agentDir || !socketDir || !token || !process.send) {
  throw new Error("Pi Meta worker requires its private launcher");
}
delete process.env.PI_META_CONTROL_TOKEN;
globalThis[Symbol.for("pi-web:meta-control-token/v1")] = token;
const lockDir = path.join(agentDir, ".pi-meta-worker");
const ownerPath = path.join(lockDir, "owner.json");
const socketPath = path.join(socketDir, "worker.sock");
let server;
let admitted = false;
let owned = false;
let ownerWritten = false;

async function removeOwnedArtifacts() {
  if (!owned) return;
  try {
    if (ownerWritten) {
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      if (owner.pid !== process.pid || owner.token !== token) return;
    } else if (admitted) return;
    // The parent retains ownership until the worker's process group is empty.
    // A worker exit by itself is not evidence that child processes have exited.
    if (!ownerWritten) await fs.rm(lockDir, { recursive: true, force: true });
    await fs.rm(socketDir, { recursive: true, force: true });
    if (!ownerWritten) owned = false;
  } catch { /* Preserve ambiguous artifacts for recovery. */ }
}

async function start() {
  const socketInfo = await fs.lstat(socketDir);
  if (!socketInfo.isDirectory() || socketInfo.isSymbolicLink() || (socketInfo.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && socketInfo.uid !== process.getuid())) throw new Error("Invalid private worker socket directory");
  await fs.mkdir(lockDir, { mode: 0o700 });
  owned = true;
  const groupId = Number(execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8", timeout: 3000 }).trim());
  if (groupId !== process.pid) throw new Error("Pi Meta is not in its dedicated process group");
  const packageStat = await fs.stat(process.cwd(), { bigint: true });
  let buildId = null;
  try { buildId = (await fs.readFile(path.join(process.cwd(), ".next/BUILD_ID"), "utf8")).trim(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const packageIdentity = `${packageStat.dev}:${packageStat.ino}:${buildId ?? "dev"}`;
  await fs.writeFile(ownerPath, JSON.stringify({ version: 2, pid: process.pid, groupId, token, agentDir, packageDir: process.cwd(), packageIdentity, socketDir }), { mode: 0o600, flag: "wx" });
  ownerWritten = true;
  const app = next({ dev: process.env.NODE_ENV === "development", dir: process.cwd(), hostname: "localhost" });
  await app.prepare();
  const handle = app.getRequestHandler();
  server = createServer((req, res) => { Promise.resolve(handle(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  await fs.chmod(socketPath, 0o600);
  admitted = true;
  process.send({ type: "ready", pid: process.pid });
}

function shutdownDrainedWorker() {
  if (!server) return;
  server.closeAllConnections?.();
  server.close(() => { void removeOwnedArtifacts().finally(() => process.exit(0)); });
}
globalThis[Symbol.for("pi-web:meta-shutdown/v1")] = shutdownDrainedWorker;

// A detached worker can be adopted after the original Web parent disconnects.
process.on("disconnect", () => {});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  const drained = globalThis.__piWebServiceRestart?.pending === true;
  if (drained && server) {
    shutdownDrainedWorker();
  } else {
    // An unguarded stop preserves the ownership marker for manual recovery.
    process.exit(1);
  }
});
start().catch(async (error) => {
  console.error("[pi-meta] Worker startup failed:", error instanceof Error ? error.message : "unknown error");
  if (!admitted) await removeOwnedArtifacts();
  process.exitCode = 1;
  if (process.connected) process.send({ type: "startup-error" }, () => process.disconnect());
});
