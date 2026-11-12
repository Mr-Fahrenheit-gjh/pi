import { englishText } from "./i18n/english.mjs";
import type { UiTranslate } from "./i18n/types";
// Client-safe projections. Fleet keys and workflow child ids are never control targets.
export interface FleetRow {
  key: string;
  id?: string;
  label: string;
  state: string;
  kind?: string;
  role?: string;
  model?: string;
  activity?: string;
  metrics: { label: string; value: number }[];
  children: FleetRow[];
}
export interface FleetView {
  available: boolean;
  error?: string;
  text?: string;
  details?: unknown;
  runs: FleetRow[];
  fleet: FleetRow[];
  totalActive?: number;
  omitted: number;
  omittedRuns: number;
  omittedChildren: number;
  active: boolean;
}
export type FleetMethod = "steer" | "stop" | "resume" | "interrupt";
export type SteerMode = "steer" | "follow_up" | "auto";

export { record as asRecord };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** Accept safe public run identifiers, not paths, truncated labels or opaque fleet keys. */
export function fleetRunId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    && !value.startsWith("fleet-") && value !== "async" ? value : undefined;
}
export function fleetState(value: unknown): string {
  const state = text(value) ?? "unknown";
  return state === "completed" ? "complete" : state === "pending" ? "queued" : state;
}
export function fleetStateLabel(state: string, t: UiTranslate = englishText): string {
  const known = ["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected", "interrupted", "unknown"];
  return known.includes(state) ? t(`fleet.state.${state}`) : state;
}
export function fleetIsActive(state: string): boolean { return state === "running" || state === "queued"; }
export function fleetCanResume(state: string): boolean {
  return ["complete", "failed", "partial", "paused"].includes(state);
}
function metrics(source: Record<string, unknown>, t: UiTranslate): FleetRow["metrics"] {
  const tokens = record(source.tokens);
  const usage = record(source.usage);
  const cost = record(source.cost ?? usage.cost);
  const candidates: [string, unknown][] = [
    ["Tokens", typeof source.tokens === "number" ? source.tokens : tokens.total ?? usage.totalTokens ?? source.totalTokens],
    [t("fleet.metric.input"), tokens.input ?? usage.input], [t("fleet.metric.output"), tokens.output ?? usage.output],
    [t("fleet.metric.context"), tokens.window], [t("fleet.metric.cost"), typeof source.cost === "number" ? source.cost : cost.total],
  ];
  return candidates.flatMap(([label, value]) => {
    const valid = number(value);
    return valid === undefined ? [] : [{ label, value: valid }];
  });
}
function row(value: unknown, key: string, control: boolean, depth = 0, t: UiTranslate = englishText): FleetRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = record(value);
  const activity = record(source.activity);
  const state = fleetState(source.state ?? source.status);
  const kind = text(source.kind);
  return {
    key,
    // Only root snapshot nodes may identify runs. Steps/host steps use other namespaces.
    id: control && kind !== "step" && kind !== "host-step" ? fleetRunId(source.id) : undefined,
    label: text(source.label) ?? text(source.agent) ?? text(source.name) ?? t("fleet.task"),
    state,
    ...(kind ? { kind } : {}),
    role: text(source.role) ?? text(source.agent),
    model: text(source.model) ?? text(source.modelId),
    activity: text(activity.currentTool) ?? text(activity.state) ?? text(source.goal),
    metrics: metrics(source, t),
    children: depth < 3 ? array(source.children).flatMap((child, index) => {
      const projected = row(child, `${key}/${index}`, false, depth + 1, t);
      return projected ? [projected] : [];
    }) : [],
  };
}
function rowIsActive(row: FleetRow): boolean {
  return fleetIsActive(row.state) || row.children.some(rowIsActive);
}
export function normalizeFleetView(value: unknown, t: UiTranslate = englishText): FleetView {
  const source = record(value);
  const snapshot = record(source.asyncSnapshot);
  const fleet = record(source.fleet);
  const seen = new Set<string>();
  const runs = array(snapshot.runs).flatMap((value, index) => {
    const projected = row(value, `run/${index}`, true, 0, t);
    if (!projected) return [];
    if (projected.id && seen.has(projected.id)) return [];
    if (projected.id) { seen.add(projected.id); projected.key = `run/${projected.id}`; }
    return [projected];
  });
  const entries = array(fleet.entries).flatMap((value, index) => {
    const projected = row(value, `fleet/${index}`, false, 0, t);
    if (!projected) return [];
    projected.state = "running"; // Public fleet contains active children only.
    return [projected];
  });
  const omitted = record(snapshot.omitted);
  const totalActive = number(fleet.totalActive);
  return {
    available: source.available === true, error: text(source.error), text: text(source.text), details: source.details,
    runs, fleet: entries, totalActive, omitted: number(fleet.omitted) ?? 0,
    omittedRuns: number(omitted.runs) ?? 0, omittedChildren: number(omitted.children) ?? 0,
    active: runs.some(rowIsActive) || entries.length > 0 || (totalActive ?? 0) > 0,
  };
}
export function fleetCostText(value: unknown, t: UiTranslate = englishText, locale = "en"): string {
  const report = record(value);
  const usageLine = (label: string, value: unknown) => {
    const usage = record(value);
    const tokens = ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (number(usage[key]) ?? 0), 0);
    const cost = number(usage.cost);
    return `${label}: ${tokens.toLocaleString(locale)} tokens${cost === undefined ? "" : ` · $${cost.toFixed(6)}`}`;
  };
  const lines = [usageLine(t("fleet.mainSession"), report.parent), usageLine(t("fleet.subagents"), report.childTotal), usageLine(t("fleet.total"), report.total)];
  for (const child of array(report.children)) { const entry = record(child); lines.push(usageLine(text(entry.label) ?? text(entry.agent) ?? t("fleet.subagents"), entry.usage)); }
  if ((number(report.unresolvedAsyncChildren) ?? 0) > 0) lines.push(t("fleet.unresolvedUsage", { count: Number(report.unresolvedAsyncChildren) }));
  return lines.join("\n");
}
export function fleetReadableDetails(value: unknown, t: UiTranslate = englishText): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return t("fleet.detailsFailed"); }
}
export function fleetCommand(method: FleetMethod, id: string, message?: string, mode: SteerMode = "auto") {
  if (!fleetRunId(id)) throw new Error(englishText("fleet.invalidRun"));
  if ((method === "steer" || method === "resume") && !message?.trim()) throw new Error(englishText("fleet.messageRequired"));
  return { method, params: { id, ...(method === "steer" || method === "resume" ? { message: message!.trim() } : {}),
    ...(method === "steer" ? { mode } : {}) } };
}
export function fleetUrl(sessionId: string, runId?: string): string {
  const base = `/api/agent/${encodeURIComponent(sessionId)}/subagents`;
  if (runId === undefined) return base;
  if (!fleetRunId(runId)) throw new Error(englishText("fleet.invalidRun"));
  return `${base}?${new URLSearchParams({ id: runId, view: "transcript", lines: "100" })}`;
}
/** POST returns RPC data directly; do not mistake its optional text/details for a GET envelope. */
export async function fleetRequest(url: string, signal: AbortSignal, body?: ReturnType<typeof fleetCommand>): Promise<unknown> {
  const response = await fetch(url, { signal, cache: "no-store", ...(body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {}) });
  const value: unknown = await response.json();
  const data = record(value);
  if (!response.ok || data.error || data.success === false) {
    throw new Error(text(data.error) ?? text(record(data.error).message) ?? englishText("fleet.requestStatus", { status: response.status }));
  }
  return value;
}
