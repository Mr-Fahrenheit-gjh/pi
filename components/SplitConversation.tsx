"use client";

import { useState } from "react";
import { ChatWindow } from "./ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";

interface Props {
  cwd: string | null;
  sessions: SessionInfo[];
  primarySessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  active: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenFile: (path: string, page?: number, sourceSessionId?: string) => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
}

type Selection = { kind: "new"; cwd: string; draftKey: string; session?: SessionInfo } | { kind: "session"; session: SessionInfo };

/** A second, independent composer; never changes the primary URL or tab memory. */
export function SplitConversation({ cwd, sessions, primarySessionId, runningSessionIds, active, onClose, onRefresh, onOpenFile, chatInputRef }: Props) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [choosing, setChoosing] = useState(true);
  const [query, setQuery] = useState("");
  // Opening the same session on the left must not leave two writable copies.
  const duplicate = Boolean(selection?.session && selection.session.id === primarySessionId);
  const showPicker = choosing || !selection || duplicate;
  const session = selection?.session
    ? sessions.find(item => item.id === selection.session?.id) ?? selection.session
    : null;
  const matches = sessions.filter(item => !item.transient && item.id !== primarySessionId &&
    `${item.name ?? ""} ${item.firstMessage} ${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.modified.localeCompare(a.modified));
  const choose = (next: Selection) => { setSelection(next); setChoosing(false); setQuery(""); };

  return <section className="split-conversation" aria-label={t("split.title")}>
    <header className="split-conversation-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M12 4v16" /></svg>
      <span className="split-conversation-title">{showPicker ? t("split.title") : session?.name || session?.firstMessage || t("split.new")}</span>
      {selection && !duplicate && <button type="button" onClick={() => setChoosing(!choosing)}>{t(choosing ? "split.back" : "split.change")}</button>}
      <button type="button" aria-label={t("split.close")} title={t("split.close")} onClick={onClose}>×</button>
    </header>
    {showPicker && <div className="split-picker">
      <div className="split-picker-intro"><h2>{t("split.title")}</h2><p>{t("split.description")}</p></div>
      <button type="button" className="split-new" disabled={!cwd} onClick={() => { if (cwd) choose({ kind: "new", cwd, draftKey: `split:${crypto.randomUUID()}:${cwd}` }); }}>
        <span className="split-new-icon" aria-hidden="true">＋</span><span><strong>{t("split.new")}</strong><small>{cwd || t("split.selectProject")}</small></span><span aria-hidden="true">↗</span>
      </button>
      <label className="split-history-label" htmlFor="split-history-search">{t("split.history")}</label>
      <input id="split-history-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("split.search")} />
      <div className="split-history-list">
        {matches.map(item => <button type="button" key={item.id} onClick={() => choose({ kind: "session", session: item })}>
          <span className="split-history-heading"><strong>{item.name || item.firstMessage || t("split.untitled")}</strong>{runningSessionIds.has(item.id) && <span className="split-running" aria-label={t("split.running")} />}</span>
          <small>{item.cwd}</small>
        </button>)}
        {!matches.length && <p className="split-empty">{t("split.empty")}</p>}
      </div>
    </div>}
    {/* Keep a parked composer mounted while choosing: drafts, uploads and runs survive Back. */}
    {selection && !duplicate && <div className="split-chat" hidden={showPicker}>
      <ChatWindow
        key={selection.kind === "new" ? selection.draftKey : selection.session.id}
        session={session}
        newSessionCwd={selection.kind === "new" ? selection.cwd : null}
        newSessionDraftKey={selection.kind === "new" ? selection.draftKey : null}
        sessionRunning={Boolean(session && runningSessionIds.has(session.id))}
        globalEscapeEnabled={active && !showPicker}
        chatInputRef={chatInputRef}
        onSessionCreated={(created, draftKey) => {
          // Keep the key stable when the draft receives its real session id.
          setSelection(current => current?.kind === "new" && current.draftKey === draftKey ? { ...current, session: created } : current);
          onRefresh();
        }}
        onAgentEnd={onRefresh}
        onOpenFile={(path, page) => onOpenFile(path, page, session?.id)}
        onFilesUploaded={onRefresh}
      />
    </div>}
  </section>;
}
