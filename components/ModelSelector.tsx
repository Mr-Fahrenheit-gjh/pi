"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SelectorRow } from "./SelectorRow";
import { ProviderIcon } from "./ProviderIcon";
import { modelManufacturerIcon } from "@/lib/model-manufacturer";
import type { FastMode, FastModeState } from "@/lib/fast-mode";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
}

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  isAutoSelection?: boolean;
  /** The session's OpenAI / Codex fast mode is enabled. */
  fastMode?: boolean;
  fastModeState?: FastModeState | null;
  fastModeBusy?: boolean;
  onFastModeOpen?: () => void;
  onFastModeChange?: (mode: FastMode) => void;
  /** Lock model/default selection without locking the Fast control. */
  modelSelectionDisabled?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
  /** The model new sessions start with; its row gets a filled star. */
  defaultValue?: { provider: string; modelId: string } | null;
  /** Shows a star on every row that saves it as the default. */
  onSetDefault?: (provider: string, modelId: string) => void;
  /** Every available model, once loaded; listed under "all". */
  allOptions?: ModelSelectorOption[] | null;
  /** Set only while `enabledModels` narrows `options`: shows pi's `/model` "scoped | all" row and loads `allOptions`. */
  onShowAll?: () => void;
}

const MODEL_FILTER_THRESHOLD = 8;

export function filterModelOptions(options: ModelSelectorOption[], query: string): ModelSelectorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

