"use client";

import { useI18n } from "@/hooks/useI18n";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export function contextUsagePercent(usage: ContextUsage): number | null {
  return usage.percent !== null && Number.isFinite(usage.percent)
    ? Math.max(0, Math.min(100, usage.percent)) : null;
}

/** A quiet meter near the composer; exact accounting is available on hover/click. */
export function ContextUsageRing({ usage, onOpen }: { usage: ContextUsage; onOpen?: () => void }) {
  const { t, locale } = useI18n();
  const percent = contextUsagePercent(usage);
  const label = `${t("chat.contextUsage")}: ${percent === null ? "—" : `${Math.round(percent)}%`}`;
  const detail = `${label} · ${usage.tokens === null ? "—" : usage.tokens.toLocaleString(locale)} / ${usage.contextWindow.toLocaleString(locale)} tokens`;
  return (
    <button type="button" className="quiet-action-button context-usage-ring" data-context-ring title={detail} aria-label={label} onClick={onOpen}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="var(--border)" strokeWidth="2" />
        {percent !== null && percent > 0 && <circle cx="10" cy="10" r="7" pathLength="100" stroke="currentColor" strokeWidth="2" strokeDasharray={`${percent} 100`} strokeLinecap="round" transform="rotate(-90 10 10)" />}
      </svg>
    </button>
  );
}
