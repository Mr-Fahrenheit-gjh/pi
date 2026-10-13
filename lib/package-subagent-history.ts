import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRegularFileText } from "./regular-file";
import { asRecord } from "./subagent-fleet-view";

// Read-only compatibility adapter for pi-subagents 0.75 persisted status artifacts.
// RPC stays the only control path. Unknown/corrupt artifacts fail closed.
export function packageRunRoot(): string | undefined {
  if (process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()) return join(resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim()), "async-subagent-runs");
  if (!process.getuid) return undefined;
  return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`, "async-subagent-runs");
}

export function readOwnedPackageRun(id: string, parentFile: string, root = packageRunRoot()): Record<string, unknown> | undefined {
  if (!root || !/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(id)) return undefined;
  try {
    const runDir = join(root, id);
    const statusPath = join(runDir, "status.json");
    if (lstatSync(runDir).isSymbolicLink() || lstatSync(statusPath).isSymbolicLink()) return undefined;
    const status = asRecord(JSON.parse(readRegularFileText(statusPath, 4 * 1024 * 1024) ?? "null"));
    if (status?.runId !== id || typeof status.sessionId !== "string" || !Array.isArray(status.steps)
      || realpathSync(status.sessionId) !== realpathSync(parentFile)) return undefined;
    const steps = status.steps.map(asRecord).filter((step): step is Record<string, unknown> => Boolean(step)).map((step) => ({
      agent: step.agent, sessionName: step.sessionName, status: step.status, model: step.model,
      startedAt: step.startedAt, endedAt: step.endedAt,
    }));
    return { id, kind: status.mode, label: steps[0]?.sessionName ?? steps[0]?.agent ?? id, state: status.state, startedAt: status.startedAt, endedAt: status.endedAt,
      children: steps.map((step, index) => ({ id: `step:${index}`, kind: "step", label: step.sessionName ?? step.agent, role: step.agent, state: step.status, model: step.model })), historical: true };
  } catch { return undefined; }
}

export function listOwnedPackageRuns(parentFile: string, root = packageRunRoot()): Record<string, unknown>[] {
  if (!root) return [];
  try {
    return readdirSync(root).flatMap((id) => {
      const run = readOwnedPackageRun(id, parentFile, root);
      return run ? [run] : [];
    }).sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0));
  } catch { return []; }
}
