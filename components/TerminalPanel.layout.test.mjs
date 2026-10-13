import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { TerminalPanel } = await jiti.import("./TerminalPanel.tsx");
test("terminal has no permanent toolbar or remote browser surface", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(TerminalPanel, {
    tab: { id: "a".repeat(32), cwd: "/tmp", restored: true }, active: false, onRestart() {}, onClosed() {}, onCloseError() {},
  })));
  assert.doesNotMatch(html, /terminal-panel-header|terminal-open-control|terminal-engine-label|terminal-cwd|browser-remote-image/);
  assert.match(html, /is-toolbarless/); assert.match(html, /terminal-ghostty-host/);
});
test("existing HTML preview is a native sandboxed iframe, with source view preserved", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /isHtml && effectiveDisplayMode === "preview"[\s\S]*?<iframe[\s\S]*?srcDoc=/);
  assert.match(source, /sandbox="allow-scripts"/);
  const htmlFrame = source.match(/isHtml && effectiveDisplayMode === "preview"[\s\S]*?<iframe[\s\S]*?\/>/)[0];
  assert.doesNotMatch(htmlFrame, /allow-same-origin|browser-remote-image/);
  assert.doesNotMatch(source, /NativeBrowser|browser-remote-image/);
});
