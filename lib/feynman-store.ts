import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "./session-reader";
import { computeSessionStats } from "./session-stats";
import { computeSessionTotalActiveMs } from "./session-timing";
import { projectTreeForResponse, toSummaryTree } from "./project-tree";
import type { SessionEntry, SessionInfo } from "./types";

export function feynmanPaths(root = process.env.PI_WEB_FEYNMAN_ROOT || join(homedir(), "Documents/pi/工具/科研idea流水线/feynman独立环境")) {
  const home = join(resolve(root), ".runtime/home/.feynman");
  return {
    root: resolve(root), home, agent: join(home, "agent"),
    sessions: join(home, "sessions"),
    launcher: join(resolve(root), "run-feynman.py"),
    sdk: join(resolve(root), "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"),
  };
}

type ManagerClass = typeof SessionManager;
let managerPromise: Promise<ManagerClass> | undefined;

/** Only the independent SDK's disk reader; never imports Feynman's executable main. */
export function feynmanSessionManager(): Promise<ManagerClass> {
  return managerPromise ??= (async () => {
    const sdk = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(feynmanPaths().sdk).href);
    if (typeof sdk.SessionManager?.listAll !== "function" || typeof sdk.SessionManager?.open !== "function") {
      throw new Error("Feynman session reader is incompatible");
    }
    return sdk.SessionManager as ManagerClass;
  })().catch((error) => { managerPromise = undefined; throw error; });
}

export async function listFeynmanSessions(): Promise<SessionInfo[]> {
  const directory = feynmanPaths().sessions;
  if (!existsSync(directory)) return [];
  const manager = await feynmanSessionManager();
  const sessions = await manager.listAll(directory);
  const idsByPath = new Map(sessions.map((session) => [resolve(session.path), session.id]));
  return sessions.map((session) => {
    const parentId = session.parentSessionPath ? idsByPath.get(resolve(session.parentSessionPath)) : undefined;
    return {
      id: session.id, path: session.path, cwd: session.cwd, name: session.name,
      created: new Date(session.created).toISOString(), modified: new Date(session.modified).toISOString(),
      messageCount: session.messageCount, firstMessage: session.firstMessage.slice(0, 500),
      projectRoot: session.cwd, projectKey: session.cwd,
      ...(parentId ? { parentSessionId: parentId, relation: { kind: "fork" as const, originSessionId: parentId } } : {}),
    };
  });
}

export async function resolveFeynmanSession(id: string): Promise<SessionInfo | undefined> {
  if (!/^[\w-]{1,100}$/.test(id)) return undefined;
  return (await listFeynmanSessions()).find((session) => session.id === id);
}

export interface FeynmanLiveHistory {
  cwd: string; created: string; sessionFile: string;
  state?: { sessionName?: string; thinkingLevel?: string; model?: { provider: string; id: string } };
  send(command: Record<string, unknown>): Promise<unknown>;
}

export async function readFeynmanSession(id: string, params = new URLSearchParams(), live?: FeynmanLiveHistory) {
  let info = await resolveFeynmanSession(id);
  if (!info && !live) return null;
  const Manager = await feynmanSessionManager();
  const fromMemory = Boolean(live && !info);
  let manager: SessionManager;
  let entries: SessionEntry[];
  let leafId: string | null;
  if (live && !info) {
    const snapshot = await live.send({ type: "get_entries" }) as { entries: SessionEntry[]; leafId: string | null };
    if (!Array.isArray(snapshot?.entries) || (snapshot.leafId !== null && typeof snapshot.leafId !== "string")) throw new Error("Feynman returned an incompatible history snapshot");
    entries = snapshot.entries;
    leafId = snapshot.leafId;
    const header = Manager.inMemory(live.cwd, { id }).getHeader();
    if (!header) throw new Error("Feynman session reader has no header");
    manager = Manager.inMemory(live.cwd, { id }, [header, ...entries] as never);
    const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const content = firstUser?.type === "message" && firstUser.message.role === "user" ? firstUser.message.content : undefined;
    const firstMessage = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
    info ??= { id, path: live.sessionFile, cwd: live.cwd, projectRoot: live.cwd, projectKey: live.cwd,
      created: live.created, modified: new Date().toISOString(), name: live.state?.sessionName,
      firstMessage: firstMessage.slice(0, 500) || "(no messages)", messageCount: entries.filter((entry) => entry.type === "message").length,
      transient: !existsSync(live.sessionFile) };
  } else {
    manager = Manager.open(info!.path, feynmanPaths().sessions);
    entries = manager.getEntries() as unknown as SessionEntry[];
    leafId = manager.getLeafId();
  }
  const tail = Math.max(1, Math.min(1000, Number(params.get("tail")) || 50));
  const before = params.get("before");
  const summary = params.get("tree") === "summary";
  const tree = projectTreeForResponse(manager.getTree());
  const filePath = info!.path;
  const diskRevision = existsSync(filePath) ? statSync(filePath).mtimeMs : "transient";
  const context = buildSessionContext(entries as never, before || params.get("leafId") || leafId, { tail, excludeLeaf: Boolean(before) });
  if (fromMemory && live?.state) {
    if (!context.model && live.state.model) context.model = { provider: live.state.model.provider, modelId: live.state.model.id };
    if (live.state.thinkingLevel) context.thinkingLevel = live.state.thinkingLevel;
  }
  return {
    sessionId: id, filePath, info: info!, leafId,
    tree: summary ? toSummaryTree(tree) : tree,
    ...(summary ? { treeFormat: "summary" as const } : {}),
    snapshotRevision: `feynman:${fromMemory ? "live:" : "disk:"}${diskRevision}:${entries.length}:${leafId}`,
    context,
    stats: computeSessionStats(entries), totalActiveMs: computeSessionTotalActiveMs(entries as never),
  };
}
