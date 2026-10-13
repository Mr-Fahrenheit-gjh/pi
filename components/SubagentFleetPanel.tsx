"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fleetCanResume, fleetCommand, fleetIsActive, fleetReadableDetails, fleetRequest, fleetCostText,
  fleetStateLabel, fleetUrl, normalizeFleetView,
  type FleetMethod, type FleetRow, type FleetView, type SteerMode,
} from "@/lib/subagent-fleet-view";

export interface SubagentFleetPanelProps { sessionId: string; onClose?: () => void }
const buttonClass = "rounded border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";

/** Embeddable panel, not a modal. Session changes remount all state and cancel old requests. */
export function SubagentFleetPanel(props: SubagentFleetPanelProps) {
  return <SessionFleetPanel key={props.sessionId} {...props} />;
}

function SessionFleetPanel({ sessionId, onClose }: SubagentFleetPanelProps) {
  const root = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const visible = useRef(true);
  const currentView = useRef<FleetView | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const commandRequest = useRef<AbortController | null>(null);
  const [view, setView] = useState<FleetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detailRecord, setDetailRecord] = useState<{ id: string; view: FleetView } | null>(null);
  const detail = detailRecord?.id === selected ? detailRecord.view : null;
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<SteerMode>("auto");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [stopConfirm, setStopConfirm] = useState(false);
  const [costReport, setCostReport] = useState<string>("");
  const [costBusy, setCostBusy] = useState(false);
  const selectedRun = view?.runs.find((run) => run.id === selected);

  const refresh = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const next = normalizeFleetView(await fleetRequest(fleetUrl(sessionId), controller.signal));
      if (!alive.current || listRequest.current !== controller || controller.signal.aborted) return;
      currentView.current = next;
      setView(next);
      setError("");
      setRevision((value) => value + 1);
    } catch (reason) {
      if (alive.current && listRequest.current === controller) {
        setError(controller.signal.aborted ? "加载超时，请刷新重试" : errorText(reason));
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
      if (current && !controller.signal.aborted) setDetailRecord({ id: selected, view: normalizeFleetView(data) });
    }).catch((reason) => {
      if (current) setDetailError(controller.signal.aborted ? "记录加载超时" : errorText(reason));
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
      setNotice(method === "stop" ? "已发送停止请求" : method === "resume" ? "已发送续接请求" : method === "interrupt" ? "已请求保存进度并暂停" : "已发送指导消息");
      setMessage("");
      setStopConfirm(false);
      void refresh();
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) setActionError(`${errorText(reason)}。可刷新确认任务状态。`);
    } finally {
      if (alive.current) { commandRequest.current = null; setBusy(false); }
    }
  };

  const loadCost = async () => {
    setCostBusy(true);
    try {
      const response = await fetch(fleetUrl(sessionId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "cost" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "费用读取失败");
      if (alive.current) setCostReport(fleetCostText(data));
    } catch (reason) { if (alive.current) setCostReport(errorText(reason)); }
    finally { if (alive.current) setCostBusy(false); }
  };

  return (
    <section ref={root} aria-label="子任务" className="flex min-h-0 w-full min-w-0 flex-col bg-[var(--bg-panel)] text-[var(--text)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
        <h2 className="mr-auto font-semibold">子任务{view?.totalActive !== undefined ? ` · ${view.totalActive} 个活跃` : ""}</h2>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh()}>{loading ? "刷新中…" : "刷新"}</button>
        <button type="button" className={buttonClass} disabled={costBusy} onClick={() => void loadCost()}>{costBusy ? "读取中…" : "用量与费用"}</button>
        {onClose && <button type="button" className={buttonClass} onClick={onClose}>关闭</button>}
      </header>
      <div className="min-h-0 overflow-auto p-3">
        <p className="mb-3 text-xs text-[var(--text-muted)]">显示当前会话的任务，运行时自动刷新。</p>
        {costReport && <details open className="mb-3"><summary className="cursor-pointer text-sm">主会话与子代理用量</summary><SafeText text={costReport} /></details>}
        {error && <p role="alert" className="mb-3 break-words text-sm">加载失败：{error}{view ? "（下方为上次结果）" : ""}</p>}
        {!view && loading && <p role="status">正在加载子任务…</p>}
        {view && !view.available && <p role="status">当前会话暂不支持子任务。{view.error}</p>}
        {view?.available && <>
          {view.runs.length === 0 && view.fleet.length === 0 && <p role="status">当前没有子任务。</p>}
          <ul className="space-y-2" aria-label="运行列表">
            {view.runs.map((run) => <li key={run.key} className="rounded border border-[var(--border)] p-3">
              <RowSummary row={run} />
              {run.id ? <button type="button" className={`${buttonClass} mt-2`} disabled={busy} aria-pressed={selected === run.id} onClick={() => selectRun(run.id!)}>查看记录与操作</button>
                : <p className="mt-2 text-xs text-[var(--text-muted)]">无有效运行标识，仅展示。</p>}
            </li>)}
          </ul>
          {view.fleet.length > 0 && <div className="mt-4">
            <h3 className="text-sm font-semibold">活跃成员</h3>
            <p className="mb-2 text-xs text-[var(--text-muted)]">可能与上方任务重叠；成员标识不可用于控制。</p>
            <ul className="space-y-2">{view.fleet.map((row) => <li key={row.key} className="rounded border border-[var(--border)] p-3"><RowSummary row={row} /></li>)}</ul>
          </div>}
          {(view.omitted > 0 || view.omittedRuns > 0 || view.omittedChildren > 0) && <p className="mt-2 text-xs text-[var(--text-muted)]">未展示：{view.omitted} 个成员、{view.omittedRuns} 个任务、{view.omittedChildren} 个步骤。</p>}
          {view.text && <details className="mt-3"><summary className="cursor-pointer text-sm">状态摘要</summary><SafeText text={view.text} /></details>}
        </>}
        {selected && <section aria-label="任务记录与操作" className="mt-4 rounded border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto break-all font-semibold">{selectedRun?.label ?? "任务记录"}</h3>
            <button type="button" className={buttonClass} onClick={() => setRevision((value) => value + 1)}>刷新记录</button>
          </div>
          <p className="mt-1 break-all text-xs text-[var(--text-muted)]">{selected}</p>
          {detailLoading && <p role="status" className="mt-2">{detail ? "正在刷新记录…" : "正在加载记录…"}</p>}
          {detailError && <p role="alert" className="mt-2">记录加载失败：{detailError}</p>}
          {detail && <>{!detail.available ? <p className="mt-2">记录暂不可用。{detail.error}</p> : <>
            <SafeText text={detail.text ?? (fleetReadableDetails(detail.details) || "暂无记录")} />
            {detail.text && detail.details !== undefined && <details><summary className="cursor-pointer text-sm">结构化详情</summary><SafeText text={fleetReadableDetails(detail.details)} /></details>}
          </>}</>}
          {selectedRun && view?.available && !error ? <>
            {(fleetIsActive(selectedRun.state) || fleetCanResume(selectedRun.state)) && <div className="mt-3 space-y-2">
              <label className="block text-sm">{fleetIsActive(selectedRun.state) ? "指导消息" : "续接消息"}
                <textarea value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="说明下一步要做什么"
                  className="mt-1 block w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-base" />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {fleetIsActive(selectedRun.state) ? <>
                  <label className="text-sm">发送方式 <select className="rounded border border-[var(--border)] bg-[var(--bg)] p-2" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as SteerMode)}>
                    <option value="auto">自动</option><option value="steer">当前轮结束后指导</option><option value="follow_up">后续跟进</option>
                  </select></label>
                  <button type="button" className={buttonClass} disabled={busy || !message.trim()} onClick={() => void command("steer")}>发送指导</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void command("interrupt")}>暂停并保留进度</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setStopConfirm(true)}>停止</button>
                </> : <button type="button" className={buttonClass} disabled={busy || !message.trim()} onClick={() => void command("resume")}>续接任务</button>}
              </div>
              {stopConfirm && <div className="rounded border border-[var(--border)] p-3" role="group" aria-label="停止确认">
                <p className="mb-2 text-sm">停止后不能续接；要稍后继续，请选择暂停。确定停止这个任务？</p>
                <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void command("stop")}>确认停止</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setStopConfirm(false)}>取消</button></div>
              </div>}
            </div>}
          </> : <p className="mt-3 text-xs text-[var(--text-muted)]">请刷新确认任务仍在当前会话，再进行操作。</p>}
          {busy && <p role="status" className="mt-2 text-sm">正在发送请求…</p>}
          {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
          {actionError && <p role="alert" className="mt-2 break-words text-sm">操作失败：{actionError}</p>}
        </section>}
      </div>
    </section>
  );
}

function SafeText({ text }: { text: string }) {
  return <pre className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-3 text-sm [overflow-wrap:anywhere]">{text}</pre>;
}
function RowSummary({ row }: { row: FleetRow }) {
  return <>
    <div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium [overflow-wrap:anywhere]">{row.label}</span><span className="text-xs text-[var(--text-muted)]">{fleetStateLabel(row.state)}</span></div>
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">
      <span>角色：{row.role ?? row.label}</span>{row.model && <span>模型：{row.model}</span>}
      {row.metrics.map((metric) => <span key={metric.label}>{metric.label}：{metric.value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}</span>)}
    </div>
    {row.activity && <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{row.activity}</p>}
    {row.children.length > 0 && <ul className="mt-2 space-y-2 border-l border-[var(--border)] pl-3">{row.children.map((child) => <li key={child.key}><RowSummary row={child} /></li>)}</ul>}
  </>;
}
