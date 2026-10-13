import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { TerminalBrowserPreview } = await jiti.import("./TerminalBrowser.tsx");
const render = collapsed => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(TerminalBrowserPreview, { url: "https://example.test/course", onNavigate() {}, collapsed, controlsId: "browser-controls-test" })));

test("collapsed browser hides its addressbar but retains the webpage", () => {
  const html = render(true);
  assert.match(html, /is-controls-collapsed/);
  assert.match(html, /<form[^>]*hidden/);
  assert.match(html, /<iframe[^>]*src="https:\/\/example.test\/course"/);
});
test("expanded addressbar has no redundant return-to-terminal button", () => {
  const html = render(false);
  assert.doesNotMatch(html, /<form[^>]*hidden/);
  assert.doesNotMatch(html, />Terminal<|onBack/);
  assert.match(html, /aria-label="Web address"/);
});
test("no permanent embedding-help banner occupies the viewport", () => {
  for (const collapsed of [true, false]) {
    const html = render(collapsed);
    assert.doesNotMatch(html, /terminal-browser-note|cannot be embedded|role="alert"/);
  }
});
test("the iframe retains the same URL and dedicated full-height grid row while folded", async () => {
  const css = await readFile(new URL("../app/sidebar-terminal-polish.css", import.meta.url), "utf8");
  assert.match(css, /\.terminal-browser-preview\.is-controls-collapsed \{ grid-template-rows: 0 auto minmax\(0, 1fr\); \}/);
  assert.match(css, /\.terminal-browser-preview iframe \{ grid-row: 3;/);
  assert.equal((render(true).match(/<iframe/g) ?? []).length, 1);
  assert.equal((render(false).match(/<iframe/g) ?? []).length, 1);
});
