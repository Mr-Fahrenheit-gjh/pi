export interface InterruptSteerRequest {
  id: string;
  status: 'preparing' | 'accepted' | 'delivered' | 'handled' | 'failed' | 'cancelled';
  source: string;
  input: { textLength: number; imageCount: number };
  recoveryEntryId?: string;
  error?: string;
  journalError?: string;
  journalError?: string;
}
export interface InterruptSteerState {
  phase: string;
  busy: boolean;
  requests: InterruptSteerRequest[];
}
export function installInterruptSteer(target: object): void;
export function isInterruptSteerBusy(session: object): boolean;
export function hasQueuedInterruptSteer(session: object): boolean;
export function getInterruptSteerState(session: object): InterruptSteerState;
export function waitForInterruptSteer(session: object): Promise<void>;
export function setInterruptSteerGuard(session: object, guard: ((inputs: Array<{ prompt: string; images?: unknown[] }>) => void | Promise<void>) | undefined): void;
export function queueInternalSteer(session: object, text: string, images?: unknown[]): void;
