import type { ITheme } from "ghostty-web";
import { TERMINAL_THEME } from "./ghostty-terminal";

const DARK_COLORS = {
  black: "#262a30", red: "#d58d86", green: "#a1ba98", yellow: "#d6bb84",
  blue: "#95b2d2", magenta: "#b6a0c7", cyan: "#8cbbb6", white: "#d6d9dc",
  brightBlack: "#92999f", brightRed: "#e3a19a", brightGreen: "#b1c9a8",
  brightYellow: "#e3c996", brightBlue: "#a7c3e1", brightMagenta: "#c7b2d7",
  brightCyan: "#a0cdc7", brightWhite: "#f2f3f2",
};

export function terminalThemeForPalette(palette: { background: string; foreground: string; accent: string; selection: string }, dark: boolean): ITheme {
  return {
    ...TERMINAL_THEME,
    ...(dark ? DARK_COLORS : { black: "#30343b" }),
    background: palette.background, foreground: palette.foreground,
    cursor: palette.accent, cursorAccent: palette.background,
    selectionBackground: palette.selection, selectionForeground: palette.foreground,
  };
}

export function readTerminalTheme(root: HTMLElement): ITheme {
  const styles = getComputedStyle(root);
  const dark = root.classList.contains("dark");
  const color = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    if (/^#[0-9a-f]{3}$/i.test(value)) return `#${value.slice(1).split("").map(digit => digit + digit).join("")}`;
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return terminalThemeForPalette({
    background: color("--bg", dark ? "#1a1a1a" : "#ffffff"),
    foreground: color("--text", dark ? "#e8e8e8" : "#30343b"),
    accent: color("--accent", dark ? "#b4c1cd" : "#5c6570"),
    selection: color("--bg-selected", dark ? "#383e43" : "#dde1df"),
  }, dark);
}
