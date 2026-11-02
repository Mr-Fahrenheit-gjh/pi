import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

// Freeze the released exceptions; a core upgrade must not change existing UI.
const releasedPointers = {
  "app/settings.css": [".api-workbench summary"],
  "app/workspace.css": [".attachment-card-open", ".attachment-card-remove", ".attachment-preview-content > header button"],
  "app/split-conversation.css": [".split-new", ".split-history-list button"],
  "app/workflow-polish.css": [".quick-actions-modes button"],
  "app/voice.css": [".voice-call-details summary"],
  "components/InlineVisual.module.css": [".parameters button"],
};
test("ordinary controls preserve only the released hand-cursor exceptions", async () => {
  for (const directory of ["app", "components"]) {
    for (const name of await readdir(new URL(`${directory}/`, root), { recursive: true })) {
      if (!/\.(css|tsx)$/.test(name)) continue;
      const text = await readFile(new URL(`${directory}/${name}`, root), "utf8");
      const file = `${directory}/${name}`;
      const selectors = [...text.matchAll(/([^{}]+)\{[^{}]*\bcursor\s*:\s*pointer\b[^{}]*\}/g)].map(match => match[1].trim());
      assert.deepEqual(selectors, releasedPointers[file] ?? [], file);
      assert.doesNotMatch(text, /\bcursor-pointer\b/, file);
    }
  }
});

test("links use the arrow without overriding text, zoom or drag cursors", async () => {
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(css, /a\[href\]\s*\{\s*cursor:\s*default;\s*\}/);
  assert.match(css, /cursor:\s*zoom-in/);
  assert.match(css, /cursor:\s*grab;/);
  assert.match(css, /cursor:\s*grabbing;/);
  assert.match(css, /cursor:\s*col-resize/);
  assert.doesNotMatch(css, /cursor:\s*default\s*!important/);
});
