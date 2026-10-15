import { useSyncExternalStore } from "react";

export type RunningSendMode = "steer" | "followup";
export const RUNNING_SEND_MODE_STORAGE_KEY = "pi-running-send-mode";
export const RUNNING_SEND_MODE_DEFAULT: RunningSendMode = "steer";

export function normalizeRunningSendMode(value: unknown): RunningSendMode {
  return value === "followup" ? "followup" : "steer";
}

let mode: RunningSendMode | null = null;
const listeners = new Set<() => void>();
function getSnapshot(): RunningSendMode {
  if (mode === null) {
    try { mode = normalizeRunningSendMode(window.localStorage.getItem(RUNNING_SEND_MODE_STORAGE_KEY)); }
    catch { mode = RUNNING_SEND_MODE_DEFAULT; }
  }
  return mode;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setRunningSendMode(value: RunningSendMode): void {
  mode = normalizeRunningSendMode(value);
  try { window.localStorage.setItem(RUNNING_SEND_MODE_STORAGE_KEY, mode); } catch {}
  listeners.forEach(listener => listener());
}
export function useRunningSendMode(): RunningSendMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => RUNNING_SEND_MODE_DEFAULT);
}
