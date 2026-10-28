import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { getRpcSessionInfos, getRestartBlockingRpcSessionIds } from "./rpc-manager";
import { hasActiveSessionWorkProvider } from "./session-liveness";
import { getActiveTerminalCount } from "./terminal-manager";
import { serviceRestartState } from "./service-restart-state";
import { feynmanRestartBlockingIds } from "./feynman-rpc";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piMetaControl, piMetaStartingOrUnresolved, shutdownPiMeta } from "./pi-meta-process.mjs";

const exec = promisify(execFile);
const INSTALLED_PACKAGE = "/opt/homebrew/lib/node_modules/@agegr/pi-web";

/** Candidate/dev/remote instances must never be able to restart the formal service. */
export function isLocalServiceRequest(request: Request, mutation = false): boolean {
  const host = request.headers.get("host");
  if (!host || !/^(?:localhost|127\.0\.0\.1):30141$/.test(host)) return false;
  if (!mutation) return true;
  try { return new URL(request.headers.get("origin") ?? "").origin === `http://${host}`; }
  catch { return false; }
}

export function launchdOwnsProcess(output: string, pid: number, parentPid: number): boolean {
  const servicePid = Number(output.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
  return servicePid > 0 && (servicePid === pid || servicePid === parentPid);
}

async function supported(): Promise<boolean> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  try {
    if (await realpath(process.cwd()) !== await realpath(INSTALLED_PACKAGE)) return false;
    const { stdout } = await exec("/bin/launchctl", ["print", `gui/${process.getuid()}/cn.pi.web`], { timeout: 2500 });
    return launchdOwnsProcess(stdout, process.pid, process.ppid);
  } catch { return false; }
}

export function restartBlockers(): { sessions: number; terminals: number } {
  const sessions = new Set([...getRestartBlockingRpcSessionIds(), ...feynmanRestartBlockingIds()]);
  for (const session of getRpcSessionInfos({ includeTransient: true })) {
    if (hasActiveSessionWorkProvider({ sessionId: session.id, sessionFile: session.path })) sessions.add(session.id);
  }
  return { sessions: sessions.size + (globalThis.__piStartLocks?.size ?? 0) + (piMetaStartingOrUnresolved() ? 1 : 0), terminals: getActiveTerminalCount() };
}

export async function serviceRestartStatus() {
  const local = restartBlockers();
  let metaSessions = 0, metaTerminals = 0;
  if (!piMetaStartingOrUnresolved()) {
    try {
      const meta = await piMetaControl({ mainAgentDir: getAgentDir(), packageDir: process.cwd() }, "status");
      if (!meta.ok || !Number.isSafeInteger(meta.sessions) || !Number.isSafeInteger(meta.terminals) || (meta.sessions ?? -1) < 0 || (meta.terminals ?? -1) < 0) throw new Error("Invalid Pi Meta status");
      metaSessions = meta.sessions ?? 0;
      metaTerminals = meta.terminals ?? 0;
    } catch { metaSessions = 1; }
  }
  const { epoch, pending, error } = serviceRestartState();
  return { epoch, pending, error, supported: await supported(), sessions: local.sessions + metaSessions, terminals: local.terminals + metaTerminals };
}

/** Hold admission closed while the external, authorized updater stops Web. */
export async function acquireMetaDeploymentLease() {
  if (!await supported()) return { ok: false, status: 403, reason: "unsupported" } as const;
  const state = serviceRestartState();
  if (state.pending || piMetaStartingOrUnresolved()) return { ok: false, status: 409, reason: "busy" } as const;
  const leaseId = randomUUID();
  state.pending = true;
  state.attemptId = leaseId;
  state.deploymentLease = true;
  state.error = null;
  const owns = () => state.pending && state.attemptId === leaseId;
  const release = () => {
    if (!owns() || state.deploymentCommitted) return;
    state.pending = false;
    delete state.attemptId;
    delete state.deploymentLease;
  };
  const options = { mainAgentDir: getAgentDir(), packageDir: process.cwd() };
  let drained = false;
  try {
    const meta = await piMetaControl(options, "drain", leaseId);
    drained = meta.ok && meta.available && meta.owned === true;
    if (!owns() || !meta.ok || (meta.available && (meta.pending !== true || meta.owned !== true))) {
      throw new Error("Pi Meta is busy or could not be drained");
    }
    if (meta.available) {
      await shutdownPiMeta(options, leaseId);
      drained = false;
    }
    if (!owns()) throw new Error("Deployment lease expired");
    return { ok: true, leaseId, release } as const;
  } catch {
    if (drained) {
      try { await piMetaControl(options, "resume", leaseId); } catch { /* Preserve unresolved worker state. */ }
    }
    release();
    return { ok: false, status: 409, reason: "busy" } as const;
  }
}

