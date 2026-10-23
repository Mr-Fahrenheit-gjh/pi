export const INLINE_VISUAL_STORAGE_KEY = "pi-inline-visuals";
export const INLINE_VISUAL_DEFAULT = true;
let memoryValue = INLINE_VISUAL_DEFAULT;
let hasMemoryOverride = false;
const listeners = new Set<() => void>();

export function getInlineVisualsEnabled(): boolean {
  if (typeof window === "undefined") return INLINE_VISUAL_DEFAULT;
  if (hasMemoryOverride) return memoryValue;
  try {
    const stored = window.localStorage.getItem(INLINE_VISUAL_STORAGE_KEY);
    memoryValue = stored !== "false";
  } catch { /* A blocked store still permits a page-local choice. */ }
  return memoryValue;
}
export function setInlineVisualsEnabled(enabled: boolean): void {
  memoryValue = enabled;
  try {
    window.localStorage.setItem(INLINE_VISUAL_STORAGE_KEY, String(enabled));
    hasMemoryOverride = false;
  } catch { hasMemoryOverride = true; }
  listeners.forEach(listener => listener());
}
function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === INLINE_VISUAL_STORAGE_KEY) {
    hasMemoryOverride = false;
    listeners.forEach(listener => listener());
  }
}
export function subscribeInlineVisuals(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
