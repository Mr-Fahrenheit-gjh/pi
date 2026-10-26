import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readRegularFileText } from "./regular-file";
import { serializeByKey } from "./key-serializer";
import { isReadToken, isSessionReadId, type SessionReadRequest, type SessionReadSnapshot } from "./session-read-state-shared";

interface StoredState { version: 1; revision: number; entries: Record<string, number> }
const QUEUE = Symbol.for("pi-web:session-read-state-write-queue");
const MAX_BYTES = 4 * 1024 * 1024;
// Shared across route bundles/HMR, as is the write queue. Never reset a known file.
declare global { var __piWebReadStateRevisions: Map<string, number> | undefined }
const revisions = () => globalThis.__piWebReadStateRevisions ??= new Map();
const statePath = () => join(getAgentDir(), "pi-web-session-read-state.json");
function load(path: string): StoredState {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Session read state is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const text = readRegularFileText(path, MAX_BYTES);
  if (text === undefined) {
    if (revisions().has(path)) throw new Error("Session read state disappeared");
    return { version: 1, revision: 0, entries: {} };
  }
  const state = JSON.parse(text) as StoredState;
  if (!state || state.version !== 1 || !isReadToken(state.revision) || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)
    || Object.keys(state).some(key => !["version", "revision", "entries"].includes(key))
    || Object.entries(state.entries).some(([id, token]) => !isSessionReadId(id) || !isReadToken(token) || token > state.revision)
    || state.revision < (revisions().get(path) ?? 0)) throw new Error("Invalid session read state");
  revisions().set(path, state.revision);
  return state;
}
function snapshot(state: StoredState): SessionReadSnapshot {
  return { revision: state.revision, unread: Object.fromEntries(Object.entries(state.entries).filter(([, token]) => token > 0)) };
}
export function readSessionReadState(path = statePath()): SessionReadSnapshot { return snapshot(load(path)); }

function mutate(edit: (entries: Record<string, number>, token: number) => boolean, path: string): Promise<SessionReadSnapshot> {
  return serializeByKey(QUEUE, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let compromised = false;
    const release = await lockfile.lock(path, {
      realpath: false, stale: 10_000,
      retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
      onCompromised: () => { compromised = true; },
    });
    try {
      const state = load(path);
      const token = state.revision + 1;
      if (!edit(state.entries, token)) return snapshot(state);
      if (!Number.isSafeInteger(token) || compromised) throw new Error("Session read state cannot advance safely");
      state.revision = token;
      const text = JSON.stringify(state) + "\n";
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Session read state is full");
      writePrivateFileAtomicSync(path, text);
      revisions().set(path, token);
      return snapshot(state);
    } finally { await release(); }
  });
}
export function updateSessionReadState(request: SessionReadRequest, path = statePath()): Promise<SessionReadSnapshot> {
  return mutate((entries, token) => {
    let changed = false;
    if (request.action === "read") {
      for (const entry of request.entries) {
        const recorded = Object.hasOwn(entries, entry.id);
        if ((recorded ? entries[entry.id] === entry.token : entry.token === 0) && (!recorded || entries[entry.id] !== 0)) {
          Object.defineProperty(entries, entry.id, { value: 0, enumerable: true, writable: true, configurable: true });
          changed = true;
        }
      }
    } else {
      for (const id of request.ids) {
        const recorded = Object.hasOwn(entries, id);
        if (request.action === "import" ? recorded : recorded && entries[id] > 0) continue;
        Object.defineProperty(entries, id, { value: token, enumerable: true, writable: true, configurable: true });
        changed = true;
      }
    }
    return changed;
  }, path);
}
/** Called synchronously at the wrapper's existing start/true-completion hooks; one queue preserves their order. */
export function recordSessionReadLifecycle(id: string, phase: "start" | "complete", path = statePath()): Promise<SessionReadSnapshot> {
  return mutate((entries, token) => {
    if (!isSessionReadId(id)) throw new Error("Invalid session id");
    if (phase === "start" && Object.hasOwn(entries, id) && entries[id] === 0) return false;
    Object.defineProperty(entries, id, { value: phase === "start" ? 0 : token, enumerable: true, writable: true, configurable: true });
    return true;
  }, path);
}
export function forgetSessionReadState(ids: readonly string[], path = statePath()): Promise<SessionReadSnapshot> {
  return mutate(entries => {
    let changed = false;
    for (const id of ids) if (Object.hasOwn(entries, id)) { delete entries[id]; changed = true; }
    return changed;
  }, path);
}
