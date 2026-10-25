"use client";
import { useCallback, useRef, useState, type SetStateAction } from "react";
import { AttachmentPresentation } from "@/lib/attachment-presentation";

/** Drafts and requests retain canonical @paths; only the editor uses tokens. */
export function useAttachmentText(initialText: () => string) {
  const registry = useRef<AttachmentPresentation | null>(null);
  if (!registry.current) registry.current = new AttachmentPresentation();
  const presentation = registry.current;
  const [value, update] = useState(() => presentation.compact(initialText()));
  const setValue = useCallback((action: SetStateAction<string>) => {
    update((previous) => presentation.compact(typeof action === "function" ? action(previous) : action));
  }, [presentation]);
  const expand = useCallback((text: string) => presentation.expand(text), [presentation]);
  return { value, setValue, files: presentation.files(value), expand };
}
