"use client";
import { useEffect, useRef, useState } from "react";
import { VoiceClient, type VoiceView } from "@/lib/voice-client";
import { useI18n } from "@/hooks/useI18n";

export function VoiceControls({ active, sessionId, leafId, appendDraft }: {
  active: boolean; sessionId?: string; leafId?: string | null; appendDraft: (text: string) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<VoiceView | null>(null);
  const client = useRef<VoiceClient | null>(null);
  const append = useRef(appendDraft); append.current = appendDraft;
  useEffect(() => {
    let mounted = true;
    const owned = new VoiceClient((value) => { if (mounted) setView(value); }, (text) => { if (mounted) append.current(text); });
    client.current = owned;
    const leave = () => owned.cancel();
    window.addEventListener("pagehide", leave);
    return () => { mounted = false; owned.cancel(); client.current = null; window.removeEventListener("pagehide", leave); };
  }, []);
  const mode = view?.mode ?? "idle";
  const busy = !["idle", "error"].includes(mode);
  const call = ["connecting", "live", "delegating", "ending"].includes(mode);
  const iconStyle = { width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", borderRadius: 6 };
  return <div className="voice-controls" data-testid="voice-controls" style={{ display: "flex", gap: 2, alignItems: "center" }}>
    <button type="button" style={iconStyle} aria-label={t(mode === "recording" ? "voice.stopRecording" : "voice.dictate")}
      title={t("voice.dictate")} disabled={!active || (busy && mode !== "recording")}
      onClick={() => mode === "recording" ? client.current?.stopDictation() : void client.current?.dictate()}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        {mode === "recording" ? <rect x="6" y="6" width="12" height="12" rx="2"/> : <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>}
      </svg>
    </button>
    <button type="button" style={iconStyle} aria-label={t("voice.call")} title={t(sessionId ? "voice.call" : "voice.savedSession")}
      disabled={!active || busy || !sessionId} onClick={() => sessionId && void client.current?.startCall(sessionId, leafId)}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3H3c-1 8 10 19 18 18v-4l-5-2-2 2a18 18 0 0 1-7-7l2-2-3-5Z"/></svg>
    </button>
    {(busy || view?.notice) && <div className="voice-panel" role="region" aria-label={t("voice.panel")}>
      <div role="status" aria-live="polite">{busy && t(`voice.${mode}`)}{call && ` · ${Math.floor((view?.seconds ?? 0) / 60)}:${String((view?.seconds ?? 0) % 60).padStart(2, "0")}`}</div>
      <div className="voice-rate">{t("voice.rate")}</div>
      {view?.notice && <p role="status">{t(`voice.${view.notice}`)}</p>}
      {view?.usage !== undefined && <p>{t(view.finalUsage ? "voice.finalUsage" : "voice.usage", { seconds: Math.ceil(view.usage) })}</p>}
      {call && <>
        <div className="voice-subtitles" aria-label={t("voice.subtitles")}>
          {view?.user && <p><strong>{t("voice.you")}: </strong>{view.user}</p>}
          {view?.assistant && <p><strong>Pi Live: </strong>{view.assistant}</p>}
        </div>
        {view?.operation && <p role="status">{t(`voice.operation.${view.operation}`)}</p>}
        {view?.task && <div className="voice-handoff">
          <label>{t("voice.review")}<textarea aria-label={t("voice.handoffText")} value={view.task.text} maxLength={4000} onChange={(e) => client.current?.editTask(e.target.value)} /></label>
          <button type="button" disabled={!view.task.text.trim()} onClick={() => void client.current?.handoff()}>{t("voice.handoff")}</button>
          <button type="button" onClick={() => client.current?.dismissTask()}>{t("voice.dismiss")}</button>
        </div>}
        <div className="voice-actions">
          <button type="button" disabled={mode === "connecting" || mode === "ending"} aria-pressed={view?.muted} onClick={() => client.current?.mute()}>{t(view?.muted ? "voice.unmute" : "voice.mute")}</button>
          {view?.audioBlocked && <button type="button" onClick={() => void client.current?.playAudio()}>{t("voice.playAudio")}</button>}
          <button type="button" disabled={mode === "ending"} onClick={() => client.current?.hangup()}>{t("voice.hangup")}</button>
        </div>
      </>}
      {busy && !call && <button type="button" onClick={() => client.current?.cancel()}>{t("voice.cancel")}</button>}
      {!busy && <button type="button" onClick={() => client.current?.dismissNotice()}>{t("voice.dismiss")}</button>}
    </div>}
  </div>;
}
