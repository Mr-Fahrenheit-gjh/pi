import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { getRpcSessionInfos, getRestartBlockingRpcSessionIds } from "./rpc-manager";
import { hasActiveSessionWorkProvider } from "./session-liveness";
import { getActiveTerminalCount } from "./terminal-manager";
import { serviceRestartState } from "./service-restart-state";

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
  const sessions = new Set(getRestartBlockingRpcSessionIds());
  for (const session of getRpcSessionInfos({ includeTransient: true })) {
    if (hasActiveSessionWorkProvider({ sessionId: session.id, sessionFile: session.path })) sessions.add(session.id);
  }
  return { sessions: sessions.size + (globalThis.__piStartLocks?.size ?? 0), terminals: getActiveTerminalCount() };
}

export async function serviceRestartStatus() {
  return { ...serviceRestartState(), supported: await supported(), ...restartBlockers() };
}

/** Only invoked after a confirmed local POST. No force/ignore-busy option. */
export async function requestServiceRestart() {
  if (!await supported()) return { ok: false, status: 403, reason: "unsupported" } as const;
  const state = serviceRestartState();
  if (state.pending) return { ok: false, status: 409, reason: "pending" } as const;
  const blockers = restartBlockers();
  if (blockers.sessions || blockers.terminals) return { ok: false, status: 409, reason: "busy", ...blockers } as const;
  // No await between the last check and draining new prompts/PTYs.
  state.pending = true;
  state.error = null;
  const watchdog = setTimeout(() => { state.pending = false; state.error = "restart-timeout"; }, 12_000);
  watchdog.unref();
  const timer = setTimeout(() => {
    // Protect extension liveness that may have changed since the request.
    const latest = restartBlockers();
    if (latest.sessions || latest.terminals) {
      clearTimeout(watchdog); state.pending = false; state.error = "busy"; return;
    }
    execFile("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/cn.pi.web`], { timeout: 5000 }, (error) => {
      if (error) { clearTimeout(watchdog); state.pending = false; state.error = "restart-failed"; }
    });
  }, 500);
  timer.unref();
  return { ok: true, epoch: state.epoch } as const;
}
