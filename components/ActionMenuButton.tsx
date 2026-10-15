"use client";

import { useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";

/** A quiet entry point for secondary actions; reuse the sidebar's keyboard/focus contract. */
export function ActionMenuButton({ label, items, mobile = false, disabled = false, onOpen, children, className = "" }: {
  label: string;
  items: SidebarMenuItem[];
  mobile?: boolean;
  disabled?: boolean;
  onOpen?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`quiet-action-button ${className}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={() => {
          if (anchor) { setAnchor(null); return; }
          const rect = trigger.current?.getBoundingClientRect();
          if (!rect) return;
          onOpen?.();
          setAnchor({ kind: "rect", rect, align: "end" });
        }}
      >
        {children ?? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>}
      </button>
      <SidebarMenu open={anchor !== null} anchor={anchor} sheet={mobile} ariaLabel={label} title={mobile ? label : undefined} items={items} cancelLabel={t("sidebar.cancel")} onClose={() => setAnchor(null)} returnFocusTo={trigger.current} width={236} />
    </>
  );
}
