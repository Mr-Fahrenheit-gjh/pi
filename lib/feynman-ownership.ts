import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { serializeByKey } from "./key-serializer";
import { assertServiceNotRestarting } from "./service-restart-state";
import { basename } from "node:path";
import lockfile from "proper-lockfile";

const OPERATION_QUEUE = Symbol.for("pi-web:feynman-operation-queue:v1");
const OPERATION_SCOPE = Symbol.for("pi-web:feynman-operation-scope:v1");
type Owner = { id: string; active: boolean };
function operationScope(): AsyncLocalStorage<Owner> {
  const root = globalThis as unknown as Record<symbol, AsyncLocalStorage<Owner>>;
  return root[OPERATION_SCOPE] ??= new AsyncLocalStorage<Owner>();
}
export function withFeynmanOperation<T>(id: string, task: () => Promise<T>): Promise<T> {
  assertServiceNotRestarting();
  const owner = operationScope().getStore();
  if (owner?.active && owner.id === id) return task();
  return serializeByKey(OPERATION_QUEUE, id, () => {
    const current = { id, active: true };
    return operationScope().run(current, async () => { try { assertServiceNotRestarting(); return await task(); } finally { current.active = false; } });
  });
}

export function activeFeynmanOperationIds(): string[] {
  const root = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>;
  return [...(root[OPERATION_QUEUE]?.keys() ?? [])];
}

export function externalFeynmanOwners(snapshot: string, root: string, ownedGroups: ReadonlySet<number>): number[] {
  const found: number[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (!match || ownedGroups.has(Number(match[2]))) continue;
    const executable = basename(match[3]);
    if (executable === "node" && match[4].includes(`${root}/node_modules/`)) found.push(Number(match[1]));
  }
  return found;
}

/** Existing CLI writers do not participate in Web's lock; refuse uncertain adoption. */
export function assertNoExternalFeynmanWriter(root: string, ownedGroups: ReadonlySet<number>): void {
  const snapshot = execFileSync("ps", ["-axo", "pid=,pgid=,comm=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
  if (externalFeynmanOwners(snapshot, root, ownedGroups).length) throw new Error("独立 Feynman CLI 正在运行；网页不会同时接管其会话，请待原任务结束后再继续");
}

/** Held across the whole Web child lifetime, including idle time, not just startup. */
export async function lockFeynmanSession(path: string, onCompromised: () => void): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(path, { realpath: false, stale: 15_000, update: 5000, retries: 0, onCompromised });
  } catch {
    throw new Error("另一 Pi Web 进程持有此 Feynman 对话；未启动第二个写入者");
  }
}
