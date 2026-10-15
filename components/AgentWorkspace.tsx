"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PackageAgentTarget } from "@/hooks/usePackageSubagents";
import type { SessionInfo } from "@/lib/types";
import { agentPickerGroups } from "@/lib/agent-picker";
import { fleetStateLabel } from "@/lib/subagent-fleet-view";
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
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const target = targets.find((item) => item.id === selection);
  const native = [rootSession, ...subagents].find((item) => item.id === selection);
  const selectedId = target?.id ?? native?.id ?? rootSession.id;
  const selectedName = native?.name || native?.firstMessage || t("agentSwitcher.main");
  const groups = useMemo(() => agentPickerGroups(subagents, targets, runningSessionIds), [subagents, targets, runningSessionIds]);
  const selected = groups.flatMap(group => group.items).find(item => item.id === selectedId);
  const choose = (id: string) => { setSelection(id); setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    const option = picker.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]');
    option?.focus();
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return (
    <section className="agent-workspace" aria-label={t("agentSwitcher.title")}>
      <div className="agent-workspace-picker" ref={picker} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }} onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) { setOpen(true); return; }
        const options = [...(picker.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])].filter(node => node.getClientRects().length);
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
        options[next]?.focus();
      }}>
        <button ref={trigger} className="agent-picker-trigger" type="button" aria-label={t("agentSwitcher.title")} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(value => !value)}>
          <span>{selected ? `${selected.role} · ${selected.summary}` : t("agentSwitcher.main")}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {open && <div className="agent-picker-popover" id={listId} role="listbox" aria-label={t("agentSwitcher.title")}>
          <button type="button" role="option" aria-selected={selectedId === rootSession.id} data-agent-id={rootSession.id} onClick={() => choose(rootSession.id)} className="agent-picker-option">
            <span className="agent-picker-summary">{t("agentSwitcher.main")}</span>
          </button>
          {groups.map(group => {
            const rows = group.items.map((item, index) => <button type="button" role="option" aria-selected={item.id === selectedId} key={item.id} data-agent-id={item.id} onClick={() => choose(item.id)} className="agent-picker-option" title={item.detail}>
              <span className="agent-picker-summary">{item.summary}</span>
              <span className="agent-picker-meta"><span>{item.role} · {item.id.replace(/^package:/, "").slice(0, 8)}{group.items.length > 1 ? ` · ${index + 1}` : ""}</span><span data-agent-state={item.state}>{fleetStateLabel(item.state === "completed" ? "complete" : item.state)}</span></span>
            </button>);
            return group.items.length > 1 ? <div role="group" aria-label={group.items[0].summary} key={group.key} className="agent-picker-group">
              {rows[0]}
              <details open={group.items.slice(1).some(item => item.id === selectedId) || undefined}><summary>其他记录 · {group.items.length - 1}</summary>{rows.slice(1)}</details>
            </div> : rows[0];
          })}
        </div>}
      </div>
      {target ? (
        <PackageSubagentChat key={target.id} session={session} target={target} onOpenFile={onOpenFile} />
      ) : (
        <SubagentViewer key={selectedId} sessionId={selectedId} fallbackLabel={selectedName} running={runningSessionIds.has(selectedId)} onOpenFile={onOpenFile} />
      )}
    </section>
  );
}
