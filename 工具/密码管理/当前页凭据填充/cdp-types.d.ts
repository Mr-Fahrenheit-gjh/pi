// The CDP subset used here; no runtime code or browser discovery.
export interface Frame { id: string; parentId?: string; url: string; loaderId: string }
export interface Evaluation { exceptionDetails?: unknown; result: { objectId?: string; value?: unknown } }
export interface Results {
  'DOM.describeNode': {node:{backendNodeId:number}};
  'Browser.getVersion': { product: string; protocolVersion: string };
  'Target.getTargets': { targetInfos: { targetId: string; type: string; url: string }[] };
  'Target.attachToTarget': { sessionId: string };
  'Target.detachFromTarget': unknown;
  'Page.enable': unknown;
  'Runtime.enable': unknown;
  'Page.getFrameTree': { frameTree: { frame: Frame } };
  'Page.createIsolatedWorld': { executionContextId: number };
  'Runtime.evaluate': Evaluation;
  'Runtime.callFunctionOn': Evaluation;
}
export type CDPEvent = { sessionId?: string } & (
  | { method: 'Runtime.executionContextsCleared' }
  | { method: 'Runtime.executionContextDestroyed'; params: { executionContextId: number } }
  | { method: 'Page.frameNavigated'; params: { frame: Frame } }
  | { method: 'Page.frameDetached'; params: { frameId: string } }
);
export interface Permission { scope?: string; revision: string; expires: number | null }
export interface Credential { username: string; password: string }
export interface ResolveRequest { origin: string; username: string; revision: string }
export interface Selection { frameId: string; loaderId: string; usernameSelector?: string; usernameBackendNodeId?: number; passwordSelector: string; passwordBackendNodeId: number }
export interface FillRequest { endpoint: string; targetId: string; origin: string; username: string; credentialOrigin?: string; selection?: Selection }
export interface Dependencies { permission(): Promise<Permission>; resolve(req: ResolveRequest): Promise<Credential> }
export type Stage = 'permission' | 'target' | 'form' | 'resolve' | 'fill' | 'verify';
export type FillResult =
  | { status: 'FILLED_NOT_SUBMITTED'; loginVerified: false }
  | { status: 'REFUSED_OR_CHANGED'; stage: Stage; category: string; mayHaveFilled: boolean; loginVerified: false };
export interface SetterResult { ok: boolean; started: boolean }
export interface FixtureData { cdpUrl?: string; url?: string; snapshot?: string; [key: string]: unknown }
