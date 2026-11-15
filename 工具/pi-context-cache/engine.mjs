// Request-local archival of old bulky tool data. No user/assistant prose removal.
export const DEFAULTS = { triggerChars: 240000, keepAssistantTurns: 12, largeChars: 1536, edgeChars: 160 };
const ALLOWED = new Set(['read', 'bash', 'write', 'edit', 'codemode', 'grep', 'find', 'ls', 'web_search', 'fetch_content', 'get_search_content', 'memory_read', 'memory_search', 'memory_write']);

export function visibleSize(messages) {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') chars += message.content.length;
    else for (const block of message.content ?? []) {
      if (block.type === 'text') chars += block.text.length;
      if (block.type === 'toolCall') chars += JSON.stringify(block.arguments ?? {}).length;
    }
  }
  return chars;
}

export function slimContext(messages, archive, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const beforeChars = visibleSize(messages);
  const unchanged = { messages, stats: { beforeChars, afterChars: beforeChars, archived: 0 } };
  if (beforeChars < config.triggerChars) return unchanged;
  let lastUser = -1;
  const assistantIndices = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
    if (m.role === 'assistant') assistantIndices.push(i);
  });
  if (lastUser < 0) return unchanged;
  const recent = assistantIndices.length > config.keepAssistantTurns
    ? assistantIndices[assistantIndices.length - config.keepAssistantTurns] : 0;
  const cutoff = Math.min(lastUser, recent);
  const completed = new Set(messages.filter(m => m.role === 'toolResult' && !m.isError).map(m => m.toolCallId));
  let archived = 0;
  let oldThinkingBlocks = 0;
  function shorten(text) {
    if (typeof text !== 'string' || text.length <= config.largeChars) return text;
    const file = archive(text);
    if (!file) throw new Error('Archive unavailable');
    archived++;
    return text.slice(0, config.edgeChars) +
      `\n[Earlier tool data shortened, not full executable code. Read original (${text.length} chars): ${file}]\n` +
      text.slice(-config.edgeChars);
  }
  function args(value) {
    if (typeof value === 'string') return shorten(value);
    if (Array.isArray(value)) return value.map(args);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, args(v)]));
    return value;
  }
  const result = messages.map((message, i) => {
    if (i >= cutoff) return message;
    if (message.role === 'toolResult' && !message.isError && ALLOWED.has(message.toolName)) {
      return { ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: shorten(block.text) } : block) };
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      // Old completed reasoning state is not needed to replay finished tool actions.
      // Retain every visible conclusion and all reasoning in the current/recent span.
      const content = message.content.filter(block => {
        if (block.type === 'thinking' && !['error', 'aborted'].includes(message.stopReason)) {
          oldThinkingBlocks++;
          return false;
        }
        return true;
      }).map(block => block.type === 'toolCall' && ALLOWED.has(block.name) && completed.has(block.id)
        ? { ...block, arguments: args(block.arguments) } : block);
      return { ...message, content: content.length ? content : [{ type: 'text', text: '[Earlier internal analysis omitted from this request; original session retained.]' }] };
    }
    return message;
  });
  return { messages: result, stats: { beforeChars, afterChars: visibleSize(result), archived, oldThinkingBlocks } };
}
