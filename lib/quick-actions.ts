import type { SessionInfo } from "./types";
import type { SessionSearchResult } from "./session-search";

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
