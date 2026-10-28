export interface PiMetaProcessOptions { mainAgentDir: string; packageDir: string }
export interface PiMetaWorker { pid: number; socketPath: string; agentDir: string; packageDir: string }
export interface PiMetaControlResult { ok: boolean; available: boolean; pending?: boolean; owned?: boolean; sessions?: number; terminals?: number; reason?: string }
export function piMetaStartingOrUnresolved(): boolean;
export function ensurePiMeta(options: PiMetaProcessOptions & { canStart: () => boolean }): Promise<PiMetaWorker>;
export function piMetaControl(options: PiMetaProcessOptions, action: "identity" | "status" | "drain" | "resume", leaseId?: string): Promise<PiMetaControlResult>;
export function shutdownPiMeta(options: PiMetaProcessOptions, leaseId: string): Promise<void>;
export function piMetaRestartBlockingIds(options: PiMetaProcessOptions): Promise<string[]>;
