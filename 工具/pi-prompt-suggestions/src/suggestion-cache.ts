interface CachedSuggestion {
  owner: string;
  text?: string;
  at: number;
}

const MAX_ENTRIES = 64;
const TTL_MS = 30 * 60_000;
const host = globalThis as typeof globalThis & { __piPromptSuggestionResultsV1?: Map<string, CachedSuggestion> };
const cache = () => host.__piPromptSuggestionResultsV1 ??= new Map();

/** Process-memory only: retain completed results across idle runtime disposal/reload. */
export function getCachedSuggestion(key: string, now = Date.now()): CachedSuggestion | undefined {
  const value = cache().get(key);
  if (!value) return undefined;
  if (now - value.at > TTL_MS || now < value.at) {
    cache().delete(key);
    return undefined;
  }
  cache().delete(key);
  cache().set(key, value);
  return value;
}

export function cacheSuggestion(key: string, owner: string, text?: string, now = Date.now()): void {
  for (const [id, value] of cache()) if (now - value.at > TTL_MS) cache().delete(id);
  cache().delete(key);
  cache().set(key, { owner, text, at: now });
  while (cache().size > MAX_ENTRIES) cache().delete(cache().keys().next().value!);
}

export function invalidateSessionSuggestions(owner: string): void {
  for (const [key, value] of cache()) if (value.owner === owner) cache().delete(key);
}
