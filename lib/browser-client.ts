import type { BrowserCommand, BrowserPageState } from "./browser-types";
export async function browserRequest(path: string, options?: RequestInit): Promise<{ state?: BrowserPageState; text?: string }> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => { throw new Error(`Browser request failed (HTTP ${response.status})`); });
  if (!response.ok) throw new Error(data.error || `Browser request failed (HTTP ${response.status})`);
  return data;
}
/** Serial input, bounded move/wheel coalescing, no ambiguous-input replay. */
export function createBrowserWriter(id: string, onError: (e: Error) => void) {
  let pending = Promise.resolve<{ text?: string }>({});
  let generation = 0;
  let stopped = false;
  let buffered: BrowserCommand | null = null;
  const send = (body: BrowserCommand, manual = false): Promise<{ text?: string }> => {
    if (manual) { generation++; stopped = false; buffered = null; }
    if (stopped) return Promise.resolve({});
    if (!manual && buffered?.type === "mouse" && body.type === "mouse" && buffered.event === body.event && ["mouseMoved", "mouseWheel"].includes(body.event)) {
      const dx = Math.max(-5000, Math.min(5000, (buffered.deltaX ?? 0) + (body.deltaX ?? 0)));
      const dy = Math.max(-5000, Math.min(5000, (buffered.deltaY ?? 0) + (body.deltaY ?? 0)));
      Object.assign(buffered, body, { deltaX: dx, deltaY: dy }); return pending;
    }
    buffered = body.type === "mouse" && ["mouseMoved", "mouseWheel"].includes(body.event) ? body : null;
    const mine = generation;
    const result = pending.then(async () => {
      if (mine !== generation || stopped) return {};
      if (buffered === body) buffered = null;
      return browserRequest(`/api/browser/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    });
    pending = result.catch((e: Error) => { if (mine === generation) { stopped = true; generation++; buffered = null; onError(e); } return {}; });
    return pending;
  };
  return { send, stop() { stopped = true; generation++; buffered = null; return pending; } };
}
