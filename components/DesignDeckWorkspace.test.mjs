import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { DesignDeckWorkspace } = await jiti.import("./DesignDeckWorkspace.tsx");
const deck = { id: "00112233-4455-6677-8899-aabbccddeeff", sessionId: "session", title: "Layout choices", url: "http://127.0.0.1:42001/?session=fixture&embedded=1" };

test("deck uses the existing embedded Chrome surface with no visible external-link toolbar", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(DesignDeckWorkspace, { deck, active: false })));
  assert.match(html, /aria-label="Layout choices"/);
  assert.match(html, /data-browser-engine="chrome"/);
  assert.match(html, /<form[^>]*hidden/);
  assert.match(html, /data-browser-id="[0-9a-f]{32}"/);
  assert.doesNotMatch(html, /<iframe/);
});

test("reloads and windows reconnect to the presentation-owned browser page", () => {
  const render = () => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(DesignDeckWorkspace, { deck, active: false }))).match(/data-browser-id="([^"]+)"/)[1];
  assert.equal(render(), render());
});

test("presentation clients cannot delete their shared page on unmount", async () => {
  const source = await readFile(new URL("./NativeBrowser.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/if \(!presentationId\) void fetch/g) ?? []).length, 2);
});

test("AppShell retains live deck viewers when switching workspace tabs", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /designDecks\.map\(deck =>/);
  assert.match(source, /key=\{deck.id\} hidden=\{!selected\}/);
  assert.match(source, /<DesignDeckWorkspace deck=\{deck\} active=/);
  assert.match(source, /label: "Design Deck".*pinned: true/);
  assert.match(source, /if \(openedDesignDecks.current.has\(selectedDesignDeckId\)\) return/);
});
