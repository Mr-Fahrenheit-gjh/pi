"use client";

import { useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { ChatWindow } from "./ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { NewSessionChoices } from "@/hooks/useAgentSession";

export interface SplitConversationControl {
  openSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  newConversation: (cwd: string) => void;
}

export type SharedConversationProps = Pick<ComponentProps<typeof ChatWindow>,
  "modelsRefreshKey" | "onOpenSettings" | "onToolEnd" | "onOpenSubagent" | "onAskInNewChat" |
  "quoteSelectionEnabled" | "soundEnabled" | "onSoundToggle" | "playDoneSound" | "unlockAudio" | "holdAudio">;

interface Props {
  cwd: string | null;
  sessions: SessionInfo[];
  primarySessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  active: boolean;
  controlRef: Ref<SplitConversationControl>;
  onContextChange: (sessionId: string | null, cwd: string | null) => void;
  onRefresh: () => void;
  onOpenFile: (path: string, page?: number, sourceSessionId?: string) => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
  chatProps: SharedConversationProps;
  renderNewSessionContextBar: (cwd: string, onPick: (cwd: string) => void) => ReactNode;
}

type Selection = { kind: "new"; cwd: string; draftKey: string; session?: SessionInfo } | { kind: "session"; session: SessionInfo };
type SearchTarget = { sessionId: string; entryId: string; blockIndex?: number };

/** The same chat surface as the primary pane. Navigation belongs to the shared sidebar and palette. */
export function SplitConversation({ cwd, sessions, primarySessionId, runningSessionIds, active, controlRef, onContextChange, onRefresh, onOpenFile, chatInputRef, chatProps, renderNewSessionContextBar }: Props) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const choicesRef = useRef<NewSessionChoices | null>(null);
  // Opening the same session on the left must not leave two writable copies.
  const duplicate = Boolean(selection?.session && selection.session.id === primarySessionId);
  const session = selection?.session
    ? sessions.find(item => item.id === selection.session?.id) ?? selection.session
    : null;
  const sessionCwd = session?.cwd ?? (selection?.kind === "new" ? selection.cwd : cwd);
  const sessionId = session?.id ?? null;
  useEffect(() => { onContextChange(sessionId, sessionCwd); }, [onContextChange, sessionId, sessionCwd]);
  const choose = (next: Selection) => { setSelection(next); setSearchTarget(null); setQuery(""); };
  const startNew = (nextCwd: string) => choose({ kind: "new", cwd: nextCwd, draftKey: `split:${crypto.randomUUID()}:${nextCwd}` });
  useImperativeHandle(controlRef, () => ({
    openSession(next, entryId, blockIndex) {
      choose({ kind: "session", session: next });
      if (entryId) setSearchTarget({ sessionId: next.id, entryId, blockIndex });
    },
    newConversation: startNew,
  }));
  const matches = sessions.filter(item => !item.transient && item.id !== primarySessionId &&
    `${item.name ?? ""} ${item.firstMessage} ${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.modified.localeCompare(a.modified));
  const moveNewConversation = (nextCwd: string) => {
    if (selection?.kind !== "new" || session || nextCwd === selection.cwd) return;
    const draftKey = `split:${crypto.randomUUID()}:${nextCwd}`;
    chatInputRef.current?.rekeyDraft(selection.draftKey, draftKey);
    setSelection({ kind: "new", cwd: nextCwd, draftKey });
  };

  return <section className="split-conversation" aria-label={t("split.title")}>
    {(!selection || duplicate) ? <div className="split-picker">
      <div className="split-picker-intro"><h2>{t("split.title")}</h2><p>{t("split.description")}</p></div>
      <button type="button" className="split-new" disabled={!cwd} onClick={() => { if (cwd) startNew(cwd); }}>
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
    </div> : <div className="split-chat">
      <ChatWindow
        {...chatProps}
        key={selection.kind === "new" ? selection.draftKey : selection.session.id}
        session={session}
        newSessionCwd={selection.kind === "new" ? selection.cwd : null}
        newSessionDraftKey={selection.kind === "new" ? selection.draftKey : null}
        newSessionContextBar={!session && sessionCwd ? renderNewSessionContextBar(sessionCwd, moveNewConversation) : null}
        initialNewSessionChoices={choicesRef.current}
        onNewSessionChoicesChange={choices => { choicesRef.current = choices; }}
        searchTarget={searchTarget}
        onSearchTargetHandled={() => setSearchTarget(null)}
        sessionRunning={Boolean(session && runningSessionIds.has(session.id))}
        globalEscapeEnabled={active}
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
