import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { feynmanPaths, feynmanSessionManager, listFeynmanSessions, readFeynmanSession } from "./feynman-store";
import { getFeynmanSession, startFeynmanSession } from "./feynman-rpc";
import { buildSessionContext, listAllSessions, openSessionManager, resolveSessionPath } from "./session-reader";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import type { AgentRuntime } from "./runtime-client.mjs";
import { registerRuntimeCleanup } from "./runtime-resources";
import type { SessionInfo } from "./types";

type PeerRuntime = Exclude<AgentRuntime, "meta">;
export interface PeerSource { runtime: PeerRuntime; sessionId: string }
export interface PeerRequest {
  action: "locate" | "list" | "read" | "artifacts" | "send" | "status";
  sessionId?: string; query?: string; before?: string; limit?: number;
  path?: string; message?: string; cwd?: string; mode?: "prompt" | "steer" | "follow_up";
  approvalId?: string;
}
const PEER_MARKER = "[跨运行时协作 | ";
const targetRuntime = (source: PeerSource): PeerRuntime => source.runtime === "pi" ? "feynman" : "pi";
const boundedLimit = (limit?: number) => Math.max(1, Math.min(100, Math.trunc(limit || 30)));
const catalog = (runtime: PeerRuntime) => runtime === "pi" ? listAllSessions() : listFeynmanSessions();

export function parsePeerRequest(value: unknown): PeerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a peer request");
  const input = value as Record<string, unknown>;
  if (!["locate", "list", "read", "artifacts", "send", "status"].includes(String(input.action))) throw new Error("Invalid peer action");
  for (const key of ["sessionId", "query", "before", "path", "message", "cwd", "approvalId"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || (input[key] as string).length > (key === "message" ? 32000 : 4000))) throw new Error(`Invalid ${key}`);
  }
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isFinite(input.limit))) throw new Error("Invalid limit");
  if (input.mode !== undefined && !["prompt", "steer", "follow_up"].includes(String(input.mode))) throw new Error("Invalid mode");
  return input as unknown as PeerRequest;
}

async function sessionContext(runtime: PeerRuntime, id: string, request: PeerRequest) {
  const params = new URLSearchParams({ tail: String(boundedLimit(request.limit)) });
  if (request.before) params.set("before", request.before);
  if (runtime === "feynman") {
    const session = await readFeynmanSession(id, params, getFeynmanSession(id));
    if (!session) throw new Error("Feynman session not found");
    return { runtime, sessionId: id, cwd: session.info.cwd, filePath: session.filePath, context: session.context };
  }
  const path = await resolveSessionPath(id);
  if (!path) throw new Error("Pi session not found");
  // Disk only: cross-runtime browsing must not recover/start an agent.
  const manager = openSessionManager(path);
  return { runtime, sessionId: id, cwd: manager.getCwd(), filePath: path,
    context: buildSessionContext(manager.getEntries() as never, request.before || manager.getLeafId(), { tail: boundedLimit(request.limit), excludeLeaf: Boolean(request.before) }) };
}

/** This bridge is not a filesystem sandbox. It deliberately excludes private runtime/config files. */
export function safeArtifactPath(cwd: string, requested: string): string {
  const root = realpathSync(cwd);
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  const parts = rel.split(/[\\/]/);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)
    || parts.some((part) => part.startsWith(".") || /^(node_modules|系统数据)$/i.test(part))
    || parts.some((part) => /(^|[-_.])(auth|credentials?|secrets?|tokens?|passwords?)([-_.]|$)/i.test(part))) throw new Error("Private or out-of-project artifact path");
  const actual = realpathSync(candidate);
  const actualRel = relative(root, actual);
  if (actualRel !== rel || lstatSync(candidate).isSymbolicLink()) throw new Error("Artifact symlinks are not shared");
  return actual;
}

function artifacts(info: SessionInfo, request: PeerRequest, publishedRoot?: string) {
  if (request.path) {
    let path: string;
    try { path = safeArtifactPath(info.cwd, request.path); }
    catch (error) { if (!publishedRoot) throw error; path = safeArtifactPath(publishedRoot, request.path); }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("请选择不超过 256 KiB 的成果文本文件");
    if (!/\.(md|txt|csv|tsv|json|tex|py|ts|js|html|css)$/i.test(path)) throw new Error("此接口只读取成果文本；二进制成果请按路径用文件工具打开");
    return { path, text: readFileSync(path, "utf8"), bytes: stat.size };
  }
  const results: Array<{ path: string; bytes: number; modified: string }> = [];
  const walk = (directory: string, depth: number, root: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (results.length >= 100 || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      try {
        safeArtifactPath(root, path);
        if (entry.isDirectory() && depth > 0) walk(path, depth - 1, root);
        else if (entry.isFile()) { const stat = lstatSync(path); results.push({ path, bytes: stat.size, modified: stat.mtime.toISOString() }); }
      } catch { /* excluded private files, links or directories removed during scan */ }
    }
  };
  for (const folder of ["outputs", "研究成果"]) {
    try { walk(safeArtifactPath(info.cwd, folder), 3, info.cwd); } catch { /* optional output directory */ }
  }
  if (publishedRoot) { try { walk(publishedRoot, 3, publishedRoot); } catch { /* optional archived deliverables */ } }
  return { cwd: info.cwd, publishedRoot, files: results, limit: 100, hint: "列表为成果目录，不代表内容已验收；可指定项目内成果文本路径读取。" };
}

