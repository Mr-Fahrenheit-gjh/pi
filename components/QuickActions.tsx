"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { runtimeFetch as fetch } from "@/lib/runtime-client.mjs";
import { quickActionsShortcutMode, type QuickActionsMode } from "@/hooks/useKeyboardShortcuts";
import { useI18n } from "@/hooks/useI18n";
import { SpinnerIcon } from "@/components/SidebarIcons";
import { focusModalPanel, listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { outputPathForCwd } from "@/lib/task-outputs";
import { QUICK_ACTION_PAGE_SIZE, quickActionMatches, quickActionPage, quickActionShortcut, quickSessionMatches } from "@/lib/quick-actions";
import type { SessionSearchResponse } from "@/lib/session-search";
import type { SessionInfo } from "@/lib/types";

export interface QuickAction { id: string; label: string; keywords?: readonly string[]; run: () => void }
interface Props {
  mode: QuickActionsMode; onModeChange: (mode: QuickActionsMode) => void;
  actions: QuickAction[]; sessions: SessionInfo[]; cwd: string | null; currentSessionId: string | null;
  runningSessionIds: ReadonlySet<string>; awaitingInputSessionIds: ReadonlySet<string>; unreadSessionIds: ReadonlySet<string>;
  onSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onFile: (relativePath: string) => void; onClose: () => void;
}

export function QuickActions({ mode, onModeChange, actions, sessions, cwd, currentSessionId, runningSessionIds, awaitingInputSessionIds, unreadSessionIds, onSession, onFile, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<{ key: string; paths: string[]; failed: boolean }>({ key: "", paths: [], failed: false });
  const [content, setContent] = useState<{ query: string; response?: SessionSearchResponse; failed?: boolean }>({ query: "" });
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const switchMode = (next: QuickActionsMode) => {
    if (next !== mode) { setQuery(""); setIndex(0); onModeChange(next); }
    input.current?.focus();
  };
  const search = query.trim();
  const searchLabel = t(mode === "command" ? "quickActions.searchCommands" : "quickActions.search");
  const fileKey = JSON.stringify([cwd, search]);
  const contentResponse = content.query === search ? content.response : undefined;
  const contentFailed = content.query === search && content.failed;
  useLayoutEffect(() => {
    const restore = focusModalPanel(document, panel.current);
    input.current?.focus();
    const stop = listenForStackedDialogEscape(document, onClose);
    return () => { stop(); restore(); };
  }, [onClose]);
  useEffect(() => {
    if (mode !== "chat" || !cwd || !search) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error("File search unavailable");
          const data = await response.json();
          const matches: { path?: unknown; isDir?: unknown }[] = Array.isArray(data.matches) ? data.matches : [];
          const paths = [...new Set(matches.filter(match => !match.isDir).map(match => outputPathForCwd(match.path, cwd)).filter((path): path is string => path !== null))].slice(0, 12);
          if (!controller.signal.aborted) setFiles({ key: fileKey, paths, failed: false });
        }).catch(() => { if (!controller.signal.aborted) setFiles({ key: fileKey, paths: [], failed: true }); });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, cwd, search, fileKey]);
  useEffect(() => {
    if (mode !== "chat" || !search) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/sessions/search?${new URLSearchParams({ q: search })}`, { signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error("Conversation search unavailable");
          const data = await response.json() as SessionSearchResponse;
          if (!controller.signal.aborted) setContent({ query: search, response: data });
        }).catch(() => { if (!controller.signal.aborted) setContent({ query: search, failed: true }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, search]);
  const rows = useMemo(() => [
    ...(mode === "command" ? actions : []).filter(action => quickActionMatches(action, search)).map(action => ({
      ...action, detail: t("quickActions.command"), preview: "", key: `action:${action.id}`,
    })),
    ...(mode === "chat" ? quickSessionMatches(sessions, search, contentResponse?.results ?? [], currentSessionId) : []).map(result => ({
      key: `session:${result.session.id}`, sessionId: result.session.id, label: (result.session.name || result.session.firstMessage || result.session.id).slice(0, 160),
      detail: t(search ? "quickActions.conversation" : "quickActions.recent"),
      preview: result.match ? `${result.before}${result.match}${result.after}` : result.session.cwd,
      run: () => onSession(result.session, result.entryId, result.entryId ? result.blockIndex : undefined),
    })),
    ...(mode === "chat" && search && files.key === fileKey ? files.paths : []).map(path => ({
      key: `file:${path}`, label: path, detail: t("quickActions.file"), preview: "", run: () => onFile(path),
    })),
  ], [mode, actions, sessions, search, contentResponse, currentSessionId, files, fileKey, onFile, onSession, t]);
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  const currentPage = quickActionPage(rows.length, selected);
  const visibleRows = rows.slice(currentPage.start, currentPage.end);
  const movePage = (direction: number) => {
    const page = Math.max(0, Math.min(currentPage.total - 1, currentPage.number - 1 + direction));
    setIndex(page * QUICK_ACTION_PAGE_SIZE);
    input.current?.focus();
  };
  const choose = (run: () => void) => {
    onClose();
    // Modal cleanup restores its opener before a result focuses another surface.
    requestAnimationFrame(run);
  };
  return <div className="quick-actions-backdrop" ref={panel} role="dialog" aria-modal="true" aria-label={t("quickActions.title")} tabIndex={-1}
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      const nextMode = quickActionsShortcutMode(event.nativeEvent);
      if (nextMode) { event.preventDefault(); event.stopPropagation(); switchMode(nextMode); return; }
      if (document.activeElement === input.current) {
        const shortcut = quickActionShortcut(event, query);
        const row = shortcut === null ? undefined : visibleRows[shortcut];
        if (row) { event.preventDefault(); choose(row.run); return; }
        if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          const direction = event.key === "PageDown" || (query === "" && event.key === "ArrowRight") ? 1
            : event.key === "PageUp" || (query === "" && event.key === "ArrowLeft") ? -1 : 0;
          if (direction) { event.preventDefault(); movePage(direction); return; }
        }
      }
      if (event.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"])') || [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length);
        setIndex(next);
        requestAnimationFrame(() => panel.current?.querySelector(`#${CSS.escape(`${listId}-${next}`)}`)?.scrollIntoView({ block: "nearest" }));
      } else if (event.key === "Enter" && document.activeElement === input.current) {
        event.preventDefault(); if (rows[selected]) choose(rows[selected].run);
      }
    }}>
    <div className="quick-actions-surface" data-mode={mode}>
      <div className="quick-actions-search"><span aria-hidden="true">⌕</span><input ref={input} aria-label={searchLabel} placeholder={searchLabel} maxLength={160} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined} />
        <button type="button" onClick={onClose} aria-label={t("fleet.close")}><kbd>esc</kbd></button>
      </div>
      <div className="quick-actions-modes" role="group" aria-label={t("quickActions.mode")}>
        <span className="quick-actions-mode-indicator" aria-hidden="true" />
        {(["command", "chat"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} aria-keyshortcuts={`Meta+${value === "command" ? "K" : "J"} Control+${value === "command" ? "K" : "J"}`} onClick={() => switchMode(value)}>
          {value === "command" ? "Command" : "Chat"}<kbd>{value === "command" ? "⌘K" : "⌘J"}</kbd>
        </button>)}
      </div>
      <div className="quick-actions-results" role="listbox" id={listId} aria-label={t("quickActions.results")}>
        {visibleRows.map((row, pageIndex) => {
          const itemIndex = currentPage.start + pageIndex;
          const status = "sessionId" in row && typeof row.sessionId === "string"
            ? awaitingInputSessionIds.has(row.sessionId) ? "awaiting" : runningSessionIds.has(row.sessionId) ? "running" : unreadSessionIds.has(row.sessionId) ? "unread" : null
            : null;
          const statusLabel = status ? t(status === "awaiting" ? "sidebar.agentAwaitingInput" : status === "running" ? "sidebar.agentRunning" : "sidebar.newSessionActivity") : undefined;
          const digit = String(pageIndex + 1);
          const shortcut = query === "" ? digit : `Alt+${digit}`;
          return <button type="button" role="option" aria-selected={itemIndex === selected} aria-keyshortcuts={shortcut} aria-posinset={itemIndex + 1} aria-setsize={rows.length} tabIndex={-1} id={`${listId}-${itemIndex}`} key={row.key} onPointerMove={() => setIndex(itemIndex)} onClick={() => choose(row.run)}>
            <kbd className="quick-action-shortcut" aria-hidden="true">{query === "" ? digit : `⌥${digit}`}</kbd>
            <span className="quick-action-copy"><span title={row.label}>{row.label}</span>{row.preview && <span className="quick-action-preview" title={row.preview}>{row.preview}</span>}</span>
            <span className="quick-action-meta">
              {status && <span className="quick-action-status" title={statusLabel}>
                {status === "running" ? <SpinnerIcon size={12} label={statusLabel} /> : <span className={status === "awaiting" ? "session-tree-awaiting" : "session-tree-unread"} role="img" aria-label={statusLabel} />}
              </span>}
              <small title={row.detail}>{row.detail}</small>
            </span>
          </button>;
        })}
        {!rows.length && <p>{t("quickActions.empty")}</p>}
      </div>
      <footer><span className="quick-actions-help"><span><kbd>↑↓</kbd> {t("quickActions.navigate")}</span><span><kbd>↵ / {query === "" ? "1–9" : "⌥1–9"}</kbd> {t("quickActions.open")}</span></span>
        {currentPage.total > 1 && <nav className="quick-actions-pages" aria-label={t("quickActions.pages")}>
          <button type="button" aria-label={t("quickActions.previousPage")} disabled={currentPage.number === 1} onClick={() => movePage(-1)}>‹</button>
          <span aria-live="polite" aria-label={t("quickActions.page", { current: currentPage.number, total: currentPage.total })} title={query === "" ? "← / →" : "PageUp / PageDown"}>{currentPage.number} / {currentPage.total}</span>
          <button type="button" aria-label={t("quickActions.nextPage")} disabled={currentPage.number === currentPage.total} onClick={() => movePage(1)}>›</button>
        </nav>}
        {mode === "chat" && search && (!contentResponse || contentResponse.truncated || contentFailed) && <span role="status">{t(contentFailed ? "sidebar.sessionSearchFailed" : contentResponse?.truncated ? "sidebar.sessionSearchPartial" : "sidebar.sessionSearching")}</span>}
        {mode === "chat" && search && files.key === fileKey && files.failed && <span role="status">{t("quickActions.filesUnavailable")}</span>}
      </footer>
    </div>
  </div>;
}
