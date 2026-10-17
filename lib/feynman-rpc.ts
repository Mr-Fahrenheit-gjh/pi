import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { AgentEventLike } from "./agent-event-wire";
import { feynmanPaths, resolveFeynmanSession } from "./feynman-store";
import { registerRuntimeCleanup } from "./runtime-resources";
import { activeFeynmanOperationIds, assertNoExternalFeynmanWriter, lockFeynmanSession, withFeynmanOperation } from "./feynman-ownership";

export interface FeynmanState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: { id: string; provider: string };
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  isPromptRunning?: boolean;
  pendingMessageCount?: number;
}

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const READ_COMMANDS = new Set(["get_state", "get_available_models", "get_available_thinking_levels", "get_session_stats", "get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text", "get_messages", "get_commands"]);
const WRITE_COMMANDS = new Set(["prompt", "steer", "follow_up", "abort", "clear_queue", "compact", "set_auto_compaction", "set_auto_retry", "abort_retry", "bash", "abort_bash", "set_session_name", "set_steering_mode", "set_follow_up_mode", "extension_ui_response"]);

export function validateFeynmanCommand(command: Record<string, unknown>): void {
  if (command.type === "set_model" && command.provider === "openai-codex" && command.modelId === "gpt-6.1-sol") return;
  if (command.type === "set_thinking_level" && command.level === "medium") return;
  if (typeof command.type !== "string" || (!READ_COMMANDS.has(command.type) && !WRITE_COMMANDS.has(command.type))) {
    throw new Error("此操作不适用于独立 Feynman；模型固定为 gpt-6.1-sol / medium / default");
  }
}

/** One JSONL process per Feynman conversation; browser disconnect never aborts it. */
export class FeynmanRpcSession {
  readonly listeners = new Set<(event: AgentEventLike) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly pendingUi = new Map<string, Record<string, unknown>>();
  private output = "";
  private stderr = "";
  private exited = false;
  private ready = false;
  private currentState?: FeynmanState;
  private streaming = false;
  private promptActive = false;
  private interruptActive = false;
  private activeWrites = 0;
  private keepWriterLease = false;
  private releaseLease?: () => Promise<void>;
  private leaseReleasePending?: Promise<void>;
  private compacting = false;
  private message: unknown = null;
  readonly cwd: string;
  readonly created = new Date().toISOString();