async function sourceUserTurn(source: PeerSource): Promise<string> {
  const info = (await catalog(source.runtime)).find((session) => session.id === source.sessionId);
  if (!info) throw new Error("没有可核对的来源会话");
  const manager = source.runtime === "pi" ? openSessionManager(info.path)
    : (await feynmanSessionManager()).open(info.path, feynmanPaths().sessions);
  const last = [...manager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!last || last.type !== "message" || last.message.role !== "user") throw new Error("没有可核对的用户指令；不能向对方发送任务");
  const content = last.message.content;
  const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text.startsWith(PEER_MARKER)) throw new Error("对方发来的协作消息不授权继续转发；请完成任务，等待用户明确的新指令");
  return last.id;
}

type SendApproval = { source: PeerSource; turn: string; signature: string; title: string; message: string; expires: number; approved: boolean };
const APPROVALS = Symbol.for("pi-web:peer-send-approvals:v1");
function approvals(): Map<string, SendApproval> {
  const root = globalThis as unknown as Record<symbol, Map<string, SendApproval>>;
  return root[APPROVALS] ??= new Map();
}
function sendSignature(request: PeerRequest): string { return JSON.stringify([request.sessionId || "", request.cwd || "", request.mode || "", request.message || ""]); }
function sameSource(a: PeerSource, b: PeerSource): boolean { return a.runtime === b.runtime && a.sessionId === b.sessionId; }

/** A host-issued, one-use approval binds the exact message, target and user turn. */
export async function preparePeerSend(source: PeerSource, raw: unknown) {
  const request = parsePeerRequest(raw);
  if (request.action !== "send" || !request.message?.trim() || (!request.sessionId && !request.cwd)) throw new Error("发送必须明确目标对话或新工作目录及消息");
  for (const [id, value] of approvals()) if (value.expires < Date.now()) approvals().delete(id);
  if (approvals().size >= 1000) throw new Error("Too many pending collaboration approvals");
  const turn = await sourceUserTurn(source);
  const approvalId = randomUUID();
  const title = `向 ${targetRuntime(source) === "pi" ? "Pi" : "Feynman"} 发送协作任务？`;
  const message = `目标：${request.sessionId || request.cwd}\n方式：${request.mode || "空闲发送，运行中排队"}\n\n${request.message}\n\n[peer-send:${approvalId}]`;
  approvals().set(approvalId, { source, turn, signature: sendSignature(request), title, message, expires: Date.now() + 5 * 60_000, approved: false });
  return { approvalId, title, message };
}

export async function approvePeerSend(source: PeerSource, approvalId: string): Promise<void> {
  const approval = approvals().get(approvalId);
  if (!approval || !sameSource(approval.source, source) || approval.expires < Date.now() || approval.turn !== await sourceUserTurn(source)) throw new Error("协作发送确认已过期或来源已变化，请重新确认");
  approval.approved = true;
}

/** Called only for an authenticated browser's response to the exact RPC dialog. */
export async function approvePeerRpcDialog(source: PeerSource, dialog: Record<string, unknown>): Promise<void> {
  const match = typeof dialog.message === "string" ? /\[peer-send:([\w-]+)\]$/.exec(dialog.message) : null;
  if (!match) return;
  const approval = approvals().get(match[1]);
  if (!approval || approval.title !== dialog.title || approval.message !== dialog.message) throw new Error("协作确认内容与宿主授权不匹配");
  await approvePeerSend(source, match[1]);
}

async function consumePeerSend(source: PeerSource, request: PeerRequest): Promise<void> {
  const approval = request.approvalId ? approvals().get(request.approvalId) : undefined;
  if (!approval || !approval.approved || !sameSource(approval.source, source) || approval.signature !== sendSignature(request) || approval.expires < Date.now()) throw new Error("发送需要用户在来源对话中确认具体目标和消息；未派发任务");
  const turn = await sourceUserTurn(source);
  // Claim synchronously after the async turn check, so parallel requests cannot reuse it.
  if (approval.turn !== turn || approval.expires < Date.now() || approvals().get(request.approvalId!) !== approval) throw new Error("发送需要用户在来源对话中确认具体目标和消息；未派发任务");
  approvals().delete(request.approvalId!);
}

