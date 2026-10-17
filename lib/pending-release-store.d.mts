import type { PendingReleaseEntry, ReleaseSnapshot } from "./pending-release-shared.mjs";
export const DEFAULT_RELEASE_DIRECTORY: string;
export class ReleaseConflictError extends Error {}
export function releaseDirectory(): string;
export function readReleaseSnapshot(): Promise<ReleaseSnapshot>;
export function registerRelease(value: unknown): Promise<PendingReleaseEntry>;
export function updateRelease(id: string, expectedRevision: number, replacement: unknown): Promise<PendingReleaseEntry>;
export function markReleaseDeployed(id: string, expectedRevision: number): Promise<PendingReleaseEntry>;
