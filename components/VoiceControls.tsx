"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VoiceClient, type VoiceView } from "@/lib/voice-client";
import { VoiceDraft } from "@/lib/voice-dictation";
import { useI18n } from "@/hooks/useI18n";

function CloseIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19"/></svg>;
}

function MicrophoneIcon({ muted = false }: { muted?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{muted && <path d="m3 3 18 18"/>}
  </svg>;
}

function Waveform({ levels = [], muted = false }: { levels?: number[]; muted?: boolean }) {
  return <div className="voice-waveform" aria-hidden="true" data-muted={muted || undefined}>
    {Array.from({ length: 24 }, (_, index) => <span key={index} style={{ height: 3 + (muted ? 0 : levels[index] ?? 0) * 19 }}/>) }
  </div>;
}

export function VoiceControls({ active, sessionId, leafId, updateDraft, surface, onSurfaceActive, onDictationChange, restoreDraftFocus }: {
  active: boolean; sessionId?: string; leafId?: string | null; updateDraft: (update: (value: string) => string) => void;
  surface: HTMLElement | null; onSurfaceActive: (active: boolean) => void;
  onDictationChange: (active: boolean, pause: () => void) => void; restoreDraftFocus: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<VoiceView | null>(null);
  const client = useRef<VoiceClient | null>(null);
  const draft = useRef(updateDraft); draft.current = updateDraft;
  const surfaceActive = useRef(onSurfaceActive); surfaceActive.current = onSurfaceActive;
  const focus = useRef(restoreDraftFocus); focus.current = restoreDraftFocus;
  const dictationChange = useRef(onDictationChange); dictationChange.current = onDictationChange;
  const dictateButton = useRef<HTMLButtonElement>(null);
  const callButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const priorBusy = useRef(false);
  const focusCapture = useRef(false);
  const focusDraft = useRef(false);
  useEffect(() => {
    let mounted = true, shown = false, listening = false;
    const transcript = new VoiceDraft();
    surfaceActive.current(false);
    const owned = new VoiceClient((value) => {
      if (!mounted) return;
      const next = ["connecting", "live", "delegating"].includes(value.mode);
      const nextListening = ["permission", "recording"].includes(value.mode);
      if (listening !== nextListening) {
        listening = nextListening;
        dictationChange.current(listening, () => { owned.stopDictation(); focus.current(); });
      }
      if (shown && !next && document.activeElement?.closest(".voice-inline")) focusDraft.current = true;
      setView(value);
      if (shown !== next) { shown = next; surfaceActive.current(next); }
    }, (id, text) => { if (mounted) draft.current((value) => transcript.update(value, id, text)); });
    client.current = owned;
    dictationChange.current(false, () => { owned.stopDictation(); focus.current(); });
    const leave = () => owned.cancel();
    window.addEventListener("pagehide", leave);
    return () => {
      mounted = false; owned.cancel(); client.current = null;
      if (shown) surfaceActive.current(false);
      dictationChange.current(false, () => {});
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  const mode = view?.mode ?? "idle";
  const busy = !["idle", "error"].includes(mode);
  const call = ["connecting", "live", "delegating"].includes(mode);
  const capturing = call;
  const dictating = ["permission", "recording", "paused"].includes(mode);
  useEffect(() => {
    // Only transfer focus from our own trigger/controls, never from another editor.
    if (capturing && !priorBusy.current && focusCapture.current) { focusCapture.current = false; cancelButton.current?.focus({ preventScroll: true }); }
    if (!capturing && focusDraft.current && active) { focusDraft.current = false; focus.current(); }
    priorBusy.current = capturing;
  }, [capturing, active]);
  const iconStyle = { width: 32, height: 32, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", borderRadius: 9 };
  const visibleNotice = view?.notice && view.notice !== "draftReady" && view.notice !== "review";
  const inline = <div className="voice-inline" data-mode={mode} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || !capturing) return;
    event.preventDefault(); event.stopPropagation(); client.current?.cancel();
  }}>
    {capturing && <div className="voice-capture-row" role="region" aria-label={t(call ? "voice.call" : "voice.dictate")} title={call ? undefined : t("voice.recordingLimit")}>
      <div className="voice-capture-label">
        <span role="status" aria-live="polite">{t(`voice.${mode}`)}</span>
        {call && <span className="voice-elapsed" aria-label={t("voice.elapsed")}>{Math.floor((view?.seconds ?? 0) / 60)}:{String((view?.seconds ?? 0) % 60).padStart(2, "0")}</span>}
      </div>
      <Waveform levels={view?.levels} muted={view?.muted}/>
      {call ? <>
        <button type="button" className="voice-capture-action" disabled={mode === "connecting"} aria-label={t(view?.muted ? "voice.unmute" : "voice.mute")} title={t(view?.muted ? "voice.unmute" : "voice.mute")} aria-pressed={view?.muted} onClick={() => client.current?.mute()}><MicrophoneIcon muted={view?.muted}/></button>
        <button ref={cancelButton} type="button" className="voice-capture-action" aria-label={t("voice.hangup")} title={t("voice.hangup")} onClick={() => client.current?.hangup()}><CloseIcon/></button>
      </> : null}
    </div>}
    {call && <>
      {view?.audioBlocked && <button type="button" className="voice-text-action" onClick={() => void client.current?.playAudio()}>{t("voice.playAudio")}</button>}
      {view?.task && <div className="voice-handoff">
        <label>{t("voice.review")}<textarea aria-label={t("voice.handoffText")} value={view.task.text} maxLength={4000} onChange={(e) => client.current?.editTask(e.target.value)} /></label>
        <div className="voice-handoff-actions">
          <button type="button" disabled={!view.task.text.trim()} onClick={() => void client.current?.handoff()}>{t("voice.handoff")}</button>
          <button type="button" onClick={() => client.current?.dismissTask()}>{t("voice.dismiss")}</button>
        </div>
      </div>}
      {view?.operation && <p className="voice-inline-status" role="status">{t(`voice.operation.${view.operation}`)}</p>}
      <details className="voice-call-details">
        <summary>{t("voice.details")}</summary>
        <div className="voice-subtitles" aria-label={t("voice.subtitles")}>
          {view?.user && <p><strong>{t("voice.you")}: </strong>{view.user}</p>}
          {view?.assistant && <p><strong>Pi Live: </strong>{view.assistant}</p>}
        </div>
        <p>{t("voice.rate")}</p>
        {view?.usage !== undefined && <p>{t(view.finalUsage ? "voice.finalUsage" : "voice.usage", { seconds: Math.ceil(view.usage) })}</p>}
      </details>
    </>}
    {mode === "ending" && <p className="voice-inline-status" role="status">{t("voice.ending")}</p>}
    {visibleNotice && <div className="voice-inline-notice">
      <span role="status">{t(`voice.${view.notice}`)}{!busy && view?.usage !== undefined && ` ${t(view.finalUsage ? "voice.finalUsage" : "voice.usage", { seconds: Math.ceil(view.usage) })}`}</span>
      {!busy && <button type="button" className="voice-text-action" aria-label={t("voice.dismiss")} onClick={() => client.current?.dismissNotice()}><CloseIcon/></button>}
    </div>}
    {view?.notice === "draftReady" && <span className="sr-only" role="status">{t("voice.draftReady")}</span>}
  </div>;
  return <div className="voice-controls" data-testid="voice-controls" style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <button ref={dictateButton} type="button" style={iconStyle}
      aria-label={t("voice.dictate")} title={t("voice.dictate")}
      disabled={!active || (busy && !dictating)}
      onClick={() => { void client.current?.dictate(); focus.current(); }}><MicrophoneIcon/></button>
    <button ref={callButton} type="button" style={iconStyle} aria-label={t("voice.call")} title={t(sessionId ? "voice.call" : "voice.savedSession")}
      disabled={!active || (busy && mode !== "paused") || !sessionId} onClick={() => { focusCapture.current = true; if (mode === "paused") client.current?.cancel(); if (sessionId) void client.current?.startCall(sessionId, leafId); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 10v4M7 7v10M12 3v18M17 7v10M21 10v4"/></svg>
    </button>
    {surface && createPortal(inline, surface)}
  </div>;
}
