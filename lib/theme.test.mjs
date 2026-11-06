import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { enLocale } from "./i18n/messages/en.ts";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import { zhTWLocale } from "./i18n/messages/zh-TW.ts";
import { THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";

test("Claude is an additional localized light palette, not a new default", () => {
  assert.deepEqual(THEME_OPTIONS.map(({ id }) => id), ["light", "dark", "claude", "claude-white", "mist", "rose", "pine", "auto"]);
  assert.equal(isThemePreference("claude"), true);
  assert.equal(isDarkTheme("claude"), false);
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    for (const { label } of THEME_OPTIONS) assert.ok(locale.messages[label]);
  }
});

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const palette = (id) => Object.fromEntries([...css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]+)\\}`))[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value]));
const luminance = (hex) => {
  const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test("Claude overrides every palette color without changing font/layout tokens and keeps AA text contrast", () => {
  const claude = palette("claude");
  assert.deepEqual(Object.keys(claude), Object.keys(palette("mist")));
  assert.equal(claude["--bg"], "#faf9f5");
  assert.equal(claude["--bg-panel"], "#f0eee6");
  for (const background of ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--user-bg", "--assistant-bg", "--tool-bg"]) {
    for (const foreground of ["--text", "--text-muted", "--text-dim", "--accent", "--accent-hover"]) {
      assert.ok(contrast(claude[foreground], claude[background]) >= 4.5, `${foreground} on ${background}`);
    }
  }
  for (const background of ["--accent", "--accent-hover"]) assert.ok(contrast(claude["--accent-contrast"], claude[background]) >= 4.5);
});

test("Claude White is separate, neutral, readable and retains the warm palette", () => {
  assert.equal(isThemePreference("claude-white"), true);
  assert.equal(isDarkTheme("claude-white"), false);
  const white = palette("claude-white");
  assert.deepEqual(Object.keys(white), Object.keys(palette("claude")));
  assert.equal(white["--bg"], palette("light")["--bg"]);
  assert.equal(white["--assistant-bg"], "#ffffff");
  assert.equal(white["--user-bg"], "#f3f3f3");
  for (const surface of ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--border", "--user-bg", "--tool-bg"]) {
    const channels = white[surface].slice(1).match(/../g);
    assert.equal(new Set(channels).size, 1, `${surface} stays neutral, not beige`);
  }
  assert.ok(luminance(white["--bg-panel"]) > luminance(palette("light")["--bg-panel"]));
  for (const bg of ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--user-bg", "--tool-bg"]) {
    for (const fg of ["--text", "--text-muted", "--text-dim", "--accent", "--accent-hover"]) {
      assert.ok(contrast(white[fg], white[bg]) >= 4.5, `${fg} on ${bg}`);
    }
    for (const status of ["#4c705c", "#95564e", "#7a5f2c"]) assert.ok(contrast(status, white[bg]) >= 4.5);
  }
  assert.ok(contrast(white["--accent-contrast"], white["--accent"]) >= 4.5);
});

test("first paint restores every palette and falls back to the system for invalid or blocked storage", () => {
  for (const systemDark of [false, true]) {
    for (const stored of [...THEME_OPTIONS.map(({ id }) => id), null, "", "unknown", new Error("Blocked")]) {
      const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      runInNewContext(THEME_INIT_SCRIPT, {
        localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: root },
      });
      const expected = isThemePreference(stored) && stored !== "auto" ? stored : systemDark ? "dark" : "light";
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
    }
  }
});
