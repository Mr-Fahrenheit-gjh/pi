import type { AssistantContentBlock, AssistantMessage } from "./types";
import { getAssistantErrorMessage, isAssistantTruncated, splitAssistantVisibleBlocks } from "./message-display";
import type { WrittenFile } from "./turn-written-files";

/** What the chat shows of a turn's final assistant message, apart. */
export interface FinalAnswerViews {
  /** The answer under the process group; null when the turn has none. */
  answer: AssistantMessage | null;
  /** What the message did before its answer, inside the process group. */
  process: AssistantMessage;
  /** Includes an error-only process, even when there are no content blocks. */
  hasProcess: boolean;
  writtenFiles?: WrittenFile[];
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

/**
 * Splits a turn's final assistant message into its answer and its process part.
 * MessageView is memoized, and copies built afresh on each render defeat it: every
 * visible answer then runs its markdown again whenever anything in the chat changes,
 * be it a streamed chunk, a notice or a key typed into an extension's custom panel
 * (#1005). So the copies are kept per stored message, which is never mutated.
 */
export function getFinalAnswerViews(
  cache: WeakMap<AssistantMessage, FinalAnswerViews>,
  message: AssistantMessage,
): FinalAnswerViews {
  const cached = cache.get(message);
  if (cached) return cached;

  const { answerBlocks, hasProcess } = splitAssistantVisibleBlocks(message);
  const answer = answerBlocks.length > 0 || getAssistantErrorMessage(message) || isAssistantTruncated(message)
    ? withAssistantBlocks(message, answerBlocks)
    : null;
  const views: FinalAnswerViews = {
    answer,
    hasProcess,
    // MessageView filters by assistantContent AFTER associating original indices.
    // Retaining the full content avoids shifting thinking indices after progress prose.
    process: withAssistantBlocks(
      message,
      message.content,
      { omitUsage: Boolean(answer) },
    ),
  };
  cache.set(message, views);
  return views;
}

/** The list passed last time while the turn still wrote the same files, for the same reason. */
export function keepWrittenFiles(views: FinalAnswerViews, next: WrittenFile[]): WrittenFile[] {
  const previous = views.writtenFiles;
  if (
    previous
    && previous.length === next.length
    && previous.every((file, index) => file.filePath === next[index].filePath)
  ) return previous;
  views.writtenFiles = next;
  return next;
}
