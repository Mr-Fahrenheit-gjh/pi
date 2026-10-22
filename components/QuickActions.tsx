"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { runtimeFetch as fetch } from "@/lib/runtime-client.mjs";
import { useI18n } from "@/hooks/useI18n";
import { focusModalPanel, listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { outputPathForCwd } from "@/lib/task-outputs";
import type { SessionInfo } from "@/lib/types";

export interface QuickAction { id: string; label: string; run: () => void }
interface Props {
  actions: QuickAction[]; sessions: SessionInfo[]; cwd: string | null;
  onSession: (session: SessionInfo) => void; onFile: (relativePath: string) => void; onClose: () => void;
}

export function QuickActions({ actions, sessions, cwd, onSession, onFile, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<{ key: string; paths: string[]; failed: boolean }>({ key: "", paths: [], failed: false });
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const fileKey = JSON.stringify([cwd, needle]);
  useLayoutEffect(() => {
    const restore = focusModalPanel(document, panel.current);
    input.current?.focus();
    const stop = listenForStackedDialogEscape(document, onClose);
    return () => { stop(); restore(); };
  }, [onClose]);
  useEffect(() => {
    if (!cwd || !needle) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(needle)}`, { signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error("File search unavailable");
          const data = await response.json();
          const matches: { path?: unknown; isDir?: unknown }[] = Array.isArray(data.matches) ? data.matches : [];
          const paths = [...new Set(matches.filter(match => !match.isDir).map(match => outputPathForCwd(match.path, cwd)).filter((path): path is string => path !== null))].slice(0, 12);
          if (!controller.signal.aborted) setFiles({ key: fileKey, paths, failed: false });
        }).catch(() => { if (!controller.signal.aborted) setFiles({ key: fileKey, paths: [], failed: true }); });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, needle, fileKey]);
  const rows = useMemo(() => [
    ...actions.filter(action => !needle || action.label.toLocaleLowerCase().includes(needle)).map(action => ({ ...action, detail: t("quickActions.command"), key: `action:${action.id}` })),
    ...sessions.filter(session => !needle || `${session.name || ""} ${session.firstMessage || ""}`.toLocaleLowerCase().includes(needle)).slice(0, 8).map(session => ({
      key: `session:${session.id}`, label: (session.name || session.firstMessage || session.id).slice(0, 160), detail: t("quickActions.conversation"), run: () => onSession(session),
    })),
    ...(needle && files.key === fileKey ? files.paths : []).map(path => ({ key: `file:${path}`, label: path, detail: t("quickActions.file"), run: () => onFile(path) })),
  ], [actions, sessions, needle, files, fileKey, onFile, onSession, t]);
  const selected = Math.min(index, Math.max(0, rows.length - 1));
  const choose = (run: () => void) => {
    onClose();
    // Allow modal cleanup to restore its opener before an action focuses a new surface.
    requestAnimationFrame(run);
  };
  return <div className="quick-actions-backdrop" ref={panel} role="dialog" aria-modal="true" aria-label={t("quickActions.title")} tabIndex={-1}
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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
        panel.current?.querySelector(`#${CSS.escape(`${listId}-${next}`)}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && document.activeElement === input.current) {
        event.preventDefault(); if (rows[selected]) choose(rows[selected].run);
      }
    }}>
    <div className="quick-actions-surface">
      <div className="quick-actions-search"><span aria-hidden="true">⌕</span><input ref={input} aria-label={t("quickActions.search")} placeholder={t("quickActions.search")} maxLength={160} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined} />
        <button type="button" onClick={onClose} aria-label={t("fleet.close")}><kbd>esc</kbd></button>
      </div>
      <div className="quick-actions-results" role="listbox" id={listId} aria-label={t("quickActions.results")}>
        {rows.map((row, itemIndex) => <button type="button" role="option" aria-selected={itemIndex === selected} tabIndex={-1} id={`${listId}-${itemIndex}`} key={row.key} onPointerMove={() => setIndex(itemIndex)} onClick={() => choose(row.run)}><span>{row.label}</span><small>{row.detail}</small></button>)}
        {!rows.length && <p>{t("quickActions.empty")}</p>}
      </div>
      <footer><span>↑↓　{t("quickActions.navigate")}　↵　{t("quickActions.open")}</span>{needle && files.key === fileKey && files.failed && <span role="status">{t("quickActions.filesUnavailable")}</span>}</footer>
    </div>
  </div>;
}
