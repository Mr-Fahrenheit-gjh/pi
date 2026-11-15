export async function complete() {
  globalThis.__memorySummaryCalls = (globalThis.__memorySummaryCalls || 0) + 1;
  return { content: [{ type: 'text', text: '### Decisions\n- SYNTHETIC_SUMMARY' }] };
}