export async function requestPeer(source: PeerSource, raw: unknown): Promise<unknown> {
  const request = parsePeerRequest(raw);
  const runtime = targetRuntime(source);
  if (request.action === "locate") return { runtime, page: runtime === "pi" ? "/" : "/feynman", installation: runtime === "feynman" ? feynmanPaths().root : "Pi Web host runtime", ...(runtime === "feynman" ? { publishedResults: join(feynmanPaths().root, "研究成果/README.md") } : {}), collaboration: "按需查阅。仅在用户明确指令下发送；完成后查看目标会话和成果，不自动互聊。" };
  if (request.action === "list") {
    const query = request.query?.toLocaleLowerCase() || "";
    const all = (await catalog(runtime)).filter((info) => `${info.name || ""}\n${info.firstMessage}\n${info.cwd}`.toLocaleLowerCase().includes(query));
    const offset = Math.max(0, Number(request.before) || 0);
    return { runtime, sessions: all.slice(offset, offset + boundedLimit(request.limit)), next: offset + boundedLimit(request.limit) < all.length ? String(offset + boundedLimit(request.limit)) : null };
  }
  if (request.action === "send") {
    if (!request.message?.trim()) throw new Error("message is required");
    await consumePeerSend(source, request);
    const message = `${PEER_MARKER}${source.runtime} | ${source.sessionId}]\n以下是用户明确要求另一智能体转交的任务。完成后保存成果并在本对话回复；此消息本身不授权向其他会话再次派发。\n\n${request.message}`;
    if (runtime === "feynman") {
      const session = await startFeynmanSession(request.sessionId || `__new__${randomUUID()}`, request.cwd);
      const mode = request.mode || (session.isRunning() ? "follow_up" : "prompt");
      const receipt = await session.send({ type: mode, message });
      return { runtime, sessionId: session.sessionId, page: `/feynman?session=${encodeURIComponent(session.sessionId)}`, receipt, completed: false, next: "用 status/read/artifacts 核对进度和成果；接收成功不代表任务完成。" };
    }
    const path = request.sessionId ? await resolveSessionPath(request.sessionId) : "";
    if (request.sessionId && !path) throw new Error("Pi session not found");
    if (!request.sessionId && !request.cwd) throw new Error("新 Pi 任务必须明确 cwd");
    const { session, realSessionId } = await startRpcSession(request.sessionId || `__new__${randomUUID()}`, path || "", request.cwd);
    const mode = request.mode || (session.isRunning() ? "follow_up" : "prompt");
    const receipt = await session.send({ type: mode, message });
    return { runtime, sessionId: realSessionId, page: `/?session=${encodeURIComponent(realSessionId)}`, receipt, completed: false, next: "用 status/read/artifacts 核对进度和成果；接收成功不代表任务完成。" };
  }
  if (!request.sessionId) throw new Error("sessionId is required");
  if (request.action === "read") return sessionContext(runtime, request.sessionId, request);
  const info = (await catalog(runtime)).find((session) => session.id === request.sessionId);
  if (!info) throw new Error("Peer session not found");
  if (request.action === "artifacts") return { runtime, sessionId: info.id, ...artifacts(info, request, runtime === "feynman" ? join(feynmanPaths().root, "研究成果") : undefined) };
  const session = runtime === "pi" ? getRpcSession(info.id) : getFeynmanSession(info.id);
  return { runtime, sessionId: info.id, alive: Boolean(session?.isAlive()), running: session?.isRunning() ?? false, modified: info.modified, cwd: info.cwd, page: `${runtime === "pi" ? "/" : "/feynman"}?session=${encodeURIComponent(info.id)}` };
}

type Grant = { source: () => PeerSource };
type PeerBridge = { server?: Server; ready?: Promise<string>; grants: Map<string, Grant> };
const BRIDGE = Symbol.for("pi-web:runtime-peer-http:v1");
function bridge(): PeerBridge {
  const root = globalThis as unknown as Record<symbol, PeerBridge>;
  if (!root[BRIDGE]) { root[BRIDGE] = { grants: new Map() }; registerRuntimeCleanup(closePeerBridge); }
  return root[BRIDGE];
}

async function bridgeAddress(): Promise<string> {
  const state = bridge();
  return state.ready ??= new Promise<string>((resolveAddress, reject) => {
    const server = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const grant = token ? state.grants.get(token) : undefined;
      if (!grant || req.headers.origin || req.method !== "POST" || req.url !== "/peer") { res.writeHead(403); res.end(); return; }
      try {
        let body = "";
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error("Request too large"); }
        const input = JSON.parse(body);
        const data = input?.kind === "prepare_send"
          ? await preparePeerSend(grant.source(), input.request)
          : await requestPeer(grant.source(), input);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ data }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    state.server = server;
    server.once("error", (error) => { state.ready = undefined; reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Peer bridge has no loopback address")); return; }
      server.unref(); resolveAddress(`http://127.0.0.1:${address.port}/peer`);
    });
  });
}

/** Ephemeral, per-child bearer capability: never sent to the browser or written to disk. */
export async function grantFeynmanPeer(source: () => PeerSource) {
  const url = await bridgeAddress();
  const token = randomBytes(32).toString("hex");
  bridge().grants.set(token, { source });
  return { env: { PI_WEB_PEER_URL: url, PI_WEB_PEER_TOKEN: token }, revoke: () => { bridge().grants.delete(token); } };
}
export function closePeerBridge(): void { const state = bridge(); approvals().clear(); state.grants.clear(); state.server?.closeAllConnections(); state.server?.close(); state.ready = undefined; state.server = undefined; }
