"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizePreviewUrl } from "@/lib/browser-preview";
export { NativeBrowser as TerminalBrowserView } from "./NativeBrowser";

export function TerminalOpenMenu({ suggestedUrl, onPreview }: { suggestedUrl: string; onPreview: (url: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const addressId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (preview: boolean) => {
    const url = normalizePreviewUrl(address);
    if (!url) { setError(true); return; }
    // Synchronous user activation: no fetch/await before opening an external tab.
    if (preview) onPreview(url);
    else window.open(url, "_blank", "noopener,noreferrer");
    setOpen(false); setError(false);
  };
  return <div className="terminal-open-control" ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector("button")?.focus(); }
  }}>
    <button type="button" className="terminal-open-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => {
      setOpen(!open); setError(false); if (!open) setAddress(suggestedUrl || "");
    }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" /></svg>{t("browser.open")}<span aria-hidden="true">⌄</span></button>
    {open && <div className="terminal-open-menu" role="dialog" aria-label={t("browser.open")}>
      <label htmlFor={addressId}>{t("browser.address")}</label>
      <input id={addressId} autoFocus value={address} type="text" inputMode="url" placeholder="http://localhost:3000" onChange={event => { setAddress(event.target.value); setError(false); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); choose(true); } }} />
      {error && <p role="alert">{t("browser.invalidUrl")}</p>}
      <button type="button" onClick={() => choose(true)}>{t("browser.preview")}<span aria-hidden="true">▣</span></button>
      <button type="button" onClick={() => choose(false)}>{t("browser.external")}<span aria-hidden="true">↗</span></button>
    </div>}
  </div>;
}
