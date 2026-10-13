export function normalizePreviewUrl(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 4096 || /[\u0000-\u0020\u007f]/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) && !/^(?:localhost|[^/:]+\.[^/:]+):\d+(?:[/?#]|$)/i.test(text) ? text : `http://${text}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function previewUrlsFromOutput(output: string): string[] {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return [...new Set((plain.match(/https?:\/\/[^\s<>"'\x1b]+/g) ?? []).map(value => normalizePreviewUrl(value.replace(/[),.;]+$/, ""))).filter((value): value is string => value !== null))].slice(-8).reverse();
}
