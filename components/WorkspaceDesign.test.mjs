import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { ActionMenuButton } = await jiti.import("./ActionMenuButton.tsx");
const { RevealFileButton } = await jiti.import("./RevealFileButton.tsx");
const { ContextUsageRing, contextUsagePercent } = await jiti.import("./ContextUsageRing.tsx");
const h = React.createElement;
const render = (component, props) => renderToStaticMarkup(h(I18nProvider, null, h(component, props)));
const composer = (props = {}) => render(ChatInput, { onSend() {}, onAbort() {}, onCompact() {}, onAbortCompaction() {}, onToolPresetChange() {}, onThinkingLevelChange() {}, onSoundToggle() {}, isStreaming: false, ...props });

test("the desktop composer is one surface, with secondary settings closed by default", () => {
  const html = composer();
  assert.match(html, /class="composer-card"/);
  assert.match(html, /data-composer-options-trigger="true"[^>]*aria-expanded="false"/);
  assert.match(html, /class="composer-options"[^>]*style="display:none/);
  assert.doesNotMatch(html, /class="composer-stop"/);
});

test("run cancellation is outside the hidden options group", () => {
  const html = composer({ isStreaming: true });
  const stop = html.indexOf('class="composer-stop"');
  const options = html.indexOf('class="composer-options"');
  assert.ok(stop > 0 && stop < options);
  assert.match(html.slice(stop, options), /aria-label="Stop agent"/);
});

test("compaction cancellation stays direct even while settings are closed", () => {
  const html = composer({ isCompacting: true });
  const stop = html.indexOf('class="composer-stop"');
  assert.ok(stop > 0 && stop < html.indexOf('class="composer-options"'));
  assert.match(html.slice(stop, html.indexOf('class="composer-options"')), /aria-label="Stop compaction"/);
});

test("sending and cancellation are icon-only, with a single default steering action", () => {
  const html = composer({ isStreaming: true, onSteer() {}, onFollowUp() {} });
  assert.equal((html.match(/data-composer-send=/g) ?? []).length, 1);
  assert.match(html, /data-composer-send="true"[^>]*aria-label="Steer"/);
  assert.doesNotMatch(html, />Steer<|>Follow-up<|>Stop<|rgba\(234,179,8,0\.4\)/);
  assert.match(html, /<div class="composer-card">/);
});

test("context usage is a neutral ring with exact figures on hover", () => {
  const usage = { percent: 8, tokens: 32000, contextWindow: 400000 };
  const html = render(ContextUsageRing, { usage, onOpen() {} });
  assert.match(html, /aria-label="Context: 8%"/);
  assert.match(html, /32,000 \/ 400,000 tokens/);
  assert.match(html, /stroke-dasharray="8 100"/);
  assert.equal(contextUsagePercent({ ...usage, percent: -20 }), 0);
  assert.equal(contextUsagePercent({ ...usage, percent: 120 }), 100);
  assert.equal(contextUsagePercent({ ...usage, percent: NaN }), null);
});

test("the session title is the menu and displayed billing is removed", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /className="workspace-title-menu"/);
  assert.doesNotMatch(source, /sessionStats\.cost|const costText|renderSessionStatsButton\(false\)/);
});

test("quote composers retain their compact layout with no settings menu", () => {
  const html = composer({ compact: true });
  assert.doesNotMatch(html, /composer-card|composer-options|data-composer-options-trigger/);
});

test("secondary action triggers expose the existing accessible menu contract", () => {
  const html = render(ActionMenuButton, { label: "More file actions", items: [], disabled: true });
  assert.match(html, /aria-label="More file actions" aria-haspopup="menu" aria-expanded="false" disabled=""/);
  assert.doesNotMatch(html, /role="menu"/);
});

test("local file actions stay hidden until availability is confirmed", () => {
  assert.equal(render(RevealFileButton, { filePath: "/work/file.md" }), "");
});

test("all file viewer types share reveal and download, deleted files expose neither", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<FileActions filePath=/g) ?? []).length, 5);
  assert.match(source, /function FileActions[\s\S]*?<RevealFileButton filePath=\{filePath\}/);
  assert.match(source, /!isDeletedDiff && <FileActions/);
});

test("the visual layer preserves user typography, themes and logo size", async () => {
  const css = await readFile(new URL("../app/workspace.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /font-family\s*:|--chat-content-font-size\s*:|--font-ui\s*:|\.new-session-logo\s*\{/);
  assert.match(css, /prefers-reduced-motion/);
});
