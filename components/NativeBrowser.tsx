"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizePreviewUrl } from "@/lib/browser-preview";
import { browserRequest, createBrowserWriter } from "@/lib/browser-client";
import type { BrowserCommand, BrowserEvent, BrowserPageState } from "@/lib/browser-types";

const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
export function NativeBrowser({ url, onNavigate, collapsed, controlsId, active, onExpand }: {
  url: string; onNavigate: (url: string) => void; collapsed: boolean; controlsId: string; active: boolean; onExpand: () => void;
}) {
  const { t } = useI18n();
  const surface = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const id = useRef(controlsId.replace(/^browser-controls-/, ""));
  const writer = useRef<ReturnType<typeof createBrowserWriter> | null>(null);
  const creation = useRef<Promise<{ state?: BrowserPageState }> | null>(null);
  const mounted = useRef(false);
  const actualUrl = useRef(url);
  const loading = useRef(true);
  const latestUrl = useRef(url);
  const navigateCallback = useRef(onNavigate);
  const [ready, setReady] = useState(false);
  const [reopen, setReopen] = useState(0);
  const [closed, setClosed] = useState(false);
  const [address, setAddress] = useState(url);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState<Extract<BrowserEvent, { type: "frame" }> | null>(null);
  const [page, setPage] = useState<BrowserPageState | null>(null);
  const [prompt, setPrompt] = useState("");
  useEffect(() => { latestUrl.current = url; navigateCallback.current = onNavigate; }, [url, onNavigate]);
  useEffect(() => {
    mounted.current = true;
    const browserId = id.current;
    return () => { mounted.current = false; void writer.current?.stop(); void fetch(`/api/browser/${browserId}`, { method: "DELETE", keepalive: true }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    const rect = surface.current?.getBoundingClientRect();
    if (!creation.current) creation.current = browserRequest("/api/browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id.current, url: latestUrl.current, width: Math.max(200, Math.min(2400, Math.round(rect?.width || 1000))), height: Math.max(150, Math.min(1600, Math.round(rect?.height || 800))) }) });
    creation.current.then(result => {
      if (!mounted.current) { void fetch(`/api/browser/${id.current}`, { method: "DELETE", keepalive: true }); return; }
      if (cancelled || !result.state) return;
      actualUrl.current = result.state.url; setPage(result.state);
      writer.current = createBrowserWriter(id.current, e => { if (mounted.current) setError(e.message); });
      setClosed(false); setReady(true); setError(result.state.error ?? "");
    }).catch((e: Error) => { creation.current = null; if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [active, ready, reopen]);
  useEffect(() => {
    setAddress(url);
    if (ready && url !== actualUrl.current) {
      actualUrl.current = url; loading.current = true; setFrame(null); setError("");
      void writer.current?.send({ type: "navigate", url }, true);
    }
  }, [url, ready]);
  useEffect(() => {
    if (!active || !ready || closed) return;
    const events = new EventSource(`/api/browser/${id.current}/events`);
    events.onmessage = e => {
      const event = JSON.parse(e.data) as BrowserEvent;
      if (event.type === "frame") { if (!loading.current && event.url === actualUrl.current) setFrame(event); }
      else if (event.type === "state") {
        loading.current = event.state.loading;
        setPage(event.state);
        if (event.state.loading) setFrame(null);
        if (event.state.error) setError(event.state.error);
        if (event.state.dialog) setPrompt(event.state.dialog.defaultPrompt);
        if (normalizePreviewUrl(event.state.url) && event.state.url !== actualUrl.current) { actualUrl.current = event.state.url; navigateCallback.current(event.state.url); }
      } else { events.close(); setClosed(true); setError(t("browser.closed")); }
    };
    events.onerror = () => { void browserRequest(`/api/browser/${id.current}`).catch(() => { events.close(); setClosed(true); setError(t("browser.closed")); }); };
    return () => events.close();
  }, [active, ready, closed, t]);
  useEffect(() => {
    if (!active || !ready || !surface.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.max(200, Math.min(2400, Math.round(entry.contentRect.width)));
        const height = Math.max(150, Math.min(1600, Math.round(entry.contentRect.height)));
        const next = `${width}:${height}`;
        if (next === last) return; last = next;
        void writer.current?.send({ type: "resize", width, height });
      }, 100);
    });
    observer.observe(surface.current);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [active, ready]);
  useEffect(() => {
    if (!ready || closed) return;
    const browserId = id.current;
    // Preserve hidden live tabs, including unsent forms; abandoned pages expire.
    const timer = setInterval(() => { void browserRequest(`/api/browser/${browserId}`).catch(() => {}); }, 60000);
    return () => clearInterval(timer);
  }, [ready, closed]);
  const command = (b: BrowserCommand, manual = false) => writer.current?.send(b, manual);
  const reload = () => {
    setError("");
    if (closed || !ready) { creation.current = null; setClosed(false); setReady(false); setReopen(value => value + 1); }
    else void command({ type: "reload" }, true);
  };
  const copy = async () => { const result = await command({ type: "copy" }); if (result?.text) await navigator.clipboard.writeText(result.text); };
  const paste = async () => { try { const text = await navigator.clipboard.readText(); await command({ type: "text", text }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const key = (e: KeyboardEvent<HTMLInputElement>, up: boolean) => {
    if (e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return;
    e.preventDefault(); e.stopPropagation();
    if (!up && (e.metaKey || e.ctrlKey)) {
      if (e.key.toLowerCase() === "l") { onExpand(); requestAnimationFrame(() => { addressInput.current?.focus(); addressInput.current?.select(); }); return; }
      if (e.key.toLowerCase() === "c") { void copy().catch((e: Error) => setError(e.message)); return; }
      if (e.key.toLowerCase() === "v") { void paste(); return; }
      if (e.key.toLowerCase() === "r") { reload(); return; }
    }
    void command({ type: "key", event: up ? "keyUp" : "keyDown", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e), text: !up && [...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? e.key : undefined });
  };
  const point = (clientX: number, clientY: number) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min((page?.width ?? rect.width) - 1, (clientX - rect.left) * (page?.width ?? rect.width) / rect.width)), y: Math.max(0, Math.min((page?.height ?? rect.height) - 1, (clientY - rect.top) * (page?.height ?? rect.height) / rect.height)) };
  };
  useEffect(() => {
    const element = surface.current; if (!element || !ready || !active) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); const rect = element.getBoundingClientRect();
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      void writer.current?.send({ type: "mouse", event: "mouseWheel", x: Math.max(0, Math.min(2399, (e.clientX - rect.left) * (page?.width ?? rect.width) / rect.width)), y: Math.max(0, Math.min(1599, (e.clientY - rect.top) * (page?.height ?? rect.height) / rect.height)), button: "none", buttons: 0, clickCount: 0, modifiers: modifiers(e), deltaX: Math.max(-5000, Math.min(5000, e.deltaX * factor)), deltaY: Math.max(-5000, Math.min(5000, e.deltaY * factor)) });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [active, ready, page?.width, page?.height]);
  return <div className={`terminal-browser-preview${collapsed ? " is-controls-collapsed" : ""}`} data-browser-id={id.current} data-browser-url={page?.url || url} data-browser-title={page?.title || ""} data-browser-loading={String(page?.loading ?? true)}>
    <form id={controlsId} className="terminal-browser-addressbar" hidden={collapsed} onSubmit={e => { e.preventDefault(); const next = normalizePreviewUrl(address); if (next) { setError(""); onNavigate(next); } else setError(t("browser.invalidUrl")); }}>
      <button type="button" aria-label={t("browser.back")} title={t("browser.back")} disabled={!page?.canGoBack} onClick={() => { void command({ type: "back" }, true); }}>←</button>
      <button type="button" aria-label={t("browser.forward")} title={t("browser.forward")} disabled={!page?.canGoForward} onClick={() => { void command({ type: "forward" }, true); }}>→</button>
      <input ref={addressInput} aria-label={t("browser.address")} value={address} onChange={e => setAddress(e.target.value)} inputMode="url" />
      <button type="button" onClick={reload} title={t("browser.reload")} aria-label={t("browser.reload")}>↻</button>
      <a href={page?.url || url} target="_blank" rel="noopener noreferrer" title={t("browser.external")} aria-label={t("browser.external")}>↗</a>
    </form>
    {error && <div className="terminal-browser-error" role="alert">{error}</div>}
    <div ref={surface} className="browser-remote-surface" data-browser-engine="chrome" aria-label={t("browser.viewport")} onContextMenu={e => e.preventDefault()} onPointerDown={e => {
      if (!ready) return; e.preventDefault(); surface.current?.setPointerCapture(e.pointerId);
      if (input.current) { const r = surface.current!.getBoundingClientRect(); input.current.style.left = `${e.clientX - r.left}px`; input.current.style.top = `${e.clientY - r.top}px`; input.current.focus({ preventScroll: true }); }
      void command({ type: "mouse", event: "mousePressed", ...point(e.clientX, e.clientY), button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modifiers(e) });
    }} onPointerUp={e => { if (!ready) return; void command({ type: "mouse", event: "mouseReleased", ...point(e.clientX, e.clientY), button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modifiers(e) }); }} onPointerMove={e => { if (ready) void command({ type: "mouse", event: "mouseMoved", ...point(e.clientX, e.clientY), button: "none", buttons: e.buttons, clickCount: 0, modifiers: modifiers(e) }); }}>
      {/* Browser pixels, not an iframe or a rewritten copy of the website. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {frame && <img className="browser-remote-image" data-browser-frame-url={frame.url} src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} />}
      {!frame && !error && <span className="browser-loading" role="status">{t("browser.loading")}</span>}
      <input type="text" ref={input} className="browser-input-capture" aria-label={t("browser.viewport")} autoComplete="off" autoCapitalize="off" spellCheck={false} onKeyDown={e => key(e, false)} onKeyUp={e => key(e, true)} onCompositionEnd={e => { const text = e.data || e.nativeEvent.data || e.currentTarget.value; if (typeof text === "string" && text) void command({ type: "text", text }); e.currentTarget.value = ""; }} onPaste={e => { e.preventDefault(); void command({ type: "text", text: e.clipboardData.getData("text/plain") }); }} />
    </div>
    {page?.dialog && <div className="browser-dialog" role="dialog" aria-modal="true"><p>{page.dialog.message}</p>{page.dialog.type === "prompt" && <input value={prompt} onChange={e => setPrompt(e.target.value)} />}<button onClick={() => { void command({ type: "dialog", accept: false }); }}>{t("chat.cancel")}</button><button onClick={() => { void command({ type: "dialog", accept: true, promptText: prompt }); }}>{t("chat.confirm")}</button></div>}
  </div>;
}
