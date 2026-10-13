import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { TerminalBrowserView } = await jiti.import("./TerminalBrowser.tsx");
const render = collapsed => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(TerminalBrowserView, { url: "https://example.test/course", onNavigate() {}, collapsed, controlsId: "browser-controls-test", active: false, onExpand() {} })));
test("collapsed browser hides its addressbar but retains the independent Chrome surface", () => {
  const html = render(true);
  assert.match(html, /is-controls-collapsed/); assert.match(html, /<form[^>]*hidden/);
  assert.match(html, /data-browser-engine="chrome"/); assert.doesNotMatch(html, /<iframe/);
});
test("expanded addressbar has navigation but no redundant return-to-terminal button", () => {
  const html = render(false);
  assert.doesNotMatch(html, /<form[^>]*hidden/); assert.doesNotMatch(html, />Terminal<|onBack/);
  assert.match(html, /aria-label="Web address"/); assert.match(html, /aria-label="Back"/);
});
test("no permanent embedding-help banner occupies the viewport", () => {
  for (const collapsed of [true, false]) assert.doesNotMatch(render(collapsed), /terminal-browser-note|cannot be embedded|role="alert"/);
});
test("folding keeps the independent surface in its full-height grid row", async () => {
  const css = await readFile(new URL("../app/sidebar-terminal-polish.css", import.meta.url), "utf8");
  assert.match(css, /\.terminal-browser-preview\.is-controls-collapsed \{ grid-template-rows: 0 auto minmax\(0, 1fr\); \}/);
  assert.match(css, /\.browser-remote-surface \{ grid-row: 3;/);
  assert.match(render(true), /data-browser-url="https:\/\/example.test\/course"/);
});
