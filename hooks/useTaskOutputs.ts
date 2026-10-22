"use client";

import { useEffect, useState } from "react";
import { runtimeFetch as fetch, pageRuntime } from "@/lib/runtime-client.mjs";
import { MAX_TASK_OUTPUTS, taskOutputPath } from "@/lib/task-outputs";

/** Mounted only for the visible Outputs tab; hidden views do not poll or load history. */
export function useTaskOutputs(sessionId: string, cwd: string, leafId: string | null, refreshKey: number) {
  const scope = JSON.stringify([pageRuntime(), sessionId, cwd, leafId]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ scope: string; paths: string[]; loading: boolean; failed: boolean; truncated: boolean }>({ scope: "", paths: [], loading: true, failed: false, truncated: false });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ scope, paths: previous.scope === scope ? previous.paths : [], loading: true, failed: false, truncated: false }));
    const query = leafId ? `?${new URLSearchParams({ leafId })}` : "";
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/outputs${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Conversation files unavailable");
        const data = await response.json();
        if (data.sessionId !== sessionId || !Array.isArray(data.paths)) throw new Error("Invalid conversation files response");
        const paths = [...new Set((data.paths as unknown[]).map(path => taskOutputPath(path, cwd)).filter((path): path is string => path !== null))];
        if (!controller.signal.aborted) setState({ scope, paths: paths.slice(0, MAX_TASK_OUTPUTS), loading: false, failed: false, truncated: data.truncated === true || paths.length > MAX_TASK_OUTPUTS });
      }).catch(() => {
        if (!controller.signal.aborted) setState(previous => ({ scope, paths: previous.scope === scope ? previous.paths : [], loading: false, failed: true, truncated: false }));
      });
    return () => controller.abort();
  }, [sessionId, cwd, leafId, scope, refreshKey, retry]);
  const current = state.scope === scope;
  return {
    paths: current ? state.paths : [], loading: !current || state.loading, failed: current && state.failed, truncated: current && state.truncated,
    refresh: () => setRetry(value => value + 1),
  };
}
