const KEY = Symbol.for("pi-web:extra-runtime-cleanup:v1");
function cleanups(): Set<() => void> {
  const root = globalThis as unknown as Record<symbol, Set<() => void>>;
  return root[KEY] ??= new Set();
}
export function registerRuntimeCleanup(cleanup: () => void): void { cleanups().add(cleanup); }
export function closeExtraRuntimeResources(): void {
  for (const cleanup of cleanups()) { try { cleanup(); } catch { /* continue closing other runtimes */ } }
  cleanups().clear();
}