  constructor(private readonly child: ChildProcessWithoutNullStreams, cwd: string) {
    this.cwd = cwd;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-3000); });
    child.on("error", (error) => this.finish(error));
    child.on("close", (code) => {
      this.finish(new Error(`Feynman 进程已退出 (${code ?? "signal"})${this.ready ? "" : `: ${this.stderr || "启动失败"}`}`));
      if (!this.keepWriterLease) void this.releaseWriterLease().catch(() => {});
    });
  }

  get processGroup(): number | undefined { return this.child.pid; }
  get sessionId(): string { return this.currentState?.sessionId ?? ""; }
  get sessionFile(): string { return this.currentState?.sessionFile ?? ""; }
  get state(): FeynmanState | undefined { return this.currentState; }
  get isStreaming(): boolean { return this.streaming || this.promptActive || this.interruptActive; }
  get streamingMessage(): unknown { return this.message; }
  isAlive(): boolean { return !this.exited; }
  isRunning(): boolean { return this.isStreaming || this.compacting || this.activeWrites > 0 || this.awaitingInput; }
  get pendingUiRequests(): Record<string, unknown>[] { return [...this.pendingUi.values()]; }
  get awaitingInput(): boolean { return this.pendingUi.size > 0; }
  onEvent(listener: (event: AgentEventLike) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private emit(event: AgentEventLike): void { for (const listener of this.listeners) listener(event); }

  private receive(chunk: string): void {
    this.output += chunk;
    if (Buffer.byteLength(this.output) > 32 * 1024 * 1024) { this.finish(new Error("Feynman RPC frame exceeds limit")); this.stop(); return; }
    let newline: number;
    while ((newline = this.output.indexOf("\n")) >= 0) {
      const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1);
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { continue; } // Bootstrap notices are not RPC events.
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      if (event.type === "response") {
        const id = typeof event.id === "string" ? event.id : "";
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id); clearTimeout(pending.timer);
        if (event.success !== true) pending.reject(new Error(typeof event.error === "string" ? event.error : "Feynman RPC failed"));
        else {
          pending.resolve(event.data);
          if (["prompt", "steer"].includes(String(event.command)) && (event.data as { disposition?: string } | undefined)?.disposition === "handled" && !this.isStreaming) this.emit({ type: "prompt_done" });
        }
        continue;
      }
      if (typeof event.type !== "string") continue;
      if (event.type === "extension_ui_request" && typeof event.id === "string" && ["confirm", "select", "input", "editor", "custom"].includes(String(event.method))) {
        if (event.method === "custom" && event.closed === true) this.pendingUi.delete(event.id);
        else this.pendingUi.set(event.id, event);
      }
      if (event.type === "interrupt_steer_start") this.interruptActive = true;
      if (event.type === "agent_start") { this.streaming = true; this.promptActive = true; }
      if (event.type === "auto_retry_start") this.promptActive = true;
      // The SDK emits its physical settled event before releasing the interrupt
      // transaction. Do not expose a false idle/completion between those events.
      if (event.type === "agent_settled" && this.interruptActive) continue;
      if (event.type === "interrupt_steer_end") this.interruptActive = false;
      if (event.type === "agent_settled" || event.type === "interrupt_steer_end") { this.promptActive = false; this.streaming = false; this.closePendingUi(); }
      if (event.type === "agent_end") { this.streaming = false; this.message = null; }
      if (event.type === "auto_compaction_start") this.compacting = true;
      if (event.type === "auto_compaction_end") this.compacting = false;
      if (event.type === "message_update") this.message = event.message;
      if (event.type === "message_end") this.message = null;
      this.emit(event as AgentEventLike);
      if (event.type === "agent_settled" || event.type === "interrupt_steer_end") this.emit({ type: "prompt_done", ...(event.aborted === true ? { aborted: true } : {}) });
    }
  }

  private closePendingUi(): void {
    for (const id of this.pendingUi.keys()) this.emit({ type: "extension_ui_closed", id });
    this.pendingUi.clear();
  }

  private finish(error: Error): void {
    if (this.exited) return;
    this.exited = true; this.streaming = false; this.promptActive = false; this.interruptActive = false; this.compacting = false; this.message = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.closePendingUi();
    this.emit({ type: "prompt_error", errorMessage: error.message });
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled", aborted: true });
    this.emit({ type: "prompt_done", aborted: true });
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = String(command.type);
    const concurrent = READ_COMMANDS.has(type) || ["abort", "abort_bash", "abort_retry", "clear_queue", "extension_ui_response"].includes(type);
    if (!this.sessionId || concurrent) return this.sendWithinOperation(command);
    return withFeynmanOperation(this.sessionId, async () => {
      this.activeWrites += 1;
      try { return await this.sendWithinOperation(command); } finally { this.activeWrites -= 1; }
    });
  }

  private async sendWithinOperation(command: Record<string, unknown>): Promise<unknown> {
    validateFeynmanCommand(command);
    if (this.exited) throw new Error("Feynman 进程已退出，请重新打开此对话");
    if (command.type === "extension_ui_response") {
      // Its id belongs to the UI request; no response envelope follows it.
      const dialog = this.pendingUi.get(String(command.id));
      if (dialog && command.confirmed === true) {
        try {
          const { approvePeerRpcDialog } = await import("./runtime-peer");
          await approvePeerRpcDialog({ runtime: "feynman", sessionId: this.sessionId }, dialog);
        } catch (error) {
          this.pendingUi.delete(String(command.id));
          this.emit({ type: "extension_ui_closed", id: command.id });
          this.child.stdin.write(JSON.stringify({ ...command, confirmed: false, cancelled: true }) + "\n");
          throw error;
        }
      }
      this.pendingUi.delete(String(command.id));
      this.emit({ type: "extension_ui_closed", id: command.id });
      this.child.stdin.write(JSON.stringify(command) + "\n"); return null;
    }
    const id = randomUUID();
    const data = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Feynman 未在时限内确认；请先查看状态，不要重复发送任务"));
      }, command.type === "compact" ? 180_000 : 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
    if (command.type === "get_state") {
      this.currentState = data as FeynmanState;
      if (!this.currentState?.sessionId) throw new Error("Feynman returned no session identity");
      this.streaming = Boolean(this.currentState.isStreaming);
      this.compacting = Boolean(this.currentState.isCompacting);
      if (this.streaming) this.promptActive = true;
      this.ready = true;
      return { ...this.currentState, isPromptRunning: this.promptActive || this.interruptActive };
    }
    return data;
  }

  holdWriterLease(release: () => Promise<void>): void { this.releaseLease = release; }
  private async releaseWriterLease(): Promise<void> {
    if (this.leaseReleasePending) return this.leaseReleasePending;
    const release = this.releaseLease;
    this.releaseLease = undefined;
    if (release) { this.leaseReleasePending = release(); await this.leaseReleasePending; }
  }

  async stopAndMutate<T>(task: () => Promise<T>): Promise<T> {
    this.keepWriterLease = true;
    try { await this.shutdown(); return await task(); }
    finally { this.keepWriterLease = false; await this.releaseWriterLease(); }
  }

  async shutdown(): Promise<void> {
    if (!this.exited) await new Promise<void>((resolve) => { this.child.once("close", () => resolve()); this.stop(); });
    if (!this.keepWriterLease) await this.releaseWriterLease();
  }

  stop(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    // Feynman supervises another Pi child; terminate the process group too.
    try { if (this.child.pid) process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill("SIGTERM"); }
    const timer = setTimeout(() => {
      try { if (this.child.pid) process.kill(-this.child.pid, "SIGKILL"); } catch { /* exited */ }
    }, 3000);
    timer.unref();
  }
}

