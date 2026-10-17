"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createReleaseLoader, type ReleaseLoader, type ReleaseLoadState } from "@/lib/pending-release-client.mjs";

export function usePendingReleases(open: boolean) {
  const [state, setState] = useState<ReleaseLoadState>({ snapshot: null, loading: true, error: null });
  const loader = useRef<ReleaseLoader | null>(null);
  const refresh = useCallback(() => { void loader.current?.refresh(); }, []);

  useEffect(() => {
    const current = createReleaseLoader(setState);
    loader.current = current;
    void current.refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void current.refresh(); };
    const onFocus = () => { void current.refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      current.dispose();
      loader.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  return { ...state, refresh };
}
