"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MessageView } from "./MessageView";
import { fleetRequest, fleetUrl } from "@/lib/subagent-fleet-view";
import type { PackageAgentTarget } from "@/hooks/usePackageSubagents";
import type { AgentMessage, SessionInfo, ToolResultMessage } from "@/lib/types";

type Chat = { messages: AgentMessage[]; text?: string; truncated?: boolean };
/** Selection lives in the native toolbar. This component only reads a child's transcript. */
export function PackageSubagentChat({ session, target, onOpenFile }: {
  session: SessionInfo; target: PackageAgentTarget;
  onOpenFile?: (path: string, page?: number) => void;
}) {
  const { t } = useI18n();
  const copy = useRef(t);
  copy.current = t;
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const { runId, index } = target;
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    setChat(null); setError(""); follow.current = true;
    const load = async () => {
      if (controller || document.visibilityState !== "visible") return;
      const query = new URLSearchParams({ view: "chat" });
      if (runId) query.set("id", runId);
      if (index !== undefined) query.set("index", String(index));
      controller = new AbortController();
      const request = controller;
      const timeout = window.setTimeout(() => request.abort(), 15_000);
      try {
        const data = await fleetRequest(`${fleetUrl(session.id)}?${query}`, request.signal) as Chat;
        if (alive) { setChat(data); setError(""); }
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : copy.current("packageChat.failed")); }
      finally { window.clearTimeout(timeout); controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [session.id, runId, index]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat]);
  const results = useMemo(() => new Map((chat?.messages ?? []).filter((msg): msg is ToolResultMessage => msg.role === "toolResult").map((msg) => [msg.toolCallId, msg])), [chat]);

  return <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("packageChat.title")}>
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto p-4" onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="mx-auto max-w-[var(--chat-content-max-width,820px)]">
        {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
        {!chat && !error && <p className="text-sm text-text-muted">{t("packageChat.loading")}</p>}
        {chat?.truncated && <p className="mb-3 text-xs text-text-muted">{t("packageChat.recent")}</p>}
        {chat?.messages.map((message, index) => <MessageView key={index} message={message} toolResults={results} cwd={session.cwd} onOpenFile={onOpenFile} />)}
        {chat && chat.messages.length === 0 && <pre className="whitespace-pre-wrap break-words text-sm text-text-muted">{chat.text || t("packageChat.empty")}</pre>}
      </div>
    </div>
  </section>;
}
