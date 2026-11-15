// Adapted from agegr/pi-web lib/session-title.ts (MIT). See LICENSE.pi-web.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const TITLE_TIMEOUT_MS = 90_000;
export const TITLE_MAX_TOKENS = 256;
const MAX_TITLE_LENGTH = 80;

// Per-message caps. A title needs what the user asked for (every user turn,
// including mid-session pivots) and what came out of it (the last reply); the
// replies in between only need their opening line. Tool calls and results are
// dropped outright: they dominate the token count and say nothing about intent.
const USER_CHARS = 800;
const ASSISTANT_CHARS = 300;
const LAST_ASSISTANT_CHARS = 600;
const SUMMARY_CHARS = 600;
// Total budget across all messages. Without it the transcript still grows with
// the session, and a long session ends up costing more than replaying a cached
// prefix would have.
const TRANSCRIPT_CHARS = 6000;
// Share of the budget reserved for the opening turns. A session often states
// its goal early and then drifts into routine follow-ups, so spending the whole
// budget on the newest turns can title a session after its last chore.
const TRANSCRIPT_HEAD_CHARS = Math.round(TRANSCRIPT_CHARS * 0.4);

export const TITLE_SYSTEM_PROMPT =
  "You name chat sessions from a transcript. Reply with the title only.";

const ELISION = "[…]";
const IMAGE_PLACEHOLDER = "[image]";

export const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;


function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const type = (block as { type?: string }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    } else if (type === "image") {
      images += 1;
    }
  }
  const text = parts.join("\n").trim();
  if (images === 0) return text;
  const marker = images === 1 ? IMAGE_PLACEHOLDER : `${IMAGE_PLACEHOLDER} ×${images}`;
  return text ? `${text}\n${marker}` : marker;
}

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}…`;
}

/**
 * A title needs the goal the session opened with and the outcome it reached.
 * The middle is what makes a long session expensive, so keep both ends and drop
 * it. Cost and latency then stop tracking session length.
 */
function boundTranscript(lines: string[]): string {
  const joined = lines.join("\n\n");
  if (joined.length <= TRANSCRIPT_CHARS || lines.length < 2) return joined;

  const head: string[] = [];
  let used = ELISION.length + 4;
  let next = 0;
  // The first line always survives, however long the session is.
  for (; next < lines.length; next++) {
    const size = used + lines[next].length + 2;
    if (head.length > 0 && size > TRANSCRIPT_HEAD_CHARS) break;
    head.push(lines[next]);
    used = size;
  }

  const tail: string[] = [];
  for (let i = lines.length - 1; i >= next; i--) {
    const size = used + lines[i].length + 2;
    if (size > TRANSCRIPT_CHARS) break;
    tail.unshift(lines[i]);
    used = size;
  }

  // Everything fit after all: the budget only looked tight because of joins.
  if (next + tail.length >= lines.length) return joined;
  return [...head, ELISION, ...tail].join("\n\n");
}

function lineForMessage(message: AgentMessage, lastAssistant?: AgentMessage): string | undefined {
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    const summary = message.summary.trim();
    if (!summary) return undefined;
    return `[Earlier summary] ${clip(summary, SUMMARY_CHARS)}`;
  }
  if (message.role === "custom") {
    const text = textOf(message.content).trim();
    return text ? `User: ${clip(text, USER_CHARS)}` : undefined;
  }
  if (message.role === "bashExecution") {
    const command = message.command.trim();
    return command ? `User: ${clip(`Ran \`${command}\``, USER_CHARS)}` : undefined;
  }
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = textOf(message.content).trim();
  if (!text) return undefined;
  if (message.role === "user") return `User: ${clip(text, USER_CHARS)}`;
  return `Assistant: ${clip(text, message === lastAssistant ? LAST_ASSISTANT_CHARS : ASSISTANT_CHARS)}`;
}

/** Flatten the session into the plain-text transcript the title model reads. */
export function buildTitleTranscript(messages: AgentMessage[]): string {
  let lastAssistant: AgentMessage | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && textOf(message.content).trim()) lastAssistant = message;
  }

  const lines: string[] = [];
  for (const message of messages) {
    const line = lineForMessage(message, lastAssistant);
    if (line) lines.push(line);
  }
  return boundTranscript(lines);
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

