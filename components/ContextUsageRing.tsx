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

/** A read-only context meter; it never opens an inspector over the conversation. */
export function ContextUsageRing({ usage }: { usage: ContextUsage }) {
  const { t } = useI18n();
  const percent = contextUsagePercent(usage);
  const label = `${t("chat.contextUsage")}: ${percent === null ? "—" : `${Math.round(percent)}%`}`;
  return (
    <span className="context-usage-ring" data-context-ring role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} title={label} aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="var(--border)" strokeWidth="2" />
        {percent !== null && percent > 0 && <circle cx="10" cy="10" r="7" pathLength="100" stroke="currentColor" strokeWidth="2" strokeDasharray={`${percent} 100`} strokeLinecap="round" transform="rotate(-90 10 10)" />}
      </svg>
    </span>
  );
}
