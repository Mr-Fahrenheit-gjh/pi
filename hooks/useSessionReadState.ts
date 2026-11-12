"use client";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { SessionReadClient } from "@/lib/session-read-client";

export function useSessionReadState(selectedId: string | null, load: () => Set<string>, save: (ids: Set<string>) => void) {
  const [legacy, setLegacy] = useState(load);
  const legacyRef = useRef(legacy);
  legacyRef.current = legacy;
  const [revision, render] = useState(0);
  const [syncFailures, setSyncFailures] = useState(0);
  const [client] = useState(() => new SessionReadClient({
    fetch: (input, init) => fetch(input, init),
    legacyIds: () => [...legacyRef.current],
    migrated: () => save(new Set()),
    changed: () => render(value => value + 1),
    failed: () => setSyncFailures(value => value + 1),
  }));
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const setLegacyOnly = useCallback((change: SetStateAction<Set<string>>) => {
    if (client.mode === "legacy") setLegacy(change);
  }, [client]);
  const noteEligible = useCallback((ids: readonly string[]) => {
    const eligible = new Set(ids);
    // Prune only the old browser markers, even before protocol discovery. Never
    // remove an authoritative token because a catalogue response lacks its row.
    setLegacy(previous => {
      const next = new Set([...previous].filter(id => eligible.has(id)));
      return next.size === previous.size ? previous : next;
    });
    client.noteEligible(ids);
  }, [client]);
  useEffect(() => { if (client.mode === "legacy") save(legacy); }, [legacy, client, revision, save]);
  useEffect(() => {
    const check = () => {
      if (client.mode === "legacy") {
        if (selectedRef.current && document.visibilityState === "visible" && document.hasFocus()) {
          setLegacy(previous => {
            if (!previous.has(selectedRef.current!)) return previous;
            const next = new Set(previous); next.delete(selectedRef.current!); return next;
          });
        }
      } else client.autoRead(selectedRef.current, document.visibilityState === "visible", document.hasFocus());
    };
    const attention = () => { client.attentionChanged(); check(); };
    client.attentionChanged();
    check();
    window.addEventListener("focus", attention);
    document.addEventListener("visibilitychange", attention);
    return () => {
      window.removeEventListener("focus", attention);
      document.removeEventListener("visibilitychange", attention);
    };
  }, [client, selectedId]);
  useEffect(() => {
    if (client.mode === "legacy" && selectedId && document.visibilityState === "visible" && document.hasFocus()) {
      setLegacy(previous => {
        if (!previous.has(selectedId)) return previous;
        const next = new Set(previous); next.delete(selectedId); return next;
      });
    } else client.autoRead(selectedId, document.visibilityState === "visible", document.hasFocus());
  }, [client, selectedId, revision]);
  const mark = useCallback((ids: readonly string[], read: boolean) => {
    if (client.mode !== "legacy") { void client.mark(ids, read); return; }
    setLegacy(previous => {
      const next = new Set(previous);
      for (const id of ids) { if (read) next.delete(id); else next.add(id); }
      return next;
    });
  }, [client]);
  const noteRunning = useCallback((data: { sessionReadState?: unknown }) => client.noteRunning(data), [client]);
  const transportFailed = useCallback(() => client.transportFailed(), [client]);
  // Keep Set identity stable between equal snapshots/polls.
  const sharedIds = useRef<{ snapshot: typeof client.snapshot; ids: Set<string> }>({ snapshot: null, ids: new Set() });
  if (sharedIds.current.snapshot !== client.snapshot) sharedIds.current = { snapshot: client.snapshot, ids: new Set(Object.keys(client.snapshot?.unread ?? {})) };
  return { unreadSessionIds: client.snapshot ? sharedIds.current.ids : legacy, setLegacyOnly, mark, noteRunning, noteEligible, transportFailed, syncFailures };
}
