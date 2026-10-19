"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { useI18n } from "@/hooks/useI18n";

export function AttachmentDialog({ onClose, onChoose, onFiles }: {
  onClose: () => void;
  onChoose: () => void;
  onFiles: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.focus({ preventScroll: true });
    const stopListening = listenForStackedDialogEscape(document, onClose);
    return () => {
      stopListening();
      dialog?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <dialog ref={dialogRef} className="attachment-dialog" aria-labelledby="attachment-dialog-title" tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons?.[0], last = buttons?.[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault(); first?.focus();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="attachment-dialog-content">
        <header className="attachment-dialog-header">
          <h2 id="attachment-dialog-title">{t("chat.uploadTitle")}</h2>
          <button type="button" className="attachment-dialog-close" aria-label={t("chat.closeUpload")} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="attachment-dropzone" data-dragging={dragging || undefined}
          onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current++; setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}
          onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
          onDrop={(event) => {
            event.preventDefault(); event.stopPropagation();
            dragDepth.current = 0; setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length) { onFiles(files); onClose(); }
          }}>
          <strong>{t("chat.dropFilesHere")}</strong>
          <p>{t("chat.uploadFileTypes")}</p>
          <button type="button" className="attachment-choose" onClick={onChoose}>{t("chat.chooseFiles")}</button>
          <small>{t("chat.uploadLimits")}</small>
        </div>
      </div>
    </dialog>, document.body,
  );
}
