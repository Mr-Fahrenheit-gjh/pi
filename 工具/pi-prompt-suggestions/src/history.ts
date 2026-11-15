import type { AgentEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

type Message = AgentEndEvent["messages"][number];

interface Turn {
  messages: Message[];
  completed: boolean;
}

/**
 * Returns the messages of the latest completed turns, including the tool calls
 * and tool results made inside each turn. A turn counts as completed only when
 * its final assistant message stopped normally and carried text.
 */
export function recentCompletedTurns(entries: readonly SessionEntry[], limit = 4): AgentEndEvent["messages"] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      current = { messages: [message], completed: false };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant") {
      current.messages.push(message);
      const finished = message.stopReason === "stop" || message.stopReason === "length";
      const hasText = message.content.some(part => part.type === "text" && part.text.trim());
      current.completed = finished && hasText;
    } else if (message.role === "toolResult") {
      current.messages.push(message);
      // A tool result means more assistant work follows before the turn is done.
      current.completed = false;
    }
  }
  if (!turns.length || !turns.at(-1)!.completed) return [];
  return turns.filter(turn => turn.completed).slice(-limit).flatMap(turn => turn.messages);
}
