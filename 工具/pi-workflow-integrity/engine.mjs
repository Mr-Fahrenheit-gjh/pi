// Pure transformations. Do not change cut points, model settings or structured tool data.
export const OUTPUT_LIMIT = 16000;
const OUTPUT_TOOLS = new Set(['bash', 'codemode', 'grep', 'find', 'ls', 'task_logs']);

export function unifySplitPreparation(preparation) {
  if (!preparation.isSplitTurn || !preparation.turnPrefixMessages?.length) return false;
  // The native two-summary path concatenates historical and prefix states without
  // reconciling them. Feed both spans to its existing iterative summary generator.
  preparation.messagesToSummarize = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  preparation.turnPrefixMessages = [];
  preparation.isSplitTurn = false;
  return true;
}

export function abbreviateToolResult(event, archive) {
  // Nested results are consumed by scripts. Truncating them breaks JSON parsing
  // and programmatic chaining; cap only the final model-facing outer result.
  if (event.parentToolCallId || event.structuredContent !== undefined || !OUTPUT_TOOLS.has(event.toolName)) return;
  const texts = event.content.filter(block => block.type === 'text');
  const size = texts.reduce((total, block) => total + block.text.length, 0);
  if (size <= OUTPUT_LIMIT) return;
  const original = texts.map(block => block.text).join('\n\n');
  const path = archive(original); // If archival fails, caller keeps the original.
  const preview = original.slice(0, 10000) +
    `\n\n[省略 ${original.length - 14000} 字符；未精简的工具返回文本保存在 ${path}。可用 read 分页读取。此预览不是完整 JSON，不要直接解析。]\n\n` +
    original.slice(-4000);
  let inserted = false;
  const content = event.content.flatMap(block => {
    if (block.type !== 'text') return [block];
    if (inserted) return [];
    inserted = true;
    return [{ ...block, text: preview }];
  });
  return { content };
}
