// Shared across route bundles/HMR; also counted by the existing restart/deployment drain.
declare global { var __piVoiceWork: Map<string, number> | undefined; }
function work() { return globalThis.__piVoiceWork ??= new Map(); }
export function holdVoiceWork(id: string, milliseconds?: number): () => void {
  // Initialization can ignore abort. Keep its blocker until the actual promise settles.
  work().set(id, milliseconds === undefined ? Infinity : Date.now() + milliseconds);
  return () => { work().delete(id); };
}
export function activeVoiceWork(): number {
  for (const [id, expires] of work()) if (expires <= Date.now()) work().delete(id);
  return work().size;
}
