"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

type Status = { supported?: boolean; pending?: boolean; epoch?: string; error?: string | null; reason?: string; sessions?: number; terminals?: number };
export function ServiceRestartButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const close = () => {
    if (waiting) return;
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  };
  const restart = async () => {
    if (waiting) return;
    setWaiting(true); setError("");
    const abort = new AbortController();
    controller.current = abort;
    const request = async (init?: RequestInit) => {
      const timeout = new AbortController();
      const cancel = () => timeout.abort();
      abort.signal.addEventListener("abort", cancel, { once: true });
      if (abort.signal.aborted) timeout.abort();
      const timer = window.setTimeout(cancel, 3000);
      try {
        const response = await fetch("/api/service/restart", { ...init, cache: "no-store", signal: timeout.signal });
        const data = await response.json().catch(() => ({})) as Status;
        if (!response.ok) throw Object.assign(new Error(data.reason || "failed"), { rejected: true });
        return data;
      } finally {
        window.clearTimeout(timer);
        abort.signal.removeEventListener("abort", cancel);
      }
    };
    try {
      const before = await request();
      if (!before.supported) throw new Error("unsupported");
      if (before.sessions || before.terminals || before.pending) throw new Error("busy");
      try {
        await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      } catch (error) {
        // A lost response is ambiguous: observe the original epoch, never resend POST.
        if (error && typeof error === "object" && "rejected" in error) throw error;
        if (abort.signal.aborted) return;
      }
      const deadline = Date.now() + 30_000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(done, 600);
          function done() { window.clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); }
          abort.signal.addEventListener("abort", done, { once: true });
        });
        if (abort.signal.aborted) return;
        let status: Status;
        try { status = await request(); } catch { continue; }
        if (status.epoch && status.epoch !== before.epoch) { window.location.reload(); return; }
        if (status.error) throw new Error(status.error === "busy" ? "busy" : "failed");
      }
      if (!abort.signal.aborted) throw new Error("failed");
    } catch (reason) {
      if (!abort.signal.aborted) {
        const code = reason instanceof Error ? reason.message : "failed";
        setError(t(code === "busy" ? "service.restart.busy" : code === "unsupported" ? "service.restart.unsupported" : "service.restart.failed"));
      }
    } finally { if (!abort.signal.aborted) setWaiting(false); }
  };
  return <>
    <button ref={trigger} type="button" className="quiet-action-button service-restart-button" onClick={() => { setError(""); setOpen(true); }} title={t("service.restart.title")} aria-label={t("service.restart.title")}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
      <span>{t("service.restart.label")}</span>
    </button>
    {open && createPortal(<dialog ref={dialog} className="service-restart-dialog" aria-labelledby="restart-title" aria-describedby="restart-description" onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => { if (!waiting) setOpen(false); }}>
      <h2 id="restart-title">{t("service.restart.title")}</h2>
      <p id="restart-description">{t("service.restart.description")}</p>
      {error && <p role="alert">{error}</p>}
      {waiting && <p role="status">{t("service.restart.waiting")}</p>}
      <div className="service-restart-dialog-actions">
        <button type="button" onClick={close} disabled={waiting}>{t("service.restart.cancel")}</button>
        <button type="button" className="service-restart-confirm" onClick={() => void restart()} disabled={waiting}>{t("service.restart.confirm")}</button>
      </div>
    </dialog>, document.body)}
  </>;
}
