import type { PackageAgentTarget } from "../hooks/usePackageSubagents";
import type { SessionInfo } from "./types";
import { englishText } from "./i18n/english.mjs";
import type { UiTranslate } from "./i18n/types";

export interface AgentPickerItem { id: string; role: string; summary: string; detail: string; state: string; }
export interface AgentPickerGroup { key: string; items: AgentPickerItem[]; }

/** Display-only cleanup: identities and transcript routing are never inferred from titles. */
export function agentSummary(label: string, role: string, id: string, t: UiTranslate = englishText): string {
  let text = label.trim();
  for (let i = 0; i < 3; i++) {
    if (role && text.toLowerCase().startsWith(`${role.toLowerCase()}:`)) text = text.slice(role.length + 1).trim();
    else if (role && text.toLowerCase().startsWith(`${role.toLowerCase()} ·`)) text = text.slice(role.length + 2).trim();
    else break;
  }
  if (/^You are reviving a previous subagent conversation\./i.test(text)) {
    // Only use an explicit original task field; never show orchestration boilerplate as a task.
    const original = text.match(/(?:Original task|Original prompt)\s*:\s*([\s\S]+)/i)?.[1];
    text = original?.trim() || t("agentPicker.revived", { id: id.replace(/^package:/, "").slice(0, 8) });
  }
  return text.replace(/\s+/g, " ").trim() || t("agentPicker.fallback", { id: id.slice(-8) });
}

export function agentPickerGroups(subagents: SessionInfo[], targets: PackageAgentTarget[], running: ReadonlySet<string>, t: UiTranslate = englishText): AgentPickerGroup[] {
  const items: AgentPickerItem[] = [
    ...subagents.map(child => {
      const relation = child.relation?.kind === "subagent" ? child.relation : null;
      const role = relation?.profile || t("agentSwitcher.subagent");
      const detail = relation?.description || child.name || child.firstMessage || "";
      return { id: child.id, role, detail, summary: agentSummary(detail, role, child.id, t), state: running.has(child.id) ? "running" : relation?.status || "unknown" };
    }),
    ...targets.map(child => ({ id: child.id, role: child.role.length <= 40 ? child.role : t("agentSwitcher.subagent"), detail: child.label,
      summary: agentSummary(child.label, child.role.length <= 40 ? child.role : "", child.id, t), state: child.state })),
  ];
  const groups = new Map<string, AgentPickerGroup>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // Identical summaries share presentation only. Every exact run/step remains selectable.
    // Unknown revival records stay separate; a role alone is never a lineage key.
    const revived = t("agentPicker.revived", { id: item.id.replace(/^package:/, "").slice(0, 8) });
    const key = item.summary === revived ? item.id : `${item.role}\0${item.summary}`;
    const group = groups.get(key) || { key, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
