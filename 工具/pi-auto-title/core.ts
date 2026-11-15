import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildTitleTranscript } from "./title.ts";

export const STATE = "local.pi.auto-title.v1";
export const MILESTONES = [1, 5, 10] as const;
export type GenerateTitle = (transcript: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<string>;
type Saved = { kind: "attempt" | "applied" | "manual"; count?: number; nameEntryId?: string; title?: string };
type Runtime = {
  id: string;
  file?: string;
  stopped: boolean;
  manual: boolean;
  attempts: Set<number>;
  ownedNames: Set<string>;
  lastApplied: number;
  seen: WeakSet<object>;
  controllers: Set<AbortController>;
  writing: boolean;
};

function saved(entry: SessionEntry): Saved | undefined {
  return entry.type === "custom" && entry.customType === STATE ? entry.data as Saved : undefined;
}

/** Global name ownership is intentionally session-wide, even after branch changes. */
function hasManualName(entries: SessionEntry[], runtime: Runtime): boolean {
  const owned = new Set(runtime.ownedNames);
  for (const entry of entries) {
    const data = saved(entry);
    if (data?.kind === "manual") return true;
    if (data?.kind === "applied" && data.nameEntryId) owned.add(data.nameEntryId);
  }
  return entries.some(entry => entry.type === "session_info" && !owned.has(entry.id));
}

function diskEntries(file?: string): SessionEntry[] {
  if (!file) return [];
  // Fail closed if the file cannot be read. Do not overwrite an unknown title.
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export function installAutoTitle(pi: ExtensionAPI, generate: GenerateTitle) {
  let current: Runtime | undefined;

  function stop(runtime = current) {
    if (!runtime) return;
    runtime.stopped = true;
    for (const controller of runtime.controllers) controller.abort();
  }

  function restore(ctx: ExtensionContext) {
    stop();
    const entries = ctx.sessionManager.getEntries();
    const runtime: Runtime = {
      id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(),
      stopped: false, manual: false, attempts: new Set(), ownedNames: new Set(),
      lastApplied: 0, seen: new WeakSet(), controllers: new Set(), writing: false,
    };
    for (const entry of entries) {
      const data = saved(entry);
      if (data?.kind === "attempt" && typeof data.count === "number") runtime.attempts.add(data.count);
      if (data?.kind === "applied") {
        if (data.nameEntryId) runtime.ownedNames.add(data.nameEntryId);
        runtime.lastApplied = Math.max(runtime.lastApplied, data.count ?? 0);
      }
    }
    runtime.manual = hasManualName(entries, runtime);
    // Child sessions have their own metadata/name; do not spend naming calls on them.
    runtime.stopped = entries.some(entry => entry.type === "custom" &&
      ["pi-web:subagent", "subagent:meta", "subagent-run"].includes(entry.customType)) ||
      Number(process.env.PI_SUBAGENT_DEPTH ?? 0) > 0 || !!process.env.PI_SUBAGENT_ID;
    current = runtime;
    return runtime;
  }

  function lockManual(runtime: Runtime) {
    if (runtime.manual) return;
    runtime.manual = true;
    pi.appendEntry(STATE, { kind: "manual" } satisfies Saved);
    for (const controller of runtime.controllers) controller.abort();
  }

  function isCurrent(runtime: Runtime, ctx: ExtensionContext) {
    return current === runtime && !runtime.stopped && !runtime.manual &&
      ctx.sessionManager.getSessionId() === runtime.id &&
      ctx.sessionManager.getSessionFile() === runtime.file;
  }

  pi.on("session_start", (_event, ctx) => { restore(ctx); });
  pi.on("session_tree", (_event, ctx) => { restore(ctx); });
  pi.on("session_shutdown", () => { stop(); });
  pi.on("session_info_changed", (_event, ctx) => {
    const runtime = current;
    if (!runtime || runtime.stopped || runtime.writing) return;
    if (hasManualName(ctx.sessionManager.getEntries(), runtime)) lockManual(runtime);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    const runtime = current ?? restore(ctx);
    if (!isCurrent(runtime, ctx) || runtime.seen.has(event.message)) return;
    runtime.seen.add(event.message);
    const entries = ctx.sessionManager.getEntries();
    if (hasManualName(entries, runtime)) { lockManual(runtime); return; }
    const branch = ctx.sessionManager.getBranch();
    // Pi dispatches message_end to extensions BEFORE persisting this message.
    const messages = branch.filter(entry => entry.type === "message").map(entry => entry.message);
    if (!messages.includes(event.message)) messages.push(event.message);
    const count = messages.filter(message => message.role === "user").length;
    if (!(MILESTONES as readonly number[]).includes(count) || runtime.attempts.has(count)) return;

    const transcript = buildTitleTranscript(messages as AgentMessage[]);
    if (!transcript.trim()) return;
    runtime.attempts.add(count);
    // Reserve synchronously before any await: reload/retry never charges twice.
    pi.appendEntry(STATE, { kind: "attempt", count, attemptedAt: Date.now() });
    const controller = new AbortController();
    runtime.controllers.add(controller);
    // Detached from the agent handler: a naming request must not delay the answer.
    void (async () => {
      try {
        const title = await generate(transcript, ctx, controller.signal);
        if (!isCurrent(runtime, ctx) || controller.signal.aborted || count < runtime.lastApplied) return;
        if (hasManualName(ctx.sessionManager.getEntries(), runtime) ||
            hasManualName(diskEntries(runtime.file), runtime)) { lockManual(runtime); return; }
        // No await between the final protection check, SDK rename and ownership marker.
        runtime.writing = true;
        try {
          pi.setSessionName(title);
          const names = ctx.sessionManager.getEntries().filter(entry => entry.type === "session_info");
          const nameEntryId = names.at(-1)?.id;
          if (!nameEntryId) throw new Error("Pi did not persist the session title");
          runtime.ownedNames.add(nameEntryId);
          runtime.lastApplied = count;
          pi.appendEntry(STATE, { kind: "applied", count, title, nameEntryId } satisfies Saved);
        } finally { runtime.writing = false; }
      } catch (error) {
        if (!isCurrent(runtime, ctx) || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        pi.appendEntry(STATE, { kind: "error", count, message });
        console.error(`[pi-auto-title] message ${count}: ${message}`);
        if (ctx.hasUI) ctx.ui.notify(`第 ${count} 条消息的自动命名失败：${message}`, "warning");
      } finally { runtime.controllers.delete(controller); }
    })();
  });
}