export function ownsMetaDeploymentLease(leaseId: string): boolean {
  const state = serviceRestartState();
  return state.pending && state.deploymentLease === true && state.attemptId === leaseId;
}

/** Commit before bootout: a disconnected updater can no longer reopen admission. */
export function commitMetaDeploymentLease(leaseId: string): boolean {
  if (!ownsMetaDeploymentLease(leaseId)) return false;
  serviceRestartState().deploymentCommitted = true;
  return true;
}

/** Only when the caller knows that no stop command was submitted. */
export function cancelMetaDeploymentLease(leaseId: string): boolean {
  if (!ownsMetaDeploymentLease(leaseId)) return false;
  const state = serviceRestartState();
  state.pending = false;
  delete state.attemptId;
  delete state.deploymentLease;
  delete state.deploymentCommitted;
  return true;
}

/** Only invoked after a confirmed local POST. No force/ignore-busy option. */
export async function requestServiceRestart() {
  if (!await supported()) return { ok: false, status: 403, reason: "unsupported" } as const;
  const state = serviceRestartState();
  if (state.pending) return { ok: false, status: 409, reason: "pending" } as const;
  const blockers = restartBlockers();
  if (blockers.sessions || blockers.terminals) return { ok: false, status: 409, reason: "busy", ...blockers } as const;
  // Bind the local and Meta drains to one attempt; an expired attempt cannot resume another.
  const attemptId = randomUUID();
  state.pending = true;
  state.attemptId = attemptId;
  state.error = null;
  const ownsAttempt = () => state.pending && state.attemptId === attemptId;
  const finishAttempt = (error?: string) => {
    if (state.attemptId !== attemptId) return;
    state.pending = false;
    delete state.attemptId;
    if (error) state.error = error;
  };
  const metaOptions = { mainAgentDir: getAgentDir(), packageDir: process.cwd() };
  let metaDrained = false;
  const resumeMeta = async () => {
    if (!metaDrained) return;
    metaDrained = false;
    try { await piMetaControl(metaOptions, "resume", attemptId); } catch { /* Worker watchdog releases its lease. */ }
  };
  try {
    const meta = await piMetaControl(metaOptions, "drain", attemptId);
    metaDrained = meta.ok && meta.available && meta.owned === true;
    if (!ownsAttempt() || !meta.ok || (meta.available && (meta.pending !== true || meta.owned !== true))) {
      await resumeMeta(); finishAttempt();
      return { ok: false, status: 409, reason: "busy", sessions: Math.max(1, meta.sessions ?? 0), terminals: meta.terminals ?? 0 } as const;
    }
    const latest = restartBlockers();
    if (latest.sessions || latest.terminals) {
      await resumeMeta(); finishAttempt();
      return { ok: false, status: 409, reason: "busy", ...latest } as const;
    }
  } catch {
    await resumeMeta(); finishAttempt();
    return { ok: false, status: 409, reason: "busy", sessions: 1, terminals: 0 } as const;
  }
  let committed = false;
  const watchdog = setTimeout(() => {
    if (!ownsAttempt() || committed) return;
    finishAttempt("restart-timeout");
    void resumeMeta();
  }, 12_000);
  watchdog.unref();
  const timer = setTimeout(async () => {
    try {
      const meta = await piMetaControl(metaOptions, "status", attemptId);
      if (!ownsAttempt()) { await resumeMeta(); return; }
      let latest = restartBlockers();
      if (!meta.ok || (meta.available && (meta.pending !== true || meta.owned !== true || meta.sessions !== 0 || meta.terminals !== 0)) || latest.sessions || latest.terminals) {
        clearTimeout(watchdog); await resumeMeta(); finishAttempt("busy"); return;
      }
      if (meta.available) {
        // Stop the drained worker before a later upgrade can replace its Web package.
        await shutdownPiMeta(metaOptions, attemptId);
        metaDrained = false;
      }
      if (!ownsAttempt()) return;
      latest = restartBlockers();
      if (latest.sessions || latest.terminals) {
        clearTimeout(watchdog); finishAttempt("busy"); return;
      }
      committed = true;
      clearTimeout(watchdog);
      execFile("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/cn.pi.web`], { timeout: 5000 }, (error) => {
        if (!error || !ownsAttempt()) return;
        // A failed spawn cannot have submitted launchctl; an uncertain exit can.
        if (typeof error.code === "string" && ["ENOENT", "EACCES"].includes(error.code)) finishAttempt("restart-failed");
        else state.error = "restart-failed";
      });
    } catch {
      if (committed) {
        if (ownsAttempt()) state.error = "restart-failed";
        return;
      }
      clearTimeout(watchdog); await resumeMeta(); finishAttempt("busy");
    }
  }, 500);
  timer.unref();
  return { ok: true, epoch: state.epoch } as const;
}
