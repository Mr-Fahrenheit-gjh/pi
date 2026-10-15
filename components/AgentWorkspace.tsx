"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PackageAgentTarget } from "@/hooks/usePackageSubagents";
import type { SessionInfo } from "@/lib/types";
import { PackageSubagentChat } from "./PackageSubagentChat";
import { SubagentViewer } from "./SubagentViewer";

/** Read-only conversations in the right workspace; never retargets the composer. */
export function AgentWorkspace({ session, rootSession, subagents, targets, runningSessionIds, onOpenFile }: {
  session: SessionInfo;
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  targets: PackageAgentTarget[];
  runningSessionIds: Set<string>;
  onOpenFile: (path: string, page?: number) => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState(rootSession.id);
  const target = targets.find((item) => item.id === selection);
  const native = [rootSession, ...subagents].find((item) => item.id === selection);
  const selectedId = target?.id ?? native?.id ?? rootSession.id;
  const selectedName = native?.name || native?.firstMessage || t("agentSwitcher.main");
  return (
    <section className="agent-workspace" aria-label={t("agentSwitcher.title")}>
      <div className="agent-workspace-picker">
        <select aria-label={t("agentSwitcher.title")} value={selectedId} onChange={(event) => setSelection(event.target.value)}>
          <option value={rootSession.id}>{t("agentSwitcher.main")}</option>
          {subagents.map((child) => <option key={child.id} value={child.id}>{child.relation?.kind === "subagent" ? child.relation.profile : child.name || child.firstMessage}</option>)}
          {targets.map((child) => <option key={child.id} value={child.id}>{child.role} · {child.label}</option>)}
        </select>
      </div>
      {target ? (
        <PackageSubagentChat key={target.id} session={session} target={target} onOpenFile={onOpenFile} />
      ) : (
        <SubagentViewer key={selectedId} sessionId={selectedId} fallbackLabel={selectedName} running={runningSessionIds.has(selectedId)} onOpenFile={onOpenFile} />
      )}
    </section>
  );
}
