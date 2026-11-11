"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { presentQuestionOption, type QuestionnairePresentation, type QuestionnaireRequest } from "@/lib/question-presentation";

export type QuestionnaireResponse = { value: string } | { cancelled: true };
export interface QuestionnaireFormProps {
  model: QuestionnairePresentation;
  // Only the live queue head, never the presentation anchor's cached request.
  wireRequest: QuestionnaireRequest | null;
  onPrepare: (request: QuestionnaireRequest, response: QuestionnaireResponse) => Promise<boolean>;
  onAnswer: (request: QuestionnaireRequest, response: QuestionnaireResponse) => Promise<boolean>;
  onDismiss: () => void;
}

export function QuestionnaireForm({ model, wireRequest, onPrepare, onAnswer, onDismiss }: QuestionnaireFormProps) {
  const { t } = useI18n();
  const name = useId();
  const [mode, setMode] = useState<"option" | "custom">(wireRequest?.method === "input" ? "custom" : "option");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false);
  const preparingId = useRef<string | null>(null);

  useEffect(() => {
    if (wireRequest && preparingId.current && wireRequest.id !== preparingId.current) {
      preparingId.current = null;
      locked.current = false;
      setBusy(false);
    }
  }, [wireRequest]);

  const prepare = async (nextMode: "option" | "custom") => {
    if (locked.current || !wireRequest) return;
    const response = nextMode === "custom" && wireRequest.method === "select" && model.other && wireRequest.options.includes(model.other)
      ? { value: model.other }
      : nextMode === "option" && wireRequest.method === "input" ? { cancelled: true as const } : null;
    if (!response) return;
    locked.current = true;
    preparingId.current = wireRequest.id;
    setBusy(true);
    setError(false);
    const ok = await onPrepare(wireRequest, response);
    if (!ok) {
      preparingId.current = null;
      locked.current = false;
      setBusy(false);
      setError(true);
    }
  };
  // The live queue removes expired requests; the submit handler rechecks expiry.
  const ready = !busy && wireRequest;
  const canSend = Boolean(ready && (mode === "custom"
    ? wireRequest?.method === "input" && draft.trim().length > 0
    : wireRequest?.method === "select" && selected && wireRequest.options.includes(selected)));
  const send = async () => {
    if (!canSend || locked.current || !wireRequest) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const ok = await onAnswer(wireRequest, { value: mode === "custom" ? draft : selected! });
    if (!ok) {
      locked.current = false;
      setBusy(false);
      setError(true);
    }
  };
  const cancel = async () => {
    if (locked.current) return;
    setDraft("");
    setSelected(null);
    setError(false);
    if (!wireRequest) { onDismiss(); return; }
    if (wireRequest.method === "input") {
      setMode("option");
      await prepare("option");
      return;
    }
    locked.current = true;
    setBusy(true);
    if (!await onAnswer(wireRequest, { cancelled: true })) {
      locked.current = false;
      setBusy(false);
      setError(true);
    }
  };
  return <form className="question-workspace-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void send(); }} onKeyDown={event => {
    if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
  }}>
    <div className="question-workspace-body">
      <div className="question-workspace-options">
        {model.options.map((option, index) => {
          const presented = presentQuestionOption(option, index);
          return <label className="question-workspace-option" key={option}>
            <input type="radio" name={name} aria-label={option} data-extension-option data-question-recommended={presented.recommendation ? true : undefined}
              checked={mode === "option" && selected === option} disabled={busy}
              onChange={() => { setMode("option"); setSelected(option); void prepare("option"); }} />
            <span className="question-workspace-option-copy">
              <span className="question-workspace-option-title">{presented.label}{presented.recommendation && <span className="question-workspace-recommendation">{presented.recommendation}</span>}</span>
              {presented.description && <span className="question-workspace-option-description">{presented.description}</span>}
            </span>
          </label>;
        })}
        <div className="question-workspace-custom">
          <label className="question-workspace-custom-label">
            <input type="radio" name={name} aria-label={t("chat.customAnswer")} checked={mode === "custom"} disabled={busy}
              onChange={() => { setMode("custom"); void prepare("custom"); }} />
            <span>{t("chat.customAnswer")}</span>
          </label>
          <input className="question-workspace-input" aria-label={t("chat.customAnswer")} value={draft} readOnly={mode !== "custom" && (busy || !wireRequest)}
            onFocus={() => { if (!locked.current && wireRequest) { setMode("custom"); void prepare("custom"); } }}
            onChange={event => {
              if (mode === "custom") setDraft(event.target.value);
              else if (!locked.current && wireRequest) { setDraft(event.target.value); setMode("custom"); void prepare("custom"); }
            }} />
        </div>
      </div>
      {error && <div className="question-workspace-error" role="alert">{t("chat.answerFailed")}
        {ready && ((mode === "custom" && wireRequest?.method === "select") || (mode === "option" && wireRequest?.method === "input")) &&
          <button className="question-workspace-cancel" type="button" onClick={() => void prepare(mode)}>{t("chat.retryAnswer")}</button>}
      </div>}
    </div>
    <div className="question-workspace-actions">
      <button className="question-workspace-cancel" type="button" disabled={busy} onClick={() => void cancel()}>{t("chat.cancel")}</button>
      <button className="question-workspace-submit" type="submit" disabled={!canSend}>{t("chat.send")}</button>
    </div>
  </form>;
}
