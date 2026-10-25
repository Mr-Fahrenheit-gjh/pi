"use client";
import { useCallback, useRef, useState, type SetStateAction } from "react";
import {
  mergeComposerAttachments, serializeComposerAttachments, splitComposerAttachments,
  type AttachmentReference,
} from "@/lib/attachment-presentation";

/** Only prose is editable. Files remain independent, including an attachment-only draft. */
export function useAttachmentText(initialText: () => string) {
  const [draft, update] = useState(() => splitComposerAttachments(initialText()));
  const current = useRef(draft);
  const replace = useCallback((next: typeof draft) => {
    current.current = next;
    update(next);
  }, []);
  // Programmatic restore/switch/clear replaces the whole canonical draft.
  const setValue = useCallback((action: SetStateAction<string>) => {
    const previous = current.current;
    const raw = typeof action === "function" ? action(serializeComposerAttachments(previous.text, previous.files)) : action;
    replace(splitComposerAttachments(raw));
  }, [replace]);
  // Native typing, undo and completion change prose, never silently discard files.
  const setText = useCallback((text: string) => {
    const incoming = splitComposerAttachments(text);
    replace({ text: incoming.text, files: mergeComposerAttachments(current.current.files, incoming.files) });
  }, [replace]);
  const addFiles = useCallback((files: AttachmentReference[]) => {
    replace({ ...current.current, files: mergeComposerAttachments(current.current.files, files) });
  }, [replace]);
  const removeFile = useCallback((file: AttachmentReference) => {
    replace({ ...current.current, files: current.current.files.filter((entry) => entry.path !== file.path) });
  }, [replace]);
  const expand = useCallback((text: string) => {
    const incoming = splitComposerAttachments(text);
    return serializeComposerAttachments(incoming.text, mergeComposerAttachments(current.current.files, incoming.files));
  }, []);
  return { value: draft.text, setValue, setText, files: draft.files, addFiles, removeFile, expand };
}
