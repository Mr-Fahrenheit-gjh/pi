"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

type Availability = { supported: boolean; platform: string };

/** Reveal the original local file, not a copy in the browser's downloads. */
export function RevealFileButton({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const currentPath = useRef(filePath);
  currentPath.current = filePath;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/open-in-explorer", { signal: controller.signal })
      .then((res) => res.ok ? res.json() as Promise<Availability> : null)
      .then((data) => { if (!controller.signal.aborted) setAvailability(data); })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => { setError(false); }, [filePath]);

  if (!availability?.supported) return null;
  const label = t(availability.platform === "darwin" ? "files.revealInFinder" : "files.revealInFileManager");

  async function reveal() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const target = filePath;
    try {
      const response = await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: target, reveal: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      if (currentPath.current === target) setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="file-viewer-icon-button file-reveal-button" title={label} aria-label={label} disabled={busy} onClick={reveal}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 4H3v16h18v-7M3 8h8M14 3h7v7M21 3l-9 9" />
        </svg>
        {availability.platform === "darwin" && <span>Finder</span>}
      </button>
      {error && <span role="alert" className="file-reveal-error">{t("files.revealFailed")}</span>}
    </>
  );
}
