import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
  assistantContent?: "answer" | "process";
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/**
 * pi's TUI renders a custom message only when `display` is set; `display: false`
 * is how an extension keeps a message for the model alone. The chat skips it too.
 */
export function isHiddenCustomMessage(message: { role?: AgentMessage["role"]; display?: boolean }): boolean {
  return message.role === "custom" && !message.display;
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string; display?: boolean }): boolean {
  // A background subagent completion starts a new displayed turn, same as a
  // user message or compaction summary: pi-web's own, and @tintinweb/pi-subagents'
  // (a follow-up that triggers a turn). Other custom messages stay inside the turn.
  return message.role === "user"
    || (message.role === "custom" && !isHiddenCustomMessage(message) && (
      message.customType === "compaction"
      || message.customType === "pi-web:subagent-notification"
      || message.customType === "subagent-notification"
    ));
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error" || isAbortErrorMessage(message.errorMessage)) return null;
  const error = message.errorMessage?.trim() || "Unknown provider error";
  // Only this exact transient model-network failure belongs in the process.
  // Do not fold authorization, rate-limit, or other provider failures.
  const processError = error.toLowerCase() === "fetch failed";
  return processError === (options.assistantContent === "process") ? error : null;
}

const ABORT_ERROR_MESSAGES = new Set([
  "aborted",
  "aborterror",
  "operation aborted",
  "request was aborted",
  "the operation was aborted",
  "this operation was aborted",
]);

/** A user-initiated stop, not a provider failure that deserves a red banner. */
export function isAbortErrorMessage(error: string | null | undefined): boolean {
  const text = (error ?? "").trim().toLowerCase().replace(/^error:\s*/, "");
  return ABORT_ERROR_MESSAGES.has(text);
}

/** Stop/Esc or an aborted model call: acknowledge it instead of reporting an error. */
export function isAssistantInterrupted(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  if (options.isStreaming) return false;
  return message.stopReason === "aborted"
    || (message.stopReason === "error" && isAbortErrorMessage(message.errorMessage));
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

/** Text, an image, or a tool call is an answer. Thinking alone is not. */
export function hasAssistantAnswer(message: AssistantMessage): boolean {
  return (message.content ?? []).some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return block.type === "image" || block.type === "toolCall";
  });
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

/** Progress prose is a normal message, even when followed by a tool call. */
export function splitAssistantVisibleBlocks(message: AssistantMessage, options: DisplayOptions = {}) {
  const blocks = getDisplayableAssistantBlocks(message, options);
  return {
    answerBlocks: blocks.filter(isFinalAnswerBlock),
    processBlocks: blocks.filter((block) => !isFinalAnswerBlock(block)),
    hasProcess: blocks.some((block) => !isFinalAnswerBlock(block))
      || Boolean(getAssistantErrorMessage(message, { ...options, assistantContent: "process" })),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * Process details start collapsed only above a real answer: text or an image in
 * the answer the turn shows (null when it shows none). Under an error or
 * truncation notice alone they stay open, since text the turn wrote before its
 * last tool call sits in them and would be hidden (#906).
 */
export function collapsesProcessDetails(answer: AssistantMessage | null): boolean {
  return (answer?.content ?? []).some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}
