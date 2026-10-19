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

test("attachment cards sit above the draft inside one surface and the toolbar is outside", async () => {
  const { setDraft, clearDraft } = await jiti.import("@/lib/draft-store");
  const key = "workspace-composer-attachment-test";
  setDraft(key, { value: "Review this", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
  try {
    const html = composer({ draftKey: key });
    const surface = html.indexOf('class="composer-surface"');
    const attachments = html.indexOf('class="composer-attachments"');
    const textarea = html.indexOf("<textarea");
    const controls = html.indexOf('class="chat-input-controls"');
    assert.ok(surface > 0 && attachments > surface && textarea > attachments && controls > textarea);
    assert.match(html, /aria-label="Remove attachment 1"/);
    assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
    // Both input wrappers and the surface close before the toolbar.
    assert.match(html.slice(textarea, controls), /<\/div><\/div><\/div><div $/);
  } finally { clearDraft(key); }
});

test("upload dialog uses a native modal, private upload callbacks and isolated file drops", async () => {
  const source = await readFile(new URL("./AttachmentDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /dialog\?\.showModal\(\)/);
  assert.match(source, /listenForStackedDialogEscape\(document, onClose\)/);
  assert.match(source, /if \(opener\?\.isConnected\) opener.focus/);
  assert.match(source, /onCancel=\{\(event\) => \{ event.preventDefault\(\); onClose\(\); \}\}/);
  assert.match(source, /event.preventDefault\(\); event.stopPropagation\(\);[\s\S]*Array.from\(event.dataTransfer.files\)/);
  assert.match(source, /onFiles\(files\); onClose\(\)/);
  assert.match(source, /onClick=\{onChoose\}/);
  assert.doesNotMatch(source, /fetch\(|api\/files|Beta/);
});

test("welcome composer has one upload action inside the card and project/model controls below", () => {
  const html = composer({ welcome: true, welcomeToolbar: h("button", null, "Project") });
  const actions = html.indexOf('class="composer-welcome-actions"');
  const toolbar = html.indexOf('class="chat-input-controls"');
  assert.ok(actions > html.indexOf("<textarea") && toolbar > actions);
  assert.match(html, /placeholder="How can I help you today\?"/);
  assert.equal((html.match(/aria-label="Attach files"/g) ?? []).length, 1);
  assert.equal((html.match(/data-composer-send=/g) ?? []).length, 1);
  assert.ok(html.indexOf('aria-label="Attach files"') < toolbar);
  assert.ok(html.indexOf(">Project</button>") > toolbar);
  assert.match(html, /d="m9 10-5 5 5 5M4 15h13a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3h-4"/);
});

test("the welcome settings label reflects actual reasoning selection without changing the reply trigger", () => {
  const auto = composer({ welcome: true, isAutoThinkingSelection: true, thinkingLevel: "medium" });
  const manual = composer({ welcome: true, isAutoThinkingSelection: false, thinkingLevel: "high" });
  const trigger = (html) => html.match(/<button[^>]*data-composer-options-trigger="true"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(trigger(auto), />Auto<\/span>/);
  assert.match(trigger(manual), />high<\/span>/);
  assert.match(trigger(composer()), /<svg/);
});

test("reference upload copy stays English and normal-weight independently of UI locale", async () => {
  const source = await readFile(new URL("./AttachmentDialog.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/workspace.css", import.meta.url), "utf8");
  for (const text of ["Upload or add files", "Drag files or photos here", "Documents, images, spreadsheets, and code files", "Choose files"]) assert.ok(source.includes(text));
  assert.match(source, /lang="en"/);
  assert.doesNotMatch(source, /useI18n/);
  assert.match(source, /id="attachment-upload-limits" className="sr-only"/);
  assert.match(css, /\.attachment-dialog-header h2 \{[^}]*font-weight: 400/);
  assert.match(css, /\.attachment-dialog \{[^}]*font-family: var\(--font-ui\)/);
  assert.match(css, /padding: 12px 54px 12px 16px !important;\s*min-height: 52px/);
  assert.match(css, /\.chat-input-controls > \.model-selector \{\s*width: auto !important;\s*flex: 1 1 0 !important;/);
  assert.match(css, /\.composer-controls-spacer \{ display: none; \}/);
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

test("context usage is a read-only percentage ring with no inspector", () => {
  const usage = { percent: 8, tokens: 32000, contextWindow: 400000 };
  const html = render(ContextUsageRing, { usage });
  assert.match(html, /aria-label="Context: 8%"/);
  assert.match(html, /role="meter"/);
  assert.doesNotMatch(html, /<button|tokens|onClick/);
  assert.match(html, /stroke-dasharray="8 100"/);
  assert.equal(contextUsagePercent({ ...usage, percent: -20 }), 0);
  assert.equal(contextUsagePercent({ ...usage, percent: 120 }), 100);
  assert.equal(contextUsagePercent({ ...usage, percent: NaN }), null);
});

test("the header has no session menu, title or agent icon", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<ActionMenuButton|className="workspace-session-title"|data-agent-switcher\s/);
  assert.match(source, /<AgentWorkspace/);
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
  assert.doesNotMatch(css, /--chat-content-font-size\s*:|--font-ui\s*:|\.new-session-logo\s*\{/);
  assert.match(css, /\.sidebar-container[\s\S]*?font-family:/);
  assert.match(css, /prefers-reduced-motion/);
});
