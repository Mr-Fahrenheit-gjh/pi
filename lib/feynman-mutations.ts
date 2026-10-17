import { unlinkSync } from "node:fs";
import { assertNoExternalFeynmanWriter, lockFeynmanSession, withFeynmanOperation } from "./feynman-ownership";
import { feynmanPaths, feynmanSessionManager, resolveFeynmanSession } from "./feynman-store";
import { feynmanLiveSessions, getFeynmanSession } from "./feynman-rpc";
import type { SessionInfo } from "./types";

export class FeynmanMutationError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); }
}
type Mutation = { type: "rename"; name: string } | { type: "delete" };

export function mutateFeynmanSession(id: string, mutation: Mutation): Promise<void> {
  return withFeynmanOperation(id, async () => {
    const info = await resolveFeynmanSession(id);
    if (!info) throw new FeynmanMutationError("Feynman session not found", 404);
    const live = getFeynmanSession(id);
    if (mutation.type === "delete" && live?.isRunning()) throw new FeynmanMutationError("请先停止此 Feynman 任务再删除对话", 409);
    const diskMutation = async (expected: SessionInfo) => {
      // Resolve again under the exclusive lease, not from a stale sidebar snapshot.
      const current = await resolveFeynmanSession(id);
      if (!current || current.path !== expected.path) throw new FeynmanMutationError("Feynman 会话已变化，未修改", 409);
      if (mutation.type === "delete") unlinkSync(current.path);
      else {
        const Manager = await feynmanSessionManager();
        Manager.open(current.path, feynmanPaths().sessions).appendSessionInfo(mutation.name.trim());
      }
    };
    if (live) {
      if (mutation.type === "rename") await live.send({ type: "set_session_name", name: mutation.name.trim() });
      else await live.stopAndMutate(() => diskMutation(info));
      return;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      assertNoExternalFeynmanWriter(feynmanPaths().root, new Set(feynmanLiveSessions().flatMap((session) => session.processGroup ? [session.processGroup] : [])));
      release = await lockFeynmanSession(info.path, () => {});
      await diskMutation(info);
    } catch (error) {
      if (error instanceof FeynmanMutationError) throw error;
      throw new FeynmanMutationError(error instanceof Error ? error.message : String(error), 409);
    } finally { await release?.(); }
  });
}
