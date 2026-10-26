"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import type { SessionInfo } from "@/lib/types";
import { createMenuNavigation, loadMenuSession, type MenuPageIdentity } from "@/lib/menu-navigation";

// A remounted AppShell still belongs to the same document. Never persist this
// identity in storage shared with another tab or a subsequently loaded page.
const identities = new WeakMap<Document, MenuPageIdentity>();

export function useMenuNavigation(
  sessions: readonly SessionInfo[],
  selectSession: (session: SessionInfo) => void,
  query: string,
  ready: boolean,
  navigationRef: { current: { invalidate: () => void; cancelForNavigation: () => void } | null },
) {
  const pathname = usePathname();
  const current = useRef({ sessions, selectSession });
  const bridgeRef = useRef<ReturnType<typeof createMenuNavigation> | null>(null);
  useLayoutEffect(() => { current.current = { sessions, selectSession }; });

  useEffect(() => {
    if (!ready || pathname !== "/" || window.location.pathname !== "/") return;
    // Native navigation targets loopback (a secure context). An insecure remote
    // page without randomUUID must keep working, but cannot advertise this bridge.
    if (typeof crypto.randomUUID !== "function") return;
    let identity = identities.get(document);
    if (!identity) {
      identity = { page: crypto.randomUUID(), handled: new Set() };
      identities.set(document, identity);
    }
    const bridge = createMenuNavigation({
      identity,
      readUrl: () => new URL(window.location.href),
      replaceUrl: (url) => window.history.replaceState(window.history.state, "", url),
      cachedSession: (id) => current.current.sessions.find((session) => session.id === id),
      loadSession: (id, signal) => loadMenuSession(id, signal, window.fetch.bind(window)),
      selectSession: (session) => current.current.selectSession(session),
    });
    bridgeRef.current = bridge;
    navigationRef.current = bridge;
    const onHashChange = () => { void bridge.handleHashChange(); };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    window.addEventListener("pagehide", bridge.invalidate);
    bridge.announce();
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
      window.removeEventListener("pagehide", bridge.invalidate);
      bridge.dispose();
      bridgeRef.current = null;
      navigationRef.current = null;
    };
  }, [pathname, ready, navigationRef]);

  useEffect(() => { bridgeRef.current?.queryChanged(); }, [query]);
}