export function ModelSelector({
  options,
  value,
  onChange,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  isAutoSelection = false,
  fastMode = false,
  fastModeState,
  fastModeBusy = false,
  onFastModeOpen,
  onFastModeChange,
  modelSelectionDisabled = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
  defaultValue,
  onSetDefault,
  allOptions,
  onShowAll,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState("");
  // pi's /model starts on the scope; Tab on the filter or a tap switches.
  const [showAll, setShowAll] = useState(false);
  const showFastControl = Boolean(onFastModeChange && value && /^gpt-/i.test(value.modelId)
    && (value.provider === "openai" || value.provider === "openai-codex"));
  const locked = disabled || busy || (modelSelectionDisabled && !showFastControl);
  const fastUnavailable = !fastModeState?.available || !fastModeState.supported;
  const listed = showAll ? allOptions : options;
  // Options arrive in pi's /model order (orderSelectorModels()); never re-sort
  // them, or a models.json provider loses the order its file gives (#783).
  const filteredOptions = filterModelOptions(listed ?? [], filter);
  const showFilter = Boolean(onShowAll) || options.length > MODEL_FILTER_THRESHOLD;
  const isListed = (list: ModelSelectorOption[] | null | undefined, ref: { provider: string; modelId: string }) => (
    list?.find((option) => option.modelId === ref.modelId && option.provider === ref.provider)
  );
  const switchScope = () => {
    if (!showAll) onShowAll?.();
    setShowAll(!showAll);
  };
  const modelsByProvider: { provider: string; options: ModelSelectorOption[] }[] = [];

  for (const option of filteredOptions) {
    const group = modelsByProvider.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else modelsByProvider.push({ provider: option.provider, options: [option] });
  }

  const currentName = selectedLabel ?? (value
    ? (isListed(options, value) ?? isListed(allOptions, value))?.name ?? value.modelId
    : emptyLabel ?? (options.length > 0 ? "Select model" : "No models"));

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        rootRef.current && !rootRef.current.contains(event.target as Node)
        && panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  const buttonStyle: CSSProperties = variant === "field"
    ? {
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        minWidth: 0,
        height: 34,
        padding: "0 9px",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: locked ? "var(--bg-panel)" : "var(--bg)",
        color: locked ? "var(--text-dim)" : "var(--text)",
        cursor: locked ? "default" : "default",
        fontSize: 12,
        textAlign: "left",
      }
    : {
        display: "flex",
        alignItems: "center",
        justifyContent: isMobile ? "flex-start" : undefined,
        gap: 6,
        width: isMobile ? "100%" : undefined,
        maxWidth: isMobile ? "100%" : 220,
        height: 32,
        padding: isMobile ? "8px 10px" : "8px 12px",
        overflow: "hidden",
        border: "none",
        borderRadius: 9,
        background: open ? "var(--bg-hover)" : "none",
        color: "var(--text-muted)",
        cursor: locked ? "not-allowed" : "default",
        fontSize: 12,
        opacity: locked ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
      };

  const choose = (option: ModelSelectorOption) => {
    if (modelSelectionDisabled) return;
    const active = option.modelId === value?.modelId && option.provider === value?.provider;
    setOpen(false);
    setFilter("");
    if (!active || isAutoSelection) onChange(option.provider, option.modelId);
  };

  const saveDefault = (option: ModelSelectorOption) => {
    if (modelSelectionDisabled) return;
    setOpen(false);
    setFilter("");
    onSetDefault?.(option.provider, option.modelId);
  };

  return (
    <div
      ref={rootRef}
      className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`}
      style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, minWidth: 0, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup={showFastControl ? "dialog" : "listbox"}
        data-model-selector-trigger
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={locked}
        title={busy ? "Switching model" : locked ? currentName : options.length > 0 || onClear ? "Change model" : "No available models"}
        style={buttonStyle}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
          if (!open && showFastControl) onFastModeOpen?.();
          setOpen((current) => {
            if (current) setFilter("");
            else setShowAll(false);
            return !current;
          });
        }}
        onMouseEnter={(event) => {
          if (locked) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          if (locked) {
            event.currentTarget.style.background = variant === "field" ? "var(--bg-panel)" : "none";
            event.currentTarget.style.color = variant === "field" ? "var(--text-dim)" : "var(--text-muted)";
            return;
          }
          event.currentTarget.style.background = open ? "var(--bg-hover)" : variant === "field" ? "var(--bg)" : "none";
          event.currentTarget.style.color = variant === "field" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {busy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          </svg>
        ) : value ? (
          <ProviderIcon id={modelManufacturerIcon(value.provider, value.modelId)} size={14} />
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
        {(fastMode || fastModeState?.mode === "fast") && value && (value.provider === "openai" || value.provider === "openai-codex") && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Fast mode" data-model-fast-indicator style={{ flexShrink: 0 }}>
            <title>Fast mode</title>
            <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z" />
          </svg>
        )}
        {variant === "field" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && anchorRect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const spaceAbove = anchorRect.top - 8;
        const spaceBelow = viewportHeight - anchorRect.bottom - 8;
        const openAbove = placement === "up" || spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(openAbove ? spaceAbove : spaceBelow, viewportHeight * 0.6));
        const verticalPosition = openAbove
          ? { bottom: viewportHeight - anchorRect.top + 6 }
          : { top: anchorRect.bottom + 6 };
        const horizontalPosition: CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
          : { left: anchorRect.left, width: "max-content", minWidth: anchorRect.width, maxWidth: Math.max(anchorRect.width, viewportWidth - anchorRect.left - 8) };

        return (
          <div
            ref={panelRef}
            role={showFastControl ? "dialog" : undefined}
            aria-label={ariaLabel ?? (showFastControl ? t("chat.modelAndSpeed") : undefined)}
            data-model-selector-menu
            style={{
              position: "fixed",
              ...verticalPosition,
              ...horizontalPosition,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              maxHeight,
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
            }}
          >
            {showFastControl && (
              <div style={{ flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid var(--border)", maxWidth: 320 }}>
                <button type="button" role="switch" aria-label={t("chat.fastMode")}
                  aria-checked={fastModeState?.mode === "fast"}
                  disabled={fastModeBusy || fastUnavailable}
                  onClick={() => onFastModeChange?.(fastModeState?.mode === "fast" ? "standard" : "fast")}
                  style={{ display: "flex", alignItems: "center", gap: 20, justifyContent: "space-between", width: "100%", padding: 0, border: "none", background: "none", color: "var(--text)", fontSize: 12, opacity: fastModeBusy || fastUnavailable ? 0.5 : 1 }}>
                  <span>Fast</span>
                  <span aria-hidden="true" style={{ display: "flex", alignItems: "center", width: 28, height: 16, padding: 2, borderRadius: 10, background: fastModeState?.mode === "fast" ? "var(--accent)" : "var(--border)", justifyContent: fastModeState?.mode === "fast" ? "flex-end" : "flex-start" }}>
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--bg)" }} />
                  </span>
                </button>
                <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", whiteSpace: "normal" }}>
                  {fastModeBusy ? t("chat.fastLoading") : fastUnavailable ? t("chat.fastUnavailable") : t("chat.fastHint")}
                </div>
                {fastModeState?.mode === "auto" ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>{t("chat.fastAuto")}</div>
                ) : (
                  <button type="button" disabled={fastModeBusy || fastUnavailable} onClick={() => {
                    // This row disappears after reset; keep Escape within the selector.
                    rootRef.current?.querySelector<HTMLButtonElement>("[data-model-selector-trigger]")?.focus();
                    onFastModeChange?.("auto");
                  }}
                    style={{ marginTop: 4, padding: 0, border: "none", background: "none", color: "var(--text-muted)", fontSize: 11 }}>{t("chat.fastReset")}</button>
                )}
              </div>
            )}
            {onShowAll && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px 0", fontSize: 11 }}>
                {[false, true].map((all) => (
                  <button
                    key={String(all)}
                    type="button"
                    aria-pressed={showAll === all}
                    onClick={() => { if (showAll !== all) switchScope(); }}
                    style={{
                      padding: "2px 7px",
                      border: "1px solid",
                      borderColor: showAll === all ? "var(--border)" : "transparent",
                      borderRadius: 4,
                      background: showAll === all ? "var(--bg-hover)" : "none",
                      color: showAll === all ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {t(all ? "chat.modelScopeAll" : "chat.modelScopeScoped")}
                  </button>
                ))}
                {!isMobile && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>Tab</span>}
              </div>
            )}
            {showFilter && (
              <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (!onShowAll || event.key !== "Tab") return;
                    event.preventDefault();
                    switchScope();
                  }}
                  placeholder={t("chat.filterModels")}
                  aria-label={t("chat.filterModels")}
                  // On phones, focusing the filter opens the on-screen keyboard,
                  // which shrinks the viewport and pushes the list off-screen
                  // before the user has decided to filter. Tap to filter instead.
                  autoFocus={!isMobile}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    minWidth: isMobile ? 0 : 220,
                    padding: "5px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                />
              </div>
            )}
            <fieldset role="listbox" aria-label={ariaLabel} disabled={modelSelectionDisabled}
              style={{ minHeight: 0, minWidth: 0, margin: 0, padding: 0, border: "none", overflowY: "auto", opacity: modelSelectionDisabled ? 0.5 : 1 }}>
              {onClear && !filter.trim() && (
                <SelectorRow active={!value} gutter={Boolean(onSetDefault)} onSelect={() => {
                  setOpen(false);
                  setFilter("");
                  onClear();
                }}>
                  <OptionLabel label={emptyLabel ?? "Default"} />
                </SelectorRow>
              )}
              {modelsByProvider.length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {!listed ? t("agents.modelsLoading") : filter.trim() ? t("chat.noMatchingModels") : t("chat.noAvailableModels")}
                </div>
              ) : modelsByProvider.map((group, index) => (
                <div key={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div style={{ padding: "6px 12px 4px", borderTop: index > 0 || onClear ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase" }}>
                      {group.provider}
                    </div>
                  )}
                  {group.options.map((option) => {
                    return (
                      <SelectorRow
                        key={`${option.provider}:${option.modelId}`}
                        active={option.modelId === value?.modelId && option.provider === value?.provider}
                        onSelect={() => choose(option)}
                        // The default is saved only from the scope: PUT /api/models/default refuses others.
                        star={onSetDefault && (!showAll || isListed(options, option)) ? {
                          isDefault: option.modelId === defaultValue?.modelId && option.provider === defaultValue?.provider,
                          saveLabel: t("chat.saveDefaultModel"),
                          defaultLabel: t("chat.defaultModel"),
                          onSave: () => saveDefault(option),
                        } : undefined}
                      >
                        <OptionLabel label={option.name} />
                      </SelectorRow>
                    );
                  })}
                </div>
              ))}
            </fieldset>
          </div>
        );
      })()}
    </div>
  );
}

function OptionLabel({ label }: { label: string }) {
  return <span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>;
}
