import { parseReleaseSnapshot } from "./pending-release-shared.mjs";

// One owner per mounted hook. Sequence checks also reject transports ignoring abort.
export function createReleaseLoader(onChange, request = fetch, timeoutMs = 10000) {
  let sequence = 0, active = null, disposed = false, snapshot = null;
  return {
    async refresh() {
      if (disposed) return;
      const current = ++sequence;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      onChange({ snapshot, loading: true, error: null });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request("/api/pending-releases", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("HTTP failure");
        const value = await response.json();
        if (value?.error) throw new Error("Business failure");
        const next = parseReleaseSnapshot(value);
        if (disposed || current !== sequence) return;
        if (controller.signal.aborted) throw new Error("Request timed out");
        snapshot = next;
        onChange({ snapshot, loading: false, error: null });
      } catch {
        if (disposed || current !== sequence) return;
        snapshot = null;
        onChange({ snapshot: null, loading: false, error: "待上线清单不可用，请重试。" });
      } finally {
        clearTimeout(timeout);
        if (active === controller) active = null;
      }
    },
    dispose() { disposed = true; sequence++; active?.abort(); },
  };
}