const REGISTRY = Symbol.for("pi-web:feynman-rpc:v1");
type Registry = { sessions: Map<string, FeynmanRpcSession>; starting: Map<string, Promise<FeynmanRpcSession>>; channels: Map<string, Set<(event: AgentEventLike) => void>> };
function registry(): Registry {
  const root = globalThis as unknown as Record<symbol, Registry>;
  if (!root[REGISTRY]) {
    root[REGISTRY] = { sessions: new Map(), starting: new Map(), channels: new Map() };
    registerRuntimeCleanup(stopFeynmanSessions);
  }
  return root[REGISTRY];
}
export function getFeynmanSession(id: string): FeynmanRpcSession | undefined {
  const session = registry().sessions.get(id);
  return session?.isAlive() ? session : undefined;
}
/** History SSE is a passive channel: opening a transcript never boots a kernel. */
export function feynmanEventChannel(id: string) {
  return {
    get isStreaming() { return getFeynmanSession(id)?.isStreaming ?? false; },
    get streamingMessage() { return getFeynmanSession(id)?.streamingMessage ?? null; },
    isAlive: () => true,
    onEvent(listener: (event: AgentEventLike) => void) {
      let listeners = registry().channels.get(id);
      if (!listeners) { listeners = new Set(); registry().channels.set(id, listeners); }
      listeners.add(listener);
      for (const dialog of getFeynmanSession(id)?.pendingUiRequests ?? []) listener(dialog as AgentEventLike);
      return () => { listeners.delete(listener); if (!listeners.size) registry().channels.delete(id); };
    },
  };
}
export function feynmanRunningIds(): string[] { return [...registry().sessions].filter(([, session]) => session.isAlive() && session.isRunning()).map(([id]) => id); }
export function feynmanRestartBlockingIds(): string[] { return [...new Set([...feynmanRunningIds(), ...registry().starting.keys(), ...activeFeynmanOperationIds()])].map((id) => `feynman:${id}`); }
export function feynmanLiveSessions(): FeynmanRpcSession[] { return [...registry().sessions.values()].filter((session) => session.isAlive()); }
export function stopFeynmanSessions(): void { for (const session of registry().sessions.values()) session.stop(); }

