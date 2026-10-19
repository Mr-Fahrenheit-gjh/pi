import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ordinary controls do not opt into the hand cursor", async () => {
  for (const directory of ["app", "components"]) {
    for (const name of await readdir(new URL(`${directory}/`, root), { recursive: true })) {
      if (!/\.(css|tsx)$/.test(name)) continue;
      const text = await readFile(new URL(`${directory}/${name}`, root), "utf8");
      assert.doesNotMatch(text, /\bcursor-pointer\b|cursor\s*:[^;\n}]*\bpointer\b/, `${directory}/${name}`);
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
