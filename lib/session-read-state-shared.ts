import { SESSION_ID_PATTERN } from "./session-ui-state-shared";

export interface SessionReadSnapshot { revision: number; unread: Record<string, number> }
export type SessionReadRequest =
  | { action: "read"; entries: { id: string; token: number }[] }
  | { action: "unread" | "import"; ids: string[] };
export const MAX_SESSION_READ_IDS = 500;
export const MAX_SESSION_READ_BODY_BYTES = 128 * 1024;
export function isSessionReadId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && SESSION_ID_PATTERN.test(value);
}
export function isReadToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseSessionReadSnapshot(value: unknown): SessionReadSnapshot | null {
  if (!object(value) || !isReadToken(value.revision) || !object(value.unread)) return null;
  if (Object.keys(value).some(key => key !== "revision" && key !== "unread")) return null;
  for (const [id, token] of Object.entries(value.unread)) {
    if (!isSessionReadId(id) || !isReadToken(token) || token === 0 || token > value.revision) return null;
  }
  return { revision: value.revision, unread: { ...value.unread } as Record<string, number> };
}
export function parseSessionReadRequest(value: unknown): SessionReadRequest | null {
  if (!object(value)) return null;
  if (value.action === "read") {
    if (Object.keys(value).some(key => key !== "action" && key !== "entries") || !Array.isArray(value.entries)) return null;
    const entries = new Map<string, { id: string; token: number }>();
    for (const entry of value.entries) {
      if (!object(entry) || Object.keys(entry).some(key => key !== "id" && key !== "token") || !isSessionReadId(entry.id) || !isReadToken(entry.token)) return null;
      if (entries.has(entry.id) && entries.get(entry.id)!.token !== entry.token) return null;
      entries.set(entry.id, { id: entry.id, token: entry.token });
      if (entries.size > MAX_SESSION_READ_IDS) return null;
    }
    return entries.size ? { action: "read", entries: [...entries.values()] } : null;
  }
  if (value.action !== "unread" && value.action !== "import") return null;
  if (Object.keys(value).some(key => key !== "action" && key !== "ids") || !Array.isArray(value.ids) || !value.ids.every(isSessionReadId)) return null;
  const ids = [...new Set(value.ids)];
  return ids.length && ids.length <= MAX_SESSION_READ_IDS ? { action: value.action, ids } : null;
}
