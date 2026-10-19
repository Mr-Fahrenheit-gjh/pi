"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { focusIfLost, focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";
import { formatReleaseHandoff, type PendingReleaseEntry } from "@/lib/pending-release-shared.mjs";
import type { ReleaseLoadState } from "@/lib/pending-release-client.mjs";
import { ConfigButton } from "./SettingsUi";

interface Props extends ReleaseLoadState {
  onClose: () => void;
  onRefresh: () => void;
}

function Evidence({ title, lines }: { title: string; lines: string[] }) {
  const { t } = useI18n();
  return <section className="pending-release-evidence"><h4>{title}</h4>{lines.length
    ? <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    : <p>{t("pendingRelease.none")}</p>}</section>;
}

export function PendingReleasePanel({ snapshot, loading, error, onClose, onRefresh }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"pending" | "deployed">("pending");
  const [copyResult, setCopyResult] = useState<{ id: string; text: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);
  useLayoutEffect(() => focusModalPanel(document, dialogRef.current), []);
  useLayoutEffect(() => { focusIfLost(document, dialogRef.current); }, [snapshot]);
  const entries = snapshot?.entries.filter((entry) => entry.status === tab) ?? [];

  const copy = async (entry: PendingReleaseEntry) => {
    try {
      const text = formatReleaseHandoff(entry);
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        // Keep fallback focus inside this modal and check browsers that refuse copying.
        const focused = document.activeElement as HTMLElement | null;
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        dialogRef.current?.appendChild(input);
        try {
          input.select();
          if (!document.execCommand("copy")) throw new Error("Copy refused");
        } finally { input.remove(); focused?.focus({ preventScroll: true }); }
      }
      setCopyResult({ id: entry.id, text: t("pendingRelease.copied") });
    } catch { setCopyResult({ id: entry.id, text: t("pendingRelease.copyFailed") }); }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("pendingRelease.title")}
      tabIndex={-1}
      className="settings-dialog-backdrop pending-release-dialog"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex='0']") ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault(); first?.focus();
        }
      }}
    >
      <div className="settings-dialog-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("pendingRelease.title")}</strong>
          <nav aria-label={t("pendingRelease.history")} className="settings-section-tabs">
            {(["pending", "deployed"] as const).map((status) => (
              <button key={status} type="button" className="settings-section-tab" aria-current={tab === status ? "page" : undefined} onClick={() => setTab(status)}>
                {t(status === "pending" ? "pendingRelease.title" : "pendingRelease.deployed")}
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} title={t("fleet.close")} aria-label={t("fleet.close")} className="config-close-button settings-dialog-close">×</button>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">
            <div className="pending-release-content" aria-busy={loading}>
              <div className="pending-release-toolbar">
                <p className="settings-general-description">{t("pendingRelease.description")}</p>
                <ConfigButton size="small" onClick={onRefresh}>{t("subagent.refresh")}</ConfigButton>
              </div>
              {loading && <p role="status" className="settings-general-description">{t("fleet.refreshing")}</p>}
              {error && <p role="alert">{error}</p>}
              {snapshot && snapshot.warnings.length > 0 && <div role="alert" className="pending-release-warning">
                <p>{t("pendingRelease.warning")}</p>
                <ul>{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              </div>}
              {!loading && snapshot && !entries.length && <p className="pending-release-empty">
                {t(snapshot.warnings.length ? "pendingRelease.emptyReadable" : tab === "pending" ? "pendingRelease.empty" : "pendingRelease.emptyHistory")}
              </p>}
              {entries.map((entry) => (
                <article key={entry.id} className="pending-release-entry">
                  <div className="pending-release-entry-heading">
                    <h3>{entry.title}</h3><span>{t(`pendingRelease.scope.${entry.scope}`)}</span>
                  </div>
                  <p className="pending-release-summary">{entry.summary}</p>
                  <details>
                    <summary>{t("pendingRelease.details")}</summary>
                    <p className="pending-release-meta">{entry.id} · {t("pendingRelease.revision", { value: entry.revision })}<br />{t("pendingRelease.created", { value: entry.createdAt })}{entry.deployedAt && <><br />{t("pendingRelease.released", { value: entry.deployedAt })}</>}</p>
                    <Evidence title={t("pendingRelease.source")} lines={entry.sourceSessions} />
                    <Evidence title={t("pendingRelease.code")} lines={entry.codeLocations} />
                    <Evidence title={t("pendingRelease.verification")} lines={entry.verification} />
                    <Evidence title={t("pendingRelease.steps")} lines={entry.releaseSteps} />
                    <Evidence title={t("pendingRelease.rollback")} lines={entry.rollback} />
                    <Evidence title={t("pendingRelease.dependencies")} lines={entry.dependencies.map((id) => {
                      const dependency = snapshot?.entries.find((candidate) => candidate.id === id);
                      return dependency ? `${id} · ${dependency.title} (${t(dependency.status === "deployed" ? "pendingRelease.deployed" : "pendingRelease.title")})` : t("pendingRelease.missingDependency", { id });
                    })} />
                  </details>
                  <div className="pending-release-copy">
                    <ConfigButton size="small" onClick={() => void copy(entry)}>{t("pendingRelease.copy")}</ConfigButton>
                    {copyResult?.id === entry.id && <span role="status">{copyResult.text}</span>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
