import { randomUUID } from "node:crypto";

type RestartState = { epoch: string; pending: boolean; error: string | null };
declare global { var __piWebServiceRestart: RestartState | undefined; }
export function serviceRestartState(): RestartState {
  return globalThis.__piWebServiceRestart ??= { epoch: randomUUID(), pending: false, error: null };
}
export function assertServiceNotRestarting(): void {
  if (serviceRestartState().pending) throw new Error("Pi Web is restarting; retry after reconnecting");
}
