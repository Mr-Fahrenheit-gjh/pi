export type ReleaseScope = "web" | "extension" | "memory" | "config";
export interface PendingReleaseEntry {
  schemaVersion: 1;
  id: string;
  revision: number;
  scope: ReleaseScope;
  title: string;
  summary: string;
  status: "pending" | "deployed";
  sourceSessions: string[];
  codeLocations: string[];
  verification: string[];
  releaseSteps: string[];
  rollback: string[];
  dependencies: string[];
  createdAt: string;
  deployedAt?: string;
}
export interface ReleaseSnapshot {
  entries: PendingReleaseEntry[];
  pendingCount: number;
  warnings: string[];
}
export const RELEASE_SCOPES: Readonly<Record<ReleaseScope, string>>;
export const RELEASE_ID: RegExp;
export const MAX_ENTRY_BYTES: number;
export function validateReleaseEntry(value: unknown): PendingReleaseEntry;
export function parseReleaseSnapshot(value: unknown): ReleaseSnapshot;
export function formatReleaseHandoff(value: PendingReleaseEntry): string;
