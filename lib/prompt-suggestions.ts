import type { ExtensionWidgetItem } from "@/lib/types";

export interface PromptSuggestion {
  version: 1;
  id: string;
  sessionId: string;
  text: string;
  acceptTab: boolean;
}

export function getPromptSuggestion(widgets: ExtensionWidgetItem[], sessionId?: string): PromptSuggestion | undefined {
  const widget = widgets.find((item) => item.key === "next-prompt-suggestion");
  if (!sessionId || widget?.lines.length !== 1) return undefined;
  try {
    const data = JSON.parse(widget.lines[0]) as Partial<PromptSuggestion> | null;
    if (!data || data.version !== 1 || typeof data.id !== "string" || !data.id || data.id.length > 128
      || data.sessionId !== sessionId || typeof data.acceptTab !== "boolean"
      || typeof data.text !== "string" || !data.text.trim()
      || data.text.length > 240 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(data.text)) return undefined;
    return { version: 1, id: data.id, sessionId, text: data.text, acceptTab: data.acceptTab };
  } catch {
    return undefined;
  }
}

export function shouldShowPromptSuggestion(state: {
  suggestion?: PromptSuggestion;
  draftKey?: string;
  value: string;
  busy: boolean;
  attachments: number;
  menuOpen: boolean;
  dismissedId?: string;
}): boolean {
  return Boolean(state.suggestion && state.suggestion.sessionId === state.draftKey
    && state.suggestion.id !== state.dismissedId && state.value.length === 0
    && !state.busy && state.attachments === 0 && !state.menuOpen);
}
