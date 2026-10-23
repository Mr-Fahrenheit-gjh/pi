import type { SessionInfo } from "./types";
import type { SessionSearchResult } from "./session-search";

export const QUICK_ACTION_PAGE_SIZE = 9;

export function quickActionPage(count: number, selected: number) {
  const index = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const page = Math.floor(index / QUICK_ACTION_PAGE_SIZE);
  return { start: page * QUICK_ACTION_PAGE_SIZE, end: Math.min((page + 1) * QUICK_ACTION_PAGE_SIZE, count),
    number: page + 1, total: Math.max(1, Math.ceil(count / QUICK_ACTION_PAGE_SIZE)) };
}

/** Plain digits open an empty-query result; Alt+digits keep searches editable. */
export function quickActionShortcut(event: { key: string; code?: string; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; repeat?: boolean; defaultPrevented?: boolean }, query: string): number | null {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  const digit = event.altKey ? /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")?.[1]
    : query === "" && /^[1-9]$/.test(event.key) ? event.key : undefined;
  return digit ? Number(digit) - 1 : null;
}

export function quickActionMatches(action: { label: string; keywords?: readonly string[] }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [action.label, ...(action.keywords ?? [])].some(value => value.toLocaleLowerCase().includes(needle));
}

/** Prefer actual message hits; title matches remain usable while content search is pending. */
export function quickSessionMatches(
  catalog: readonly SessionInfo[], query: string, contentMatches: readonly SessionSearchResult[], currentSessionId?: string | null,
): SessionSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  const recent = catalog.filter(session => !session.transient).sort((a, b) => b.modified.localeCompare(a.modified));
  const fallback = recent.filter(session => needle
    ? `${session.name ?? ""} ${session.firstMessage}`.toLocaleLowerCase().includes(needle)
    : session.id !== currentSessionId).map(session => ({ session, blockIndex: 0, before: "", match: "", after: "" }));
  const seen = new Set<string>();
  return (needle ? [...contentMatches, ...fallback] : fallback).filter(result => {
    if (result.session.transient || seen.has(result.session.id)) return false;
    seen.add(result.session.id);
    return true;
  }).slice(0, 8);
}