export function startFeynmanSession(id: string, cwd?: string): Promise<FeynmanRpcSession> {
  // Reusing a live transport must still permit abort/status while draining.
  // Mutating commands retain their own withFeynmanOperation gate in send().
  const existing = getFeynmanSession(id);
  if (existing) return Promise.resolve(existing);
  return withFeynmanOperation(id, () => startFeynmanWithinOperation(id, cwd));
}
async function startFeynmanWithinOperation(id: string, cwd?: string): Promise<FeynmanRpcSession> {
  const existing = getFeynmanSession(id);
  if (existing) return existing;
  const starting = registry().starting.get(id);
  if (starting) return starting;
  const promise = (async () => {
    const info = id.startsWith("__new__") ? undefined : await resolveFeynmanSession(id);
    if (!info && !id.startsWith("__new__")) throw new Error("Feynman session not found");
    const directory = info?.cwd || cwd;
    if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) throw new Error("有效的 Feynman 工作目录是必需的");
    const paths = feynmanPaths();
    if (!existsSync(paths.launcher)) throw new Error("未找到独立 Feynman 安装；不会自动安装或替换现有 Pi");
    const extensionDirectory = join(paths.agent, "extensions");
    mkdirSync(extensionDirectory, { recursive: true, mode: 0o700 });
    const extension = readFileSync(join(process.cwd(), "public/runtime-peer-extension.mjs"), "utf8");
    writePrivateFileAtomicSync(join(extensionDirectory, "pi-web-runtime-peer.js"), extension);
    const { grantFeynmanPeer } = await import("./runtime-peer");
    const source: { session?: FeynmanRpcSession } = {};
    const grant = await grantFeynmanPeer(() => {
      if (!source.session?.sessionId) throw new Error("Feynman peer identity is not ready");
      return { runtime: "feynman", sessionId: source.session.sessionId };
    });
    let release: (() => Promise<void>) | undefined;
    let session: FeynmanRpcSession | undefined;
    try {
      if (info) {
        assertNoExternalFeynmanWriter(paths.root, new Set(feynmanLiveSessions().flatMap((live) => live.processGroup ? [live.processGroup] : [])));
        release = await lockFeynmanSession(info.path, () => session?.stop());
      }
      const child = spawn("python3", [paths.launcher, "--cwd", directory, "--mode", "rpc", "--session-dir", paths.sessions,
        "--model", "openai-codex/gpt-6.1-sol", "--thinking", "medium", "--service-tier", "default",
        ...(info ? ["--session", info.path] : [])], { cwd: directory, stdio: "pipe", detached: true, env: { ...process.env, ...grant.env } });
      child.once("close", () => {
        grant.revoke();
        if (session && registry().sessions.get(session.sessionId) === session) registry().sessions.delete(session.sessionId);
      });
      child.once("error", grant.revoke);
      session = new FeynmanRpcSession(child, directory);
      if (release) session.holdWriterLease(release);
      source.session = session;
      await session.send({ type: "get_state" });
      if (info && session.sessionId !== info.id) throw new Error("Feynman restored a different conversation; stopped to protect isolation");
      const commands = await session.send({ type: "get_commands" }) as { commands?: Array<{ name: string }> };
      if (!commands.commands?.some((command) => command.name === "peer-agent")) throw new Error("Feynman 未加载协作扩展，已停止；不会假装双向互通已接通");
      if (!session.sessionFile) throw new Error("Feynman 未返回独立会话路径，已停止");
      if (!release) {
        release = await lockFeynmanSession(session.sessionFile, () => session?.stop());
        session.holdWriterLease(release);
      }
      if (!session.isAlive()) throw new Error("Feynman 在初始化完成前退出");
      registry().sessions.set(session.sessionId, session);
      const realId = session.sessionId;
      session.onEvent((event) => { for (const listener of registry().channels.get(realId) ?? []) listener(event); });
      return session;
    } catch (error) {
      grant.revoke();
      if (session) await session.shutdown();
      else await release?.().catch(() => {});
      throw error;
    }
  })();
  registry().starting.set(id, promise);
  try { return await promise; } finally { registry().starting.delete(id); }
}
