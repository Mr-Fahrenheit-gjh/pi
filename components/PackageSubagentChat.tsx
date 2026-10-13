"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageView } from "./MessageView";
import { fleetRequest, fleetStateLabel, fleetUrl } from "@/lib/subagent-fleet-view";
import type { PackageAgentTarget } from "@/hooks/usePackageSubagents";
import type { AgentMessage, SessionInfo, ToolResultMessage } from "@/lib/types";

type Chat = { messages: AgentMessage[]; text?: string; truncated?: boolean };
const button = "rounded px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text";

/** Selection lives in the native toolbar. This component only reads a child's transcript. */
export function PackageSubagentChat({ session, target, onReturn, onOpenFile }: {
  session: SessionInfo; target: PackageAgentTarget; onReturn: () => void;
  onOpenFile?: (path: string, page?: number) => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : "记录读取失败"); }
      finally { window.clearTimeout(timeout); controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [session.id, runId, index, refresh]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat]);
  const results = useMemo(() => new Map((chat?.messages ?? []).filter((msg): msg is ToolResultMessage => msg.role === "toolResult").map((msg) => [msg.toolCallId, msg])), [chat]);

  return <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label="子代理记录">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
      <button className={button} type="button" onClick={onReturn}>返回主代理</button>
      <span className="min-w-0 flex-1 truncate" title="查看记录不会打断任务；下方输入仍发给主代理">{target.label} · {fleetStateLabel(target.state)} · 输入仍发给主代理</span>
      <button type="button" className={button} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto p-4" onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="mx-auto max-w-[var(--chat-content-max-width,820px)]">
        {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
        {!chat && !error && <p className="text-sm text-text-muted">正在读取子代理记录…</p>}
        {chat?.truncated && <p className="mb-3 text-xs text-text-muted">显示最近的记录</p>}
        {chat?.messages.map((message, index) => <MessageView key={index} message={message} toolResults={results} cwd={session.cwd} onOpenFile={onOpenFile} />)}
        {chat && chat.messages.length === 0 && <pre className="whitespace-pre-wrap break-words text-sm text-text-muted">{chat.text || "子代理尚未写入记录，运行时会自动更新。"}</pre>}
      </div>
    </div>
  </section>;
}
