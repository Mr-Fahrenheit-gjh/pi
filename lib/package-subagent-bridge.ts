import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";

const REQUEST = "subagents:rpc:v1:request";
const REPLY = "subagents:rpc:v1:reply:";
const REGISTRY = Symbol.for("pi-web:package-subagent-bridge/v1");
export type PackageSubagentMethod = "ping" | "status" | "steer" | "stop" | "resume" | "interrupt" | "cost";
type Bridge = { request: (method: PackageSubagentMethod, params: Record<string, unknown>) => Promise<unknown> };
function registry(): Map<string, Bridge> {
  const root = globalThis as unknown as Record<symbol, unknown>;
  return (root[REGISTRY] ??= new Map<string, Bridge>()) as Map<string, Bridge>;
}

export function requestOnBus(
  events: ExtensionAPI["events"], method: PackageSubagentMethod,
  params: Record<string, unknown>, timeoutMs = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error("子代理请求超时；请刷新状态确认结果，不要重复提交操作")), timeoutMs);
    const unsubscribe = events.on(REPLY + requestId, (value: unknown) => {
      const reply = value as { version?: number; requestId?: string; success?: boolean; data?: unknown; error?: { message?: string } };
      if (reply?.version !== 1 || reply.requestId !== requestId) return;
      finish(reply.success === true ? undefined : new Error(reply.error?.message ?? "子代理请求失败"), reply.data);
    });
    try { events.emit(REQUEST, { version: 1, requestId, method, params }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

/** One package runtime per parent. The event bus belongs to that session, never the browser. */
export function createPackageSubagentExtension(): InlineExtension {
  return {
    name: "pi-web-package-subagents", hidden: true,
    factory: async (api) => {
      // The user's quiet adapter owns package registration. This is only a UI bridge.
      let sessionId: string | undefined;
      const bridge: Bridge = { request: (method, params) => requestOnBus(api.events, method, params) };
      api.on("session_start", (_event, ctx) => {
        if (sessionId && registry().get(sessionId) === bridge) registry().delete(sessionId);
        sessionId = ctx.sessionManager.getSessionId();
        registry().set(sessionId, bridge);
      });
      api.on("session_shutdown", () => {
        if (sessionId && registry().get(sessionId) === bridge) registry().delete(sessionId);
      });
    },
  };
}

export function requestPackageSubagent(sessionId: string, method: PackageSubagentMethod, params: Record<string, unknown> = {}): Promise<unknown> {
  const bridge = registry().get(sessionId);
  if (!bridge) throw new Error("当前会话未加载 pi-subagents；聊天专用会话不启用子代理");
  return bridge.request(method, params);
}

export function packageRunIds(status: unknown): Set<string> {
  const value = status as { asyncSnapshot?: { runs?: Array<{ id?: unknown }> } };
  return new Set((value?.asyncSnapshot?.runs ?? []).flatMap((run) => typeof run.id === "string" ? [run.id] : []));
}
