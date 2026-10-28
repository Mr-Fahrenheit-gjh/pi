"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "ghostty-web";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_GHOSTTY_FONT } from "@/lib/ghostty-font-config";
import { loadGhosttyFontPreferences, loadGhosttyTerminal, terminalKeyAction, TERMINAL_THEME } from "@/lib/ghostty-terminal";
import { readTerminalTheme } from "@/lib/terminal-theme";
import { wheelLines, mouseWheelSequence } from "@/lib/terminal-wheel";
import { createTerminalWriter, terminalRequest } from "@/lib/terminal-client";
import { runtimeApi } from "@/lib/runtime-client.mjs";
import {
  applyTerminalModifiers,
  NO_TERMINAL_MODIFIERS,
  terminalExtraKeySequence,
  type TerminalExtraKey,
  type TerminalModifier,
  type TerminalModifiers,
} from "@/lib/terminal-extra-keys";
import type { TerminalEvent } from "@/lib/terminal-manager";
import { TerminalExtraKeys, useTerminalExtraKeysVisible } from "./TerminalExtraKeys";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
}

export function TerminalPanel({ tab, active, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const shellRef = useRef({ id, created: Boolean(restored) });
  if (shellRef.current.id !== id) shellRef.current = { id, created: Boolean(restored) };
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const activeRef = useRef(active);
  activeRef.current = active;
  const closingRef = useRef(tab.closing);
  closingRef.current = tab.closing;
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [fontSize, setFontSize] = useState(DEFAULT_GHOSTTY_FONT.fontSize);
  const [fontFamily, setFontFamily] = useState(DEFAULT_GHOSTTY_FONT.fontFamily);
  const fontPreferencesRef = useRef(DEFAULT_GHOSTTY_FONT);
  const fontSizeAdjustedRef = useRef(false);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const [modifiers, setModifiers] = useState<TerminalModifiers>(NO_TERMINAL_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const showExtraKeys = useTerminalExtraKeysVisible();

  const consumeModifiers = useCallback(() => {
    const current = modifiersRef.current;
    if (current.ctrl || current.alt) {
      modifiersRef.current = NO_TERMINAL_MODIFIERS;
      setModifiers(NO_TERMINAL_MODIFIERS);
    }
    return current;
  }, []);
  const sendExtraKey = (key: TerminalExtraKey) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.input(terminalExtraKeySequence(key, consumeModifiers(), terminal.getMode(1)), true);
  };
  const toggleModifier = (modifier: TerminalModifier) => {
    const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] };
    modifiersRef.current = next;
    setModifiers(next);
  };
  const copySelection = useCallback(async () => {
    const text = terminalRef.current?.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setActionError(null);
    } catch {
      setActionError(t("terminal.clipboardError"));
    }
  }, [t]);
  const copyRef = useRef(copySelection);
  copyRef.current = copySelection;


  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const fontController = new AbortController();
    let fontRequest = 0;
    let cleanup = () => {};
    setStatus("connecting");
    setError(null);
    setActionError(null);
    setExitCode(null);

    startRef.current = (async () => {
      const [{ module: { Terminal, FitAddon }, ghostty }, preferences] = await Promise.all([
        loadGhosttyTerminal(), loadGhosttyFontPreferences(fontController.signal),
      ]);
      if (disposed || closingRef.current) return;
      fontPreferencesRef.current = preferences;
      setFontFamily(preferences.fontFamily);
      if (!fontSizeAdjustedRef.current) {
        fontSizeRef.current = preferences.fontSize;
        setFontSize(preferences.fontSize);
      }
      const readFont = () => fontPreferencesRef.current.fontFamily;
      const terminal = new Terminal({
        ghostty,
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: readFont(),
        fontSize: fontSizeRef.current,
        scrollback: 8000,
        disableStdin: true,
        theme: TERMINAL_THEME,
      });
      terminalRef.current = terminal;
      // A fresh host also removes listeners installed by Ghostty on reconnect.
      const host = document.createElement("div");
      host.className = "terminal-ghostty-surface";
      container.replaceChildren(host);
      cleanup = () => { terminal.dispose(); host.remove(); terminalRef.current = null; };
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      let previousTheme = "";
      const updateTheme = () => {
        if (disposed) return;
        const theme = readTerminalTheme(document.documentElement);
        const signature = JSON.stringify(theme);
        if (signature === previousTheme) return;
        terminal.options.theme = theme;
        previousTheme = signature;
      };
      updateTheme();
      const themeObserver = new MutationObserver(updateTheme);
      if (!activeRef.current || !container.offsetWidth) terminal.blur();
      terminal.attachCustomKeyEventHandler((event) => {
        const action = terminalKeyAction(event, terminal.hasSelection());
        if (action === "copy") void copyRef.current();
        if (action === "clear") terminal.clear();
        if (action === "selectAll") terminal.selectAll();
        // Ghostty 0.4 returns TRUE for handled keys (the inverse of xterm).
        return action !== null;
      });

      let wheelRemainder = 0;
      terminal.attachCustomWheelEventHandler((event) => {
        const tracking = terminal.getMode(1000) || terminal.getMode(1002) || terminal.getMode(1003);
        if (!tracking) {
          wheelRemainder = 0;
          // Ghostty 0.4 turns alternate-screen wheels into Up/Down. Never let
          // that edit the prompt/history; normal-screen scrollback stays native.
          return terminal.buffer.active.type === "alternate";
        }
        const canvas = host.querySelector("canvas");
        const box = canvas?.getBoundingClientRect();
        if (!box?.width || !box.height || terminal.options.disableStdin || event.ctrlKey) return true;
        const { lines, remainder } = wheelLines(event, box.height / terminal.rows, terminal.rows, wheelRemainder);
        wheelRemainder = remainder;
        const col = Math.max(1, Math.min(terminal.cols, Math.floor((event.clientX - box.left) / (box.width / terminal.cols)) + 1));
        const row = Math.max(1, Math.min(terminal.rows, Math.floor((event.clientY - box.top) / (box.height / terminal.rows)) + 1));
        for (let index = 0; index < Math.abs(lines); index++) {
          terminal.input(mouseWheelSequence(lines, col, row, terminal.getMode(1006), event), true);
        }
        return true;
      });

      let events: EventSource | null = null;
      let offset: number | undefined;
      let connected = false;
      let exited = false;
      let inputFailed = false;
      const writer = createTerminalWriter(id, (reason) => {
        if (disposed) return;
        inputFailed = true;
        terminal.options.disableStdin = true;
        setError(reason.message);
        setStatus("error");
      });
      writerRef.current = writer;
      const onData = terminal.onData((data) => {
        if (connected && !exited && !inputFailed && !closingRef.current) writer.write(applyTerminalModifiers(data, consumeModifiers()));
      });
      const fitAndResize = () => {
        if (!disposed && container.offsetWidth && container.offsetHeight) fit.fit();
      };
      refitRef.current = fitAndResize;
      const onResize = terminal.onResize(({ cols, rows }) => {
        if (connected && !exited && !inputFailed) writer.resize(Math.max(2, cols), Math.max(2, rows));
      });
      const resizeObserver = new ResizeObserver(fitAndResize);
      resizeObserver.observe(container);
      const updateFont = () => {
        if (disposed) return;
        terminal.options.fontFamily = readFont();
        fitAndResize();
      };
      const refreshFontPreferences = async () => {
        const request = ++fontRequest;
        const next = await loadGhosttyFontPreferences(fontController.signal);
        if (disposed || request !== fontRequest) return;
        fontPreferencesRef.current = next;
        setFontFamily(next.fontFamily);
        if (!fontSizeAdjustedRef.current) {
          fontSizeRef.current = next.fontSize;
          setFontSize(next.fontSize);
          terminal.options.fontSize = next.fontSize;
        }
        updateFont();
      };
      window.addEventListener("focus", refreshFontPreferences);
      document.fonts.addEventListener("loadingdone", updateFont);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

      const connect = () => {
        if (disposed || exited || closingRef.current || !navigator.onLine) return;
        events?.close();
        events = new EventSource(runtimeApi(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`));
        events.onmessage = (message) => {
          if (disposed) return;
          const event = JSON.parse(message.data) as TerminalEvent;
          if (event.type === "output") {
            if (event.reset) terminal.reset();
            else if (offset !== undefined && event.offset <= offset) return;
            // Empty initial replay is valid SSE; Ghostty 0.4 cannot allocate a zero-byte write.
            if (event.data.length > 0) {
              terminal.write(event.data);
            }
            offset = event.offset;
          } else {
            exited = true;
            connected = false;
            terminal.options.disableStdin = true;
            events?.close();
            setExitCode(event.type === "exit" ? event.exitCode : null);
            setStatus("exited");
          }
        };
        events.onopen = () => {
          if (disposed) return;
          connected = true;
          if (inputFailed || closingRef.current) return;
          terminal.options.disableStdin = false;
          setStatus("ready");
          fitAndResize();
          writer.resize(Math.max(2, terminal.cols), Math.max(2, terminal.rows));
          if (activeRef.current && container.offsetWidth && container.offsetHeight) terminal.focus();
        };
        events.onerror = () => {
          if (disposed || exited) return;
          connected = false;
          terminal.options.disableStdin = true;
          setStatus(events?.readyState === EventSource.CLOSED ? "error" : "connecting");
        };
      };
      const pageHide = () => {
        connected = false;
        terminal.options.disableStdin = true;
        events?.close();
        if (!exited && !inputFailed) setStatus("connecting");
      };
      const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
      window.addEventListener("pagehide", pageHide);
      window.addEventListener("pageshow", pageShow);
      window.addEventListener("offline", pageHide);
      window.addEventListener("online", connect);
      cleanup = () => {
        events?.close();
        void writer.stop();
        resizeObserver.disconnect();
        themeObserver.disconnect();
        window.removeEventListener("focus", refreshFontPreferences);
        document.fonts.removeEventListener("loadingdone", updateFont);
        onData.dispose();
        onResize.dispose();
        window.removeEventListener("pagehide", pageHide);
        window.removeEventListener("pageshow", pageShow);
        window.removeEventListener("offline", pageHide);
        window.removeEventListener("online", connect);
        terminal.dispose();
        host.remove();
        terminalRef.current = null;
        refitRef.current = () => {};
      };
      fitAndResize();
      if (restored || shellRef.current.created) {
        // A restored tab never silently launches a replacement shell.
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
        });
      }
      if (shellRef.current.id === id) shellRef.current.created = true;
      connect();
    })().catch((reason: Error) => {
      if (disposed) return;
      setError(reason.message);
      setStatus("error");
    });
    return () => { disposed = true; fontController.abort(); cleanup(); };
  }, [id, cwd, restored, reconnectKey, consumeModifiers]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    refitRef.current();
  }, [fontSize]);
  useEffect(() => {
    if (active) { refitRef.current(); terminalRef.current?.focus(); }
    else terminalRef.current?.blur();
  }, [active]);
  useEffect(() => {
    if (!tab.closing) return;
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      await startRef.current;
      await writerRef.current?.stop();
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className="terminal-panel is-toolbarless" aria-label={t("terminal.title")} data-terminal-status={status} data-terminal-engine="ghostty" data-terminal-font-family={fontFamily} data-terminal-font-size={fontSize}>
      <div>
        {(error || actionError) && <div className="terminal-panel-error" role="alert">{error || actionError}{status === "error" && <button type="button" onClick={() => setReconnectKey(key => key + 1)} disabled={Boolean(tab.closing)}>{t("terminal.reconnect")}</button>}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-workspace-content">
        <div className="terminal-viewport"><div ref={containerRef} className="terminal-ghostty-host" /></div>
      </div>
      {showExtraKeys && <TerminalExtraKeys modifiers={modifiers} onKey={sendExtraKey} onToggleModifier={toggleModifier} />}
    </section>
  );
}
