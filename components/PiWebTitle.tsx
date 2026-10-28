"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { pageRuntime, runtimePage, type AgentRuntime } from "@/lib/runtime-client.mjs";
import { SidebarMenu, type SidebarMenuAnchor } from "./SidebarMenu";

/**
 * The sidebar's brand with the files below the sessions (its toolbar row,
 * components/SessionSidebar.tsx; the tabs layout has its tabs there), with
 * Click opens the runtime switcher. The versions remain an explicit menu
 * action, using the original temporary scramble animation.
 */

export const BRAND_TEXT = "Pi Web";
/** How long the versions stay, counted from the click that showed them. */
export const VERSION_SHOWN_MS = 3000;
/** The text settles left to right over its length times this many frames. */
export const SCRAMBLE_FRAMES_PER_CHAR = 4;
export const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
export const RUNTIME_SWITCH_MOTION_KEY = "pi-web:runtime-switch-motion";
export const RUNTIME_SWITCH_MOTION_MS = 400;

/** A one-shot, tab-local arrival cue; reloads and direct visits stay still. */
export function consumeRuntimeSwitchMotion(storage: Pick<Storage, "getItem" | "removeItem">, target: AgentRuntime, now = Date.now()): boolean {
  try {
    const value = storage.getItem(RUNTIME_SWITCH_MOTION_KEY);
    storage.removeItem(RUNTIME_SWITCH_MOTION_KEY);
    if (!value) return false;
    const intent = JSON.parse(value);
    return intent?.target === target && Number.isFinite(intent.at) && now >= intent.at && now - intent.at < 10000;
  } catch {
    return false;
  }
}

/** The versions as the brand shows them: "0.11.0p1.1.0". */
export function brandVersionText(appVersion: string | undefined, piVersion: string | undefined): string {
  return `${appVersion ?? "0.0.0"}p${piVersion ?? "0.0.0"}`;
}

/** How many frames `target` takes to settle. */
export function scrambleFrameCount(target: string): number {
  return target.length * SCRAMBLE_FRAMES_PER_CHAR;
}

/**
 * The scramble's text at `frame` (from 0): spaces kept, the characters
 * settling left to right, every one not yet settled random; `target` itself
 * from the last frame on. The length never changes, so in the brand's code
 * type neither does the width while it scrambles.
 */
export function scrambleFrame(target: string, frame: number, random: () => number = Math.random): string {
  const total = scrambleFrameCount(target);
  if (frame >= total) return target;
  const settled = Math.floor((frame / total) * target.length);
  let text = "";
  for (let index = 0; index < target.length; index++) {
    const char = target[index];
    text += char === " " || index < settled ? char : SCRAMBLE_CHARS[Math.floor(random() * SCRAMBLE_CHARS.length)];
  }
  return text;
}

/**
 * Scramble a changed target or an intentional runtime-switch arrival, but not
 * an ordinary mount/refresh. Resolve characters over a fixed duration. Under
 * prefers-reduced-motion the text is swapped at once.
 */
function useScramble(target: string, ready: boolean, animateArrival: boolean): string {
  const [text, setText] = useState(target);
  const shownRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready || shownRef.current === target) return;
    const arrival = shownRef.current === null;
    shownRef.current = target;
    if ((arrival && !animateArrival) || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setText(target);
      return;
    }
    const totalFrames = scrambleFrameCount(target);
    const duration = arrival ? RUNTIME_SWITCH_MOTION_MS : totalFrames * (1000 / 60);
    const started = performance.now();
    let request = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      setText(scrambleFrame(target, progress * totalFrames));
      if (progress < 1) request = requestAnimationFrame(step);
    };
    setText(scrambleFrame(target, 0));
    request = requestAnimationFrame(step);
    return () => cancelAnimationFrame(request);
  }, [target, ready, animateArrival]);
  return text;
}

export function PiWebTitle({ onWidthChange }: {
  /**
   * After a commit that changed the text's length (in its code type, its
   * width): the toolbar row fits its labels again, before that paints.
   */
  onWidthChange?: () => void;
}) {
  const { t } = useI18n();
  const [versionShown, setVersionShown] = useState(false);
  const [{ runtime, ready, animateArrival }, setRuntimeState] = useState({ runtime: "pi" as AgentRuntime, ready: false, animateArrival: false });
  const initializedRef = useRef(false);
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const current = pageRuntime();
    let animate = false;
    try { animate = consumeRuntimeSwitchMotion(window.sessionStorage, current); } catch { /* Storage can be disabled. */ }
    setRuntimeState({ runtime: current, ready: true, animateArrival: animate });
  }, []);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;
  const piVersion = process.env.NEXT_PUBLIC_PI_VERSION;
  const text = useScramble(versionShown ? brandVersionText(appVersion, piVersion) : runtime === "feynman" ? "Feynman" : runtime === "meta" ? "Pi Meta" : BRAND_TEXT, ready, animateArrival);

  useLayoutEffect(() => {
    onWidthChange?.();
  }, [text.length, onWidthChange]);

  useEffect(() => () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
  }, []);

  const handleClick = () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    revertTimerRef.current = null;
    if (versionShown) {
      setVersionShown(false);
      return;
    }
    setVersionShown(true);
    revertTimerRef.current = setTimeout(() => {
      revertTimerRef.current = null;
      setVersionShown(false);
    }, VERSION_SHOWN_MS);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-brand${versionShown ? " is-version" : ""}`}
        aria-label={t("sidebar.runtimeSwitch")}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setAnchor(anchor ? null : { kind: "rect", rect, align: "start" });
        }}
      >
        {text}
      </button>
      <SidebarMenu
        open={anchor !== null} anchor={anchor} sheet={false}
        ariaLabel={t("sidebar.runtimeSwitch")} cancelLabel={t("sidebar.runtimeCancel")}
        onClose={() => setAnchor(null)} returnFocusTo={buttonRef.current} width={180}
        items={[
          ...(["pi", "meta", "feynman"] as const).map((target) => ({
            type: "item" as const, id: target, label: target === "pi" ? "Pi Web" : target === "meta" ? "Pi Meta" : "Feynman",
            checked: runtime === target,
            onSelect: () => {
              if (target === runtime) return;
              try {
                window.sessionStorage.setItem(RUNTIME_SWITCH_MOTION_KEY, JSON.stringify({ target, at: Date.now() }));
              } catch { /* Navigation must work even when storage is disabled. */ }
              window.location.assign(runtimePage(target));
            },
          })),
          { type: "separator", id: "versions-separator" },
          { type: "item", id: "versions", label: t("sidebar.runtimeVersions"), onSelect: handleClick, disabled: runtime !== "pi" },
        ]}
      />
    </>
  );
}
