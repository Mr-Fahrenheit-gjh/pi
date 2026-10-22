"use client";

import { useEffect, useRef, useState } from "react";
import { runtimeStorageKey } from "@/lib/runtime-client.mjs";
import { MAX_TASK_OUTPUTS, outputPathForCwd, parseTaskOutputs, taskOutputKey } from "@/lib/task-outputs";

/** Hydration never persists an empty initial list over saved references. */
export function useTaskOutputs(sessionId: string | null, cwd: string | null) {
  const key = sessionId && cwd ? runtimeStorageKey(taskOutputKey(sessionId, cwd)) : null;
  const [state, setState] = useState<{ key: string | null; paths: string[]; persisted: boolean }>({ key: null, paths: [], persisted: true });
  const fallback = useRef(new Map<string, { paths: string[]; persisted: boolean }>());
  const ready = key !== null && state.key === key;
  const paths = ready ? state.paths : [];
  useEffect(() => {
    let paths: string[] = [], persisted = true;
    const cached = key ? fallback.current.get(key) : undefined;
    if (cached && !cached.persisted) { paths = cached.paths; persisted = false; }
    else {
      try { if (key && cwd) paths = parseTaskOutputs(localStorage.getItem(key), cwd); }
      catch { paths = cached?.paths ?? []; persisted = false; }
    }
    setState({ key, paths, persisted });
  }, [key, cwd]);

  function update(next: string[]) {
    if (!key || !ready) return;
    let persisted = true;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { persisted = false; }
    fallback.current.set(key, { paths: next, persisted });
    setState({ key, paths: next, persisted });
  }
  return {
    paths, ready, persisted: state.key === key ? state.persisted : true,
    pin(input: string) {
      const path = cwd ? outputPathForCwd(input, cwd) : null;
      if (!ready || !path || paths.includes(path) || paths.length >= MAX_TASK_OUTPUTS) return;
      update([...paths, path]);
    },
    remove(path: string) { update(paths.filter(item => item !== path)); },
  };
}
