import type { SessionInfo } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

type MenuFragment =
  | { kind: "ready"; page: string }
  | { kind: "request"; page: string; request: string; session: string }
  | { kind: "ack"; page: string; ack: string };

/** NavigationProtocol.md v1: exact field sets, no duplicates or partial requests. */
export function parseMenuFragment(hash: string): MenuFragment | null {
  if (!hash.startsWith("#")) return null;
  const fields = new URLSearchParams(hash.slice(1));
  const keys = [...fields.keys()];
  if (new Set(keys).size !== keys.length || fields.get("pi-menu") !== "1") return null;
  const page = fields.get("page");
  if (!page || !UUID.test(page)) return null;
  if (keys.length === 2) return { kind: "ready", page };
  const ack = fields.get("ack");
  if (keys.length === 3 && ack && UUID.test(ack)) return { kind: "ack", page, ack };
  const request = fields.get("request");
  const session = fields.get("session");
  if (keys.length === 4 && request && UUID.test(request) && session && SESSION_ID.test(session)) {
    return { kind: "request", page, request, session };
  }
  return null;
}

export function menuReadyHash(page: string): string {
  return `#${new URLSearchParams({ "pi-menu": "1", page })}`;
}

export function menuAcknowledgement(url: URL, page: string, request: string, session: string): URL {
  const next = new URL(url);
  next.searchParams.delete("session");
  next.searchParams.delete("cwd");
  next.searchParams.set("session", session);
  next.hash = new URLSearchParams({ "pi-menu": "1", page, ack: request }).toString();
  return next;
}

/** Metadata comes only from the current page's catalogue or its authenticated GET. */
export function menuSessionInfo(value: unknown, id: string): SessionInfo | null {
  if (!value || typeof value !== "object" || !SESSION_ID.test(id)) return null;
  const info = value as Record<string, unknown>;
  if (info.id !== id || typeof info.cwd !== "string" || !info.cwd
    || !["path", "created", "modified", "firstMessage"].every((key) => typeof info[key] === "string")
    || typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0
    || !["name", "projectRoot", "projectKey", "branch", "parentSessionId"].every((key) => info[key] === undefined || typeof info[key] === "string")
    || !["detailsPending", "isWorktree", "transient"].every((key) => info[key] === undefined || typeof info[key] === "boolean")) return null;
  if (info.relation !== undefined) {
    if (!info.relation || typeof info.relation !== "object") return null;
    const relation = info.relation as Record<string, unknown>;
    if (relation.kind === "fork") {
      if (relation.originSessionId !== undefined && typeof relation.originSessionId !== "string") return null;
    } else if (relation.kind === "subagent") {
      if (!["parentSessionId", "profile", "description"].every((key) => typeof relation[key] === "string")
        || !["starting", "queued", "running", "completed", "failed", "aborted", "interrupted"].includes(String(relation.status))) return null;
    } else return null;
  }
  return value as SessionInfo;
}

export async function loadMenuSession(id: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  // The existing summary endpoint reads metadata, not transcript contents.
  // Use normal same-origin auth; never extract credentials or follow redirects.
  const response = await fetcher("/api/sessions?summary=1", {
    signal, cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error",
  });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("sessions" in data) || !Array.isArray(data.sessions)) return null;
  return data.sessions.find((session: unknown) => session && typeof session === "object" && "id" in session && session.id === id);
}

export interface MenuPageIdentity {
  page: string;
  handled: Set<string>;
}

interface MenuNavigationOptions {
  identity: MenuPageIdentity;
  readUrl: () => URL;
  replaceUrl: (url: URL) => void;
  cachedSession: (id: string) => unknown;
  loadSession: (id: string, signal: AbortSignal) => Promise<unknown>;
  selectSession: (session: SessionInfo) => void;
}

/** The only asynchronous boundary is metadata resolution; selection and ack are synchronous. */
export function createMenuNavigation(options: MenuNavigationOptions) {
  const { identity, readUrl, replaceUrl } = options;
  let generation = 0;
  let disposed = false;
  let pending: AbortController | null = null;
  let pendingUrl: string | null = null;
  let acknowledgedUrl: string | null = null;

  const invalidate = () => {
    generation += 1;
    pending?.abort();
    pending = null;
    pendingUrl = null;
  };
  const announce = () => {
    const url = readUrl();
    if (disposed || url.pathname !== "/") return;
    const fragment = parseMenuFragment(url.hash);
    if (url.hash && (!fragment || fragment.kind === "request")) return;
    url.hash = menuReadyHash(identity.page);
    if (url.href !== readUrl().href) replaceUrl(url);
  };
  const handleHashChange = async () => {
    const url = readUrl();
    // Several hash events can already be queued when the newest URL is read.
    // Do not cancel that same in-flight request or erase its synchronous ack.
    if (url.href === pendingUrl) return;
    invalidate();
    if (url.href === acknowledgedUrl) return;
    if (disposed || url.pathname !== "/") return;
    const fragment = parseMenuFragment(url.hash);
    if (!fragment || fragment.kind !== "request") {
      announce();
      return;
    }
    const requestKey = fragment.request.toLowerCase();
    if (fragment.page !== identity.page || identity.handled.has(requestKey)) return;
    identity.handled.add(requestKey);
    const token = generation;
    const controller = new AbortController();
    pending = controller;
    pendingUrl = url.href;
    try {
      const session = menuSessionInfo(options.cachedSession(fragment.session), fragment.session)
        ?? menuSessionInfo(await options.loadSession(fragment.session, controller.signal), fragment.session);
      if (!session || disposed || token !== generation || readUrl().href !== url.href) return;
      options.selectSession(session);
      const ack = menuAcknowledgement(url, identity.page, fragment.request, session.id);
      acknowledgedUrl = ack.href;
      replaceUrl(ack);
    } catch {
      // Missing, forbidden, malformed and failed reads never select or acknowledge.
    } finally {
      if (pending === controller) { pending = null; pendingUrl = null; }
    }
  };
  return {
    handleHashChange,
    invalidate,
    cancelForNavigation() {
      invalidate();
      const url = readUrl();
      const fragment = parseMenuFragment(url.hash);
      // Explicit user navigation wins over every request already present now,
      // including one whose hashchange is still queued. Later requests survive.
      // Generic invalidation (including successful bridge selection) never does.
      if (disposed || url.pathname !== "/"
        || fragment?.kind !== "request" || fragment.page !== identity.page) return;
      identity.handled.add(fragment.request.toLowerCase());
      url.hash = menuReadyHash(identity.page);
      replaceUrl(url);
    },
    // Next's search-param update from our own replaceState must leave the ack
    // observable. Ordinary in-page router navigation declares readiness again.
    queryChanged() {
      const url = readUrl();
      if (acknowledgedUrl) {
        const ack = new URL(acknowledgedUrl);
        if (url.pathname === ack.pathname && url.search === ack.search
          && (url.hash === ack.hash || parseMenuFragment(url.hash)?.kind === "request")) return;
      }
      invalidate();
      announce();
    },
    announce,
    dispose() { disposed = true; invalidate(); },
  };
}
