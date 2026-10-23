/** Live presentation only: never recover deck capability URLs from saved transcripts. */
export interface DesignDeckPresentation {
  id: string;
  sessionId: string;
  title: string;
  url: string;
}

export function designDeckUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== "/"
      || !url.searchParams.get("session") || url.hash) return null;
    url.hostname = "127.0.0.1";
    url.searchParams.set("embedded", "1");
    return url.href;
  } catch { return null; }
}

export function sameDesignDecks(a: DesignDeckPresentation[], b: DesignDeckPresentation[]): boolean {
  return a.length === b.length && a.every((deck, i) => {
    const next = b[i];
    return deck.id === next.id && deck.sessionId === next.sessionId
      && deck.url === next.url && deck.title === next.title;
  });
}
