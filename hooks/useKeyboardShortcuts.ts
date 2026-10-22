"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

/**
 * The global Esc shortcut: stops the running agent, unless the key belongs to
 * something else. Typed into a textarea or input, it is that field's (ChatInput
 * has its own Esc logic). Marked handled already (`defaultPrevented`), it was
 * something nearer's: Settings, a menu or a viewer that closed on it. Those
 * listen on `document` or below and run before this one on `window`, and
 * closing them must not stop a run as well. Returns whether it stopped the
 * agent.
 */
export function handleGlobalEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !globalAbortHandler) return false;

  const tag = (event.target as HTMLElement | null)?.tagName;
  // Let textarea/input handle Esc internally (ChatInput menus / stop).
  if (tag === "TEXTAREA" || tag === "INPUT") return false;

  event.preventDefault();
  globalAbortHandler();
  return true;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

export function isQuickActionsShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return false;
  // Ghostty owns Cmd+K; an open dialog and the IME keep their own keys too.
  const target = event.target as Element | null;
  return !target?.closest?.('.terminal-panel, [role="dialog"], dialog');
}

interface UseGlobalKeyboardShortcutsOptions {
  onQuickActions?: () => void;
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component. Nor is an Esc something nearer
 * already handled (see `handleGlobalEscape()`).
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd, onQuickActions } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (isQuickActionsShortcut(e) && onQuickActions) {
        e.preventDefault();
        onQuickActions();
        return;
      }
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        handleGlobalEscape(e);
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession, onQuickActions]);
}
