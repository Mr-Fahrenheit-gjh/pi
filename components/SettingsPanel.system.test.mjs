import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default {};" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { SettingsPanel } = await jiti.import("./SettingsPanel.tsx");

function render(prompt) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SettingsPanel, {
      cwd: null, sessionId: null, initialSection: "system", systemPrompt: prompt,
      onLoadSystemPrompt: async () => {}, onClose() {}, onSessionReloaded() {},
      quoteSelectionEnabled: false, onQuoteSelectionChange() {},
    })));
}

test("Settings offers System prompt on desktop and mobile without a project", () => {
  const html = render("Exact runtime prompt <instruction>");
  assert.match(html, /<option value="system" selected="">System prompt<\/option>/);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?<span>System prompt<\/span>/);
  assert.match(html, /Exact runtime prompt &lt;instruction&gt;/);
  assert.match(html, />Refresh<\/button>/);
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options, ["general", "models", "api", "skills", "agents", "plugins", "mcp", "system"]);
  const tabs = html.slice(html.indexOf('<nav '), html.indexOf('</nav>'));
  assert.ok(tabs.lastIndexOf('System prompt') > tabs.lastIndexOf('MCP'));
  assert.match(html, /class="settings-system-prompt"/);
  assert.match(html, /class="config-detail-header"/);
  assert.match(html, /class="system-prompt-panel is-embedded"/);
  assert.doesNotMatch(html, /class="settings-shell-option"/);
});

test("Settings preserves the unloaded and empty prompt states", () => {
  assert.match(render(null), /System prompt has not loaded yet/);
  assert.match(render(""), /System prompt is empty/);
});
