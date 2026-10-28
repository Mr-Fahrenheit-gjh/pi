export type PiMetaBlockers = { sessions: number; terminals: number };
export type PiMetaControlState = { epoch: string; pending: boolean; error: string | null; closing?: boolean; drainId?: string };
export function handlePiMetaControl(state: PiMetaControlState, action: string, blockers: PiMetaBlockers, leaseId?: string): { ok: boolean; reason?: string; pending?: boolean; closing?: boolean; owned?: boolean; sessions?: number; terminals?: number };
