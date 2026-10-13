import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readPackageChat, transcriptSessionPath } from "@/lib/package-subagent-chat";
import { normalizeToolCalls } from "@/lib/normalize";
import { listOwnedPackageRuns, readOwnedPackageRun } from "@/lib/package-subagent-history";
import { asRecord } from "@/lib/subagent-fleet-view";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { packageRunIds, requestPackageSubagent, type PackageSubagentMethod } from "@/lib/package-subagent-bridge";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function ensureSession(id: string) {
  let session = getRpcSession(id);
  if (!session?.isAlive()) {
    const file = await resolveSessionPath(id);
    if (!file) throw new Error("Session not found");
    session = (await startRpcSession(id, file, undefined)).session;
  }
  await session.waitUntilReady();
  return session;
}
async function requireOwnedRun(sessionId: string, runId: unknown) {
  if (typeof runId !== "string" || !runId || runId.length > 128) throw new Error("Valid run id required");
  const parentFile = getRpcSession(sessionId)?.sessionFile;
  if (parentFile && readOwnedPackageRun(runId, parentFile)) return;
  const status = await requestPackageSubagent(sessionId, "status");
  if (!packageRunIds(status).has(runId)) throw new Error("Run does not belong to this session or is no longer retained");
}
function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ available: false, error: message }, { status: message === "Session not found" ? 404 : message.includes("belong") ? 403 : 400 });
}
export async function GET(req: Request, context: Context) {
  try {
    const { id } = await context.params;
    const session = await ensureSession(id);
    const query = new URL(req.url).searchParams;
    const runId = query.get("id");
    const params: Record<string, unknown> = {};
    if (runId) {
      await requireOwnedRun(id, runId);
      params.id = runId;
      if (["transcript", "chat"].includes(query.get("view") ?? "")) params.view = "transcript";
      params.lines = Math.min(300, Math.max(1, Number(query.get("lines")) || 100));
      if (query.has("index")) {
        const index = Number(query.get("index"));
        if (!Number.isInteger(index) || index < 0) throw new Error("Invalid child index");
        params.index = index;
      }
    }
    if (!runId && query.get("view") === "chat") params.view = "transcript";
    const data = await requestPackageSubagent(id, "status", params);
    if (query.get("view") === "chat") {
      const text = (data as { text?: string }).text ?? "";
      const file = transcriptSessionPath(text);
      // Never open a child AgentSession: its package runner is the sole writer.
      const chat = file ? readPackageChat(file, join(getAgentDir(), "sessions"), session.sessionFile) : { messages: [], truncated: false };
      return NextResponse.json({ available: true, ...chat, messages: chat.messages.map(normalizeToolCalls), text: chat.messages.length ? undefined : text });
    }
    if (!runId && session.sessionFile) {
      const snapshot = asRecord(asRecord(data)?.asyncSnapshot) ?? {};
      const current = Array.isArray(snapshot.runs) ? snapshot.runs : [];
      const currentIds = packageRunIds(data);
      const historical = listOwnedPackageRuns(session.sessionFile).filter((run) => !currentIds.has(String(run.id)));
      return NextResponse.json({ available: true, ...(data as object), asyncSnapshot: {
        ...snapshot, runs: [...current, ...historical], historySource: "persisted-owned-status",
      } });
    }
    return NextResponse.json({ available: true, ...(data as object) });
  } catch (error) { return responseError(error); }
}
export async function POST(req: Request, context: Context) {
  try {
    const { id } = await context.params;
    await ensureSession(id);
    const body = await req.json() as { method?: unknown; params?: Record<string, unknown> };
    if (!["steer", "stop", "resume", "interrupt", "cost"].includes(String(body.method))) throw new Error("Unsupported subagent method");
    const method = body.method as PackageSubagentMethod;
    const source = body.params ?? {};
    const params: Record<string, unknown> = {};
    if (method !== "cost") {
      await requireOwnedRun(id, source.id);
      params.id = source.id;
      if (method === "stop" && (source.index !== undefined || source.childId !== undefined)) throw new Error("Only whole-run stop is supported; child stop is not available");
      if (source.childId !== undefined) throw new Error("Unsupported childId");
      if (source.index !== undefined) {
        if (!Number.isInteger(source.index) || Number(source.index) < 0) throw new Error("Invalid child index");
        params.index = source.index;
      }
      if (method === "steer" || method === "resume") {
        if (typeof source.message !== "string" || !source.message.trim() || source.message.length > 16_384) throw new Error("A bounded message is required");
        params.message = source.message.trim();
        if (method === "steer" && ["steer", "follow_up", "auto"].includes(String(source.mode))) params.mode = source.mode;
      }
    }
    const data = await requestPackageSubagent(id, method, params);
    return NextResponse.json({ available: true, ...(data as object) });
  } catch (error) { return responseError(error); }
}
