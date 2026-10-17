import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { createAgentEventStream } from "@/lib/agent-event-stream";
import { feynmanPaths, listFeynmanSessions, readFeynmanSession, resolveFeynmanSession } from "@/lib/feynman-store";
import { feynmanEventChannel, feynmanLiveSessions, feynmanRunningIds, getFeynmanSession, startFeynmanSession, validateFeynmanCommand } from "@/lib/feynman-rpc";
import { forgetSessionUiState, readSessionUiState, updateSessionUiState } from "@/lib/session-ui-state";
import { parseSessionUiStateRequest } from "@/lib/session-ui-state-shared";
import { searchSessionContents } from "@/lib/session-search";
import { FeynmanMutationError, mutateFeynmanSession } from "@/lib/feynman-mutations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });
const uiPath = () => join(feynmanPaths().agent, "pi-web-session-state.json");
type Context = { params: Promise<{ path: string[] }> };

async function sessions() {
  const stored = await listFeynmanSessions();
  const byId = new Map(stored.map((info) => [info.id, info]));
  for (const session of feynmanLiveSessions()) {
    if (byId.has(session.sessionId)) continue;
    byId.set(session.sessionId, {
      id: session.sessionId, path: session.sessionFile, cwd: session.cwd, projectKey: session.cwd, projectRoot: session.cwd,
      name: session.state?.sessionName, created: session.created, modified: session.created,
      firstMessage: "(no messages)", messageCount: 0, transient: true,
    });
  }
  for (const info of byId.values()) allowFileRoot(info.cwd);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

async function running(catalog = sessions()) {
  const entries = await catalog;
  const digest = createHash("sha256").update(JSON.stringify(entries.map(({ id, modified, name, messageCount, transient }) => [id, modified, name, messageCount, transient]))).digest("hex");
  return {
    sessionListVersion: Number.parseInt(digest.slice(0, 12), 16), runningSessionIds: feynmanRunningIds(),
    awaitingInputSessionIds: feynmanLiveSessions().filter((session) => session.awaitingInput).map((session) => session.sessionId), completionNotificationSuppressedSessionIds: [],
    sessionUiStateRevision: readSessionUiState(uiPath()).revision,
  };
}

async function dispatch(req: Request, { params }: Context): Promise<Response> {
  const path = (await params).path;
  const key = path.join("/");
  const url = new URL(req.url);
  const method = req.method;
  if (key === "sessions" && method === "GET") {
    const catalog = sessions();
    return json({ sessions: await catalog, ...await running(catalog) });
  }
  if (key === "agent/running" && method === "GET") return json(await running());
  if (key === "sessions/ui-state") {
    if (method === "GET") return json({ state: readSessionUiState(uiPath()) });
    if (method === "POST") {
      const parsed = parseSessionUiStateRequest(await req.json());
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      return json({ state: await updateSessionUiState(parsed.request, uiPath()) });
    }
  }
  if (key === "models" && method === "GET") return json({
    models: { "openai-codex:gpt-6.1-sol": "GPT-6.1 Sol" },
    modelList: [{ provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
    defaultModel: { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    defaultThinkingLevel: "medium", thinkingLevelPins: {}, scopeWarnings: [],
    thinkingLevels: { "openai-codex:gpt-6.1-sol": ["medium"] },
  });
  if (key === "default-cwd" && (method === "GET" || method === "POST")) {
    const recent = (await sessions()).find((session) => existsSync(session.cwd))?.cwd;
    const cwd = recent || join(feynmanPaths().root, "工作区");
    if (method === "POST") mkdirSync(cwd, { recursive: true });
    allowFileRoot(cwd);
    return json({ cwd });
  }
  if (key === "project-trust" && method === "GET") return json({ requiresTrust: false, trusted: true, decision: null });
  if (key === "sessions/search" && method === "GET") {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length > 200) return json({ error: "Search query exceeds 200 characters" }, 400);
    return json(await searchSessionContents(await sessions(), query, req.signal));
  }
  if (key === "agent/new" && method === "POST") {
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.cwd !== "string" || !body.cwd) return json({ error: "cwd is required", code: "prompt_rejected", accepted: false }, 400);
    if (body.toolNames !== undefined) return json({ error: "独立 Feynman 暂不支持网页工具预设；请选择配置默认，不能把未生效的限制当成只读模式", code: "prompt_rejected", accepted: false }, 400);
    if ((body.provider !== undefined || body.modelId !== undefined) && (body.provider !== "openai-codex" || body.modelId !== "gpt-6.1-sol")) return json({ error: "Feynman 模型固定为 openai-codex/gpt-6.1-sol", code: "prompt_rejected", accepted: false }, 400);
    if (body.thinkingLevel !== undefined && body.thinkingLevel !== "medium") return json({ error: "Feynman 思考级别固定为 medium", code: "prompt_rejected", accepted: false }, 400);
    const session = await startFeynmanSession(`__new__${randomUUID()}`, body.cwd);
    allowFileRoot(body.cwd);
    const command = Object.fromEntries(Object.entries(body).filter(([key]) => !["cwd", "toolNames", "provider", "modelId", "thinkingLevel"].includes(key)));
    const data = command.type === "ensure_session" ? null : await session.send(command);
    return json({ success: true, sessionId: session.sessionId, data, model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, thinkingLevel: "medium" });
  }
  if (path[0] === "agent" && path.length >= 2) {
    const id = path[1];
    if (path[2] === "events" && method === "GET") {
      if (!getFeynmanSession(id) && !await resolveFeynmanSession(id)) return json({ error: "Session not found" }, 404);
      return new Response(createAgentEventStream(req, id, Promise.resolve(feynmanEventChannel(id)), `feynman:${id}`), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
      });
    }
    if (path[2] === "lease" && method === "POST") return json({ success: true });
    if (path.length === 2 && method === "GET") {
      const session = getFeynmanSession(id);
      return json(session ? { running: true, state: await session.send({ type: "get_state" }) } : { running: false });
    }
    if (path.length === 2 && method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      validateFeynmanCommand(body);
      const session = await startFeynmanSession(id);
      return json({ success: true, data: await session.send(body) });
    }
  }
  if (key === "sessions/delete" && method === "POST") {
    const body = await req.json();
    if (!Array.isArray(body.ids) || body.ids.length > 1000 || body.ids.some((id: unknown) => typeof id !== "string")) return json({ error: "Invalid ids" }, 400);
    const deleted: string[] = [], missing: string[] = [], runningIds: string[] = [];
    for (const id of body.ids as string[]) {
      try { await mutateFeynmanSession(id, { type: "delete" }); deleted.push(id); }
      catch (error) {
        if (!(error instanceof FeynmanMutationError)) throw error;
        if (error.status === 404) missing.push(id); else runningIds.push(id);
      }
    }
    await forgetSessionUiState(deleted, uiPath());
    return json({ deleted, missing, running: runningIds }, deleted.length === 0 && runningIds.length > 0 ? 409 : 200);
  }
  if (path[0] === "sessions" && path[1]) {
    const id = path[1];
    if (path[2] === "state" && method === "GET") {
      const session = getFeynmanSession(id);
      return json(session ? { running: true, state: await session.send({ type: "get_state" }) } : { running: false });
    }
    if (method === "GET" && (path.length === 2 || path[2] === "context")) {
      const session = await readFeynmanSession(id, url.searchParams, getFeynmanSession(id));
      if (!session) return json({ error: "Session not found" }, 404);
      return json(path[2] === "context" ? { context: session.context, tail: Number(url.searchParams.get("tail")) || 50, before: url.searchParams.get("before") } : session);
    }
    if (path.length === 2 && method === "PATCH") {
      const body = await req.json();
      if (typeof body.name !== "string" || body.name.length > 200) return json({ error: "Invalid name" }, 400);
      await mutateFeynmanSession(id, { type: "rename", name: body.name });
      return json({ success: true });
    }
    if (path.length === 2 && method === "DELETE") {
      await mutateFeynmanSession(id, { type: "delete" });
      await forgetSessionUiState([id], uiPath());
      return json({ deleted: [id], missing: [], running: [] });
    }
  }
  // Never fall through to Pi's configuration or session mutation endpoints.
  return json({ error: "此功能尚不支持独立 Feynman；Pi 的设置与会话未被修改", code: "runtime_unsupported" }, 409);
}

async function handle(req: Request, context: Context) {
  try { return await dispatch(req, context); }
  catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof FeynmanMutationError ? error.status : 500); }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
