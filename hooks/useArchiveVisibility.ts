import { useSyncExternalStore } from "react";

export const ARCHIVE_VISIBILITY_KEY = "pi-web:sidebar-show-archived";
export function parseArchiveVisibility(value: string | null): boolean { return value === "true"; }
let value = false;
const listeners = new Set<() => void>();
function read() { try { return parseArchiveVisibility(window.localStorage.getItem(ARCHIVE_VISIBILITY_KEY)); } catch { return value; } }
function notify() { listeners.forEach(listener => listener()); }
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== ARCHIVE_VISIBILITY_KEY) return;
  const next = read();
  if (next !== value) { value = next; notify(); }
}
function subscribe(listener: () => void) {
  if (!listeners.size) { value = read(); window.addEventListener("storage", onStorage); }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("storage", onStorage); };
}
export function setArchiveVisibility(next: boolean) {
  value = next;
  try { window.localStorage.setItem(ARCHIVE_VISIBILITY_KEY, String(next)); } catch { /* In-memory preference remains usable. */ }
  notify();
}
export function useArchiveVisibility() { return useSyncExternalStore(subscribe, () => value, () => false); }
