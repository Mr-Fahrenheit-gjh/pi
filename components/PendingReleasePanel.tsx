"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusIfLost, focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";
import { formatReleaseHandoff, RELEASE_SCOPES, type PendingReleaseEntry } from "@/lib/pending-release-shared.mjs";
import type { ReleaseLoadState } from "@/lib/pending-release-client.mjs";
import { ConfigButton } from "./SettingsUi";

interface Props extends ReleaseLoadState {
  onClose: () => void;
  onRefresh: () => void;
}

function Evidence({ title, lines }: { title: string; lines: string[] }) {
  return <section className="pending-release-evidence"><h4>{title}</h4>{lines.length
    ? <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    : <p>无</p>}</section>;
}

export function PendingReleasePanel({ snapshot, loading, error, onClose, onRefresh }: Props) {
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
      setCopyResult({ id: entry.id, text: "已复制" });
    } catch { setCopyResult({ id: entry.id, text: "复制失败，请重试" }); }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="待上线"
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
          <strong className="settings-dialog-title">待上线</strong>
          <nav aria-label="上线记录" className="settings-section-tabs">
            {(["pending", "deployed"] as const).map((status) => (
              <button key={status} type="button" className="settings-section-tab" aria-current={tab === status ? "page" : undefined} onClick={() => setTab(status)}>
                {status === "pending" ? "待上线" : "已上线"}
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭" className="config-close-button settings-dialog-close">×</button>
        </div>
        <main className="settings-dialog-main">
          <div className="settings-section-host">
            <div className="pending-release-content" aria-busy={loading}>
              <div className="pending-release-toolbar">
                <p className="settings-general-description">已完成、已验证的 Pi 改动；这里只查看和复制，不执行上线。</p>
                <ConfigButton size="small" onClick={onRefresh}>刷新</ConfigButton>
              </div>
              {loading && <p role="status" className="settings-general-description">正在刷新…</p>}
              {error && <p role="alert">{error}</p>}
              {snapshot && snapshot.warnings.length > 0 && <div role="alert" className="pending-release-warning">
                <p>部分记录不可用，数量不完整。以下仅显示可读取的条目。</p>
                <ul>{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              </div>}
              {!loading && snapshot && !entries.length && <p className="pending-release-empty">
                {snapshot.warnings.length ? "暂无可读取的记录。" : tab === "pending" ? "暂无待上线改动。" : "暂无已上线记录。"}
              </p>}
              {entries.map((entry) => (
                <article key={entry.id} className="pending-release-entry">
                  <div className="pending-release-entry-heading">
                    <h3>{entry.title}</h3><span>{RELEASE_SCOPES[entry.scope]}</span>
                  </div>
                  <p className="pending-release-summary">{entry.summary}</p>
                  <details>
                    <summary>查看详情</summary>
                    <p className="pending-release-meta">{entry.id} · 修订 {entry.revision}<br />创建：{entry.createdAt}{entry.deployedAt && <><br />上线：{entry.deployedAt}</>}</p>
                    <Evidence title="源会话" lines={entry.sourceSessions} />
                    <Evidence title="代码位置" lines={entry.codeLocations} />
                    <Evidence title="验证结果（登记者提供）" lines={entry.verification} />
                    <Evidence title="上线步骤" lines={entry.releaseSteps} />
                    <Evidence title="回退" lines={entry.rollback} />
                    <Evidence title="依赖" lines={entry.dependencies.map((id) => {
                      const dependency = snapshot?.entries.find((candidate) => candidate.id === id);
                      return dependency ? `${id} · ${dependency.title}（${dependency.status === "deployed" ? "已上线" : "待上线"}）` : `${id}（未找到可读取的登记）`;
                    })} />
                  </details>
                  <div className="pending-release-copy">
                    <ConfigButton size="small" onClick={() => void copy(entry)}>复制交接说明</ConfigButton>
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
