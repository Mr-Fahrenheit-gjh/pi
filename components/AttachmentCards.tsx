"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentReference } from "@/lib/attachment-presentation";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { getFileIcon } from "./FileIcons";
import { FileViewer } from "./FileViewer";
import { useI18n } from "@/hooks/useI18n";

function AttachmentPreview({ file, onClose }: { file: AttachmentReference; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    const stop = listenForStackedDialogEscape(document, onClose);
    return () => { stop(); element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [onClose]);
  return createPortal(<dialog ref={dialog} className="attachment-preview-dialog" aria-label={file.name}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="attachment-preview-content">
      <header><strong>{file.name}</strong><button type="button" aria-label={t("i18n.close")} onClick={onClose}>×</button></header>
      <FileViewer filePath={file.path} cwd={file.path.slice(0, file.path.lastIndexOf("/"))} initialDisplayMode="preview" watchEnabled={false} />
    </div>
  </dialog>, document.body);
}

export function AttachmentCards({ files, onRemove, onOpenFile }: {
  files: AttachmentReference[];
  onRemove?: (file: AttachmentReference) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [preview, setPreview] = useState<AttachmentReference | null>(null);
  const { t } = useI18n();
  return <>
    <div className="attachment-cards">
      {files.map((file) => <div className="attachment-card" key={file.path}>
        <button type="button" className="attachment-card-open" onClick={() => onOpenFile ? onOpenFile(file.path) : setPreview(file)} aria-label={file.name} title={file.name}>
          <span className="attachment-card-icon" aria-hidden="true">{getFileIcon(file.name, 20)}</span>
          <span className="attachment-card-label"><strong>{file.name}</strong><span>{file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "FILE"}</span></span>
        </button>
        {onRemove && <button type="button" className="attachment-card-remove" aria-label={`${t("i18n.remove")} ${file.name}`} onClick={() => onRemove(file)}>×</button>}
      </div>)}
    </div>
    {preview && <AttachmentPreview file={preview} onClose={() => setPreview(null)} />}
  </>;
}
