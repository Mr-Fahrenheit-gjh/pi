"use client";

import { useEffect, useMemo, useState } from "react";
import { fleetIsActive, fleetRequest, fleetUrl, normalizeFleetView, type FleetView } from "@/lib/subagent-fleet-view";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";

export type PackageAgentTarget = { id: string; runId?: string; index?: number; label: string; state: string; role: string };

/** One list owner, shared by the native toolbar and read-only child view. */
export function usePackageSubagents(session: SessionInfo | null) {
  const sessionId = session?.id;
  const [snapshot, setSnapshot] = useState<{ sessionId: string; view: FleetView } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    let controller: AbortController | null = null;
    const load = async () => {
      if (controller || document.visibilityState !== "visible") return;
      controller = new AbortController();
      const request = controller;
      const timeout = window.setTimeout(() => request.abort(), 15_000);
      try {
        const view = normalizeFleetView(await fleetRequest(fleetUrl(sessionId), request.signal));
        if (alive) setSnapshot({ sessionId, view });
      } catch { /* The task panel displays connection errors without disrupting chat. */ }
      finally { window.clearTimeout(timeout); controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [sessionId]);
  const view = snapshot?.sessionId === sessionId ? snapshot?.view : null;
  const targets = useMemo<PackageAgentTarget[]>(() => {
    const runs = (view?.runs ?? []).flatMap<PackageAgentTarget>((run) => {
      if (!run.id) return [];
      const steps = run.children.filter((child) => child.kind === "step");
      return steps.length > 1 ? steps.map((child, index) => ({ id: `package:${run.id}:${index}`, runId: run.id, index,
        label: child.label, state: child.state, role: child.role ?? child.label })) : [{
        id: `package:${run.id}`, runId: run.id, label: run.label, state: run.state, role: steps[0]?.role ?? steps[0]?.label ?? run.role ?? run.label,
      }];
    });
    // Opaque foreground keys are never sent as control IDs.
    return view?.fleet.length && runs.length === 0
      ? [{ id: "package:foreground", label: "前台子代理", state: "running", role: "子代理" }, ...runs] : runs;
  }, [view]);
  const sessions = useMemo(() => session ? targets.map((target): SessionInfo => ({ ...session, id: target.id, path: "", name: target.label, firstMessage: target.label,
    relation: { kind: "subagent", parentSessionId: session.id, profile: target.role, description: target.label,
      status: (target.state === "complete" ? "completed" : ["paused", "stopped", "partial"].includes(target.state) ? "interrupted" : target.state) as SubagentSessionStatus } })) : [], [session, targets]);
  const running = useMemo(() => targets.filter((target) => fleetIsActive(target.state)).map((target) => target.id), [targets]);
  return { targets, sessions, running };
}
