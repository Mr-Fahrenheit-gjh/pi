"use client";
import { runtimeFetch as fetch } from "@/lib/runtime-client.mjs";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { englishText } from "@/lib/i18n/english.mjs";
import type { UiTranslate } from "@/lib/i18n/types";
import {
  fleetCanResume, fleetCommand, fleetIsActive, fleetReadableDetails, fleetRequest, fleetCostText,
  fleetStateLabel, fleetUrl, normalizeFleetView,
  type FleetMethod, type FleetRow, type FleetView, type SteerMode,
} from "@/lib/subagent-fleet-view";

export interface SubagentFleetPanelProps { sessionId: string; onClose?: () => void }
const buttonClass = "rounded border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed";
const errorText = (error: unknown, t: UiTranslate = englishText) => error instanceof Error ? error.message : t("fleet.requestFailed");

/** Embeddable panel, not a modal. Session changes remount all state and cancel old requests. */
export function SubagentFleetPanel(props: SubagentFleetPanelProps) {
  return <SessionFleetPanel key={props.sessionId} {...props} />;
}

function SessionFleetPanel({ sessionId, onClose }: SubagentFleetPanelProps) {
  const { t, locale } = useI18n();
  // Locale changes update copy without cancelling an in-flight control request.
  const copy = useRef({ t, locale });
  copy.current = { t, locale };
  const root = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const visible = useRef(true);
  const currentView = useRef<FleetView | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const commandRequest = useRef<AbortController | null>(null);
  const [viewData, setViewData] = useState<unknown>(null);
  const view = useMemo(() => viewData === null ? null : normalizeFleetView(viewData, t), [viewData, t]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detailRecord, setDetailRecord] = useState<{ id: string; view: unknown } | null>(null);
  const detail = useMemo(() => detailRecord?.id === selected ? normalizeFleetView(detailRecord.view, t) : null, [detailRecord, selected, t]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<SteerMode>("auto");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [stopConfirm, setStopConfirm] = useState(false);
  const [costData, setCostData] = useState<unknown>(null);
  const [costError, setCostError] = useState("");
  const costReport = useMemo(() => costData === null ? costError : fleetCostText(costData, t, locale), [costData, costError, t, locale]);
  const [costBusy, setCostBusy] = useState(false);
  const selectedRun = view?.runs.find((run) => run.id === selected);

  const refresh = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const data = await fleetRequest(fleetUrl(sessionId), controller.signal);
      if (!alive.current || listRequest.current !== controller || controller.signal.aborted) return;
      currentView.current = normalizeFleetView(data);
      setViewData(data);
      setError("");
      setRevision((value) => value + 1);
    } catch (reason) {
      if (alive.current && listRequest.current === controller) {
        setError(controller.signal.aborted ? copy.current.t("fleet.loadTimeout") : errorText(reason, copy.current.t));
      }
    } finally {
      window.clearTimeout(timeout);
      if (alive.current && listRequest.current === controller) {
        listRequest.current = null;
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const isVisible = () => visible.current && document.visibilityState === "visible";
    let idleTicks = 0;
    const maybeRefresh = () => {
      const active = !currentView.current || currentView.current.active;
      if (!active && ++idleTicks % 3 !== 0) return;
      if (isVisible() && !listRequest.current && !commandRequest.current) void refresh();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
      if (!isVisible()) {
        // Clear the reference before aborting so an obsolete request cannot publish errors.
        const obsolete = listRequest.current;
        listRequest.current = null;
        obsolete?.abort();
        setLoading(false);
      } else maybeRefresh();
    });
    if (root.current) observer?.observe(root.current);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        const obsolete = listRequest.current;
        listRequest.current = null;
        obsolete?.abort();
        setLoading(false);
      } else maybeRefresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(maybeRefresh, 5_000);
    return () => {
      alive.current = false;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
      listRequest.current?.abort();
      commandRequest.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    setDetailError("");
    if (!selected) { setDetailLoading(false); return; }
    const controller = new AbortController();
    let current = true;
    setDetailLoading(true);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void fleetRequest(fleetUrl(sessionId, selected), controller.signal).then((data) => {
      if (current && !controller.signal.aborted) setDetailRecord({ id: selected, view: data });
    }).catch((reason) => {
      if (current) setDetailError(controller.signal.aborted ? copy.current.t("fleet.recordTimeout") : errorText(reason, copy.current.t));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (current) setDetailLoading(false);
    });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [sessionId, selected, revision]);

  const selectRun = (id: string) => {
    setSelected(id);
    setMessage("");
    setStopConfirm(false);
    setActionError("");
    setNotice("");
  };
  const command = async (method: FleetMethod) => {
    if (!selectedRun?.id || commandRequest.current) return;
    const controller = new AbortController();
    commandRequest.current = controller;
    // A pre-command snapshot must never overwrite the result of a control action.
    const obsolete = listRequest.current;
    listRequest.current = null;
    obsolete?.abort();
    setLoading(false);
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await fleetRequest(fleetUrl(sessionId), controller.signal, fleetCommand(method, selectedRun.id, message, mode));
      if (!alive.current || controller.signal.aborted) return;
      setNotice(copy.current.t(method === "stop" ? "fleet.stopSent" : method === "resume" ? "fleet.resumeSent" : method === "interrupt" ? "fleet.pauseSent" : "fleet.steerSent"));
      setMessage("");
      setStopConfirm(false);
      void refresh();
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) setActionError(copy.current.t("fleet.actionErrorHint", { error: errorText(reason, copy.current.t) }));
    } finally {
      if (alive.current) { commandRequest.current = null; setBusy(false); }
    }
  };

  const loadCost = async () => {
    setCostBusy(true);
    try {
      const response = await fetch(fleetUrl(sessionId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "cost" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? copy.current.t("fleet.costFailed"));
      if (alive.current) { setCostData(data); setCostError(""); }
    } catch (reason) { if (alive.current) { setCostData(null); setCostError(errorText(reason, copy.current.t)); } }
    finally { if (alive.current) setCostBusy(false); }
  };

  return (
    <section ref={root} aria-label={t("fleet.title")} className="flex min-h-0 w-full min-w-0 flex-col bg-[var(--bg-panel)] text-[var(--text)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
        <h2 className="mr-auto font-semibold">{t("fleet.title")}{view?.totalActive !== undefined ? t("fleet.activeCount", { count: view.totalActive }) : ""}</h2>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh()}>{loading ? t("fleet.refreshing") : t("subagent.refresh")}</button>
        <button type="button" className={buttonClass} disabled={costBusy} onClick={() => void loadCost()}>{costBusy ? t("fleet.loading") : t("fleet.cost")}</button>
        {onClose && <button type="button" className={buttonClass} onClick={onClose}>{t("fleet.close")}</button>}
      </header>
      <div className="min-h-0 overflow-auto p-3">
        <p className="mb-3 text-xs text-[var(--text-muted)]">{t("fleet.description")}</p>
        {costReport && <details open className="mb-3"><summary className="cursor-default text-sm">{t("fleet.usageTitle")}</summary><SafeText text={costReport} /></details>}
        {error && <p role="alert" className="mb-3 break-words text-sm">{t("fleet.loadFailed", { error })}{view ? t("fleet.previousResult") : ""}</p>}
        {!view && loading && <p role="status">{t("fleet.loadingTasks")}</p>}
        {view && !view.available && <p role="status">{t("fleet.unavailable")}{view.error}</p>}
        {view?.available && <>
          {view.runs.length === 0 && view.fleet.length === 0 && <p role="status">{t("fleet.empty")}</p>}
          <ul className="space-y-2" aria-label={t("fleet.runs")}>
            {view.runs.map((run) => <li key={run.key} className="rounded border border-[var(--border)] p-3">
              <RowSummary row={run} />
              {run.id ? <button type="button" className={`${buttonClass} mt-2`} disabled={busy} aria-pressed={selected === run.id} onClick={() => selectRun(run.id!)}>{t("fleet.viewRun")}</button>
                : <p className="mt-2 text-xs text-[var(--text-muted)]">{t("fleet.displayOnly")}</p>}
            </li>)}
          </ul>
          {view.fleet.length > 0 && <div className="mt-4">
            <h3 className="text-sm font-semibold">{t("fleet.members")}</h3>
            <p className="mb-2 text-xs text-[var(--text-muted)]">{t("fleet.memberHint")}</p>
            <ul className="space-y-2">{view.fleet.map((row) => <li key={row.key} className="rounded border border-[var(--border)] p-3"><RowSummary row={row} /></li>)}</ul>
          </div>}
          {(view.omitted > 0 || view.omittedRuns > 0 || view.omittedChildren > 0) && <p className="mt-2 text-xs text-[var(--text-muted)]">{t("fleet.omitted", { members: view.omitted, runs: view.omittedRuns, steps: view.omittedChildren })}</p>}
          {view.text && <details className="mt-3"><summary className="cursor-default text-sm">{t("fleet.summary")}</summary><SafeText text={view.text} /></details>}
        </>}
        {selected && <section aria-label={t("fleet.recordActions")} className="mt-4 rounded border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto break-all font-semibold">{selectedRun?.label ?? t("fleet.record")}</h3>
            <button type="button" className={buttonClass} onClick={() => setRevision((value) => value + 1)}>{t("fleet.refreshRecord")}</button>
          </div>
          <p className="mt-1 break-all text-xs text-[var(--text-muted)]">{selected}</p>
          {detailLoading && <p role="status" className="mt-2">{detail ? t("fleet.refreshingRecord") : t("fleet.loadingRecord")}</p>}
          {detailError && <p role="alert" className="mt-2">{t("fleet.recordFailed", { error: detailError })}</p>}
          {detail && <>{!detail.available ? <p className="mt-2">{t("fleet.recordUnavailable")}{detail.error}</p> : <>
            <SafeText text={detail.text ?? (fleetReadableDetails(detail.details, t) || t("fleet.noRecord"))} />
            {detail.text && detail.details !== undefined && <details><summary className="cursor-default text-sm">{t("fleet.structuredDetails")}</summary><SafeText text={fleetReadableDetails(detail.details, t)} /></details>}
          </>}</>}
          {selectedRun && view?.available && !error ? <>
            {(fleetIsActive(selectedRun.state) || fleetCanResume(selectedRun.state)) && <div className="mt-3 space-y-2">
              <label className="block text-sm">{fleetIsActive(selectedRun.state) ? t("fleet.guidance") : t("fleet.resumeMessage")}
                <textarea value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder={t("fleet.messagePlaceholder")}
                  className="mt-1 block w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-base" />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {fleetIsActive(selectedRun.state) ? <>
                  <label className="text-sm">{t("fleet.delivery")} <select className="rounded border border-[var(--border)] bg-[var(--bg)] p-2" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as SteerMode)}>
                    <option value="auto">{t("fleet.deliveryAuto")}</option><option value="steer">{t("fleet.deliverySteer")}</option><option value="follow_up">{t("fleet.deliveryFollowUp")}</option>
                  </select></label>
                  <button type="button" className={buttonClass} disabled={busy || !message.trim()} onClick={() => void command("steer")}>{t("fleet.sendGuidance")}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void command("interrupt")}>{t("fleet.pause")}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setStopConfirm(true)}>{t("fleet.stop")}</button>
                </> : <button type="button" className={buttonClass} disabled={busy || !message.trim()} onClick={() => void command("resume")}>{t("fleet.resume")}</button>}
              </div>
              {stopConfirm && <div className="rounded border border-[var(--border)] p-3" role="group" aria-label={t("fleet.stopConfirmation")}>
                <p className="mb-2 text-sm">{t("fleet.stopWarning")}</p>
                <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void command("stop")}>{t("fleet.confirmStop")}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setStopConfirm(false)}>{t("fleet.cancel")}</button></div>
              </div>}
            </div>}
          </> : <p className="mt-3 text-xs text-[var(--text-muted)]">{t("fleet.confirmCurrent")}</p>}
          {busy && <p role="status" className="mt-2 text-sm">{t("fleet.sending")}</p>}
          {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
          {actionError && <p role="alert" className="mt-2 break-words text-sm">{t("fleet.actionFailed", { error: actionError })}</p>}
        </section>}
      </div>
    </section>
  );
}

function SafeText({ text }: { text: string }) {
  return <pre className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-3 text-sm [overflow-wrap:anywhere]">{text}</pre>;
}
function RowSummary({ row }: { row: FleetRow }) {
  const { t, locale } = useI18n();
  return <>
    <div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium [overflow-wrap:anywhere]">{row.label}</span><span className="text-xs text-[var(--text-muted)]">{fleetStateLabel(row.state, t)}</span></div>
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">
      <span>{t("fleet.role", { value: row.role ?? row.label })}</span>{row.model && <span>{t("fleet.model", { value: row.model })}</span>}
      {row.metrics.map((metric) => <span key={metric.label}>{metric.label}: {metric.value.toLocaleString(locale, { maximumFractionDigits: 6 })}</span>)}
    </div>
    {row.activity && <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{row.activity}</p>}
    {row.children.length > 0 && <ul className="mt-2 space-y-2 border-l border-[var(--border)] pl-3">{row.children.map((child) => <li key={child.key}><RowSummary row={child} /></li>)}</ul>}
  </>;
}
