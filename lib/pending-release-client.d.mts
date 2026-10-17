import type { ReleaseSnapshot } from "./pending-release-shared.mjs";
export interface ReleaseLoadState {
  snapshot: ReleaseSnapshot | null;
  loading: boolean;
  error: string | null;
}
export interface ReleaseLoader { refresh(): Promise<void>; dispose(): void }
export function createReleaseLoader(onChange: (state: ReleaseLoadState) => void, request?: typeof fetch, timeoutMs?: number): ReleaseLoader;
