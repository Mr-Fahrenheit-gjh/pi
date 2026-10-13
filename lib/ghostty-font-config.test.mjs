import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseGhosttyFontConfig, DEFAULT_GHOSTTY_FONT } = await jiti.import("./ghostty-font-config.ts");
const { loadGhosttyFontPreferences } = await jiti.import("./ghostty-terminal.ts");

test("native config exposes only font family and logical size, not arbitrary settings", () => {
  const result = parseGhosttyFontConfig('font-family = JetBrainsMono Nerd Font\nfont-size = 14\nenv = SECRET=hidden\ncommand = hidden\nfont-thicken = true\nadjust-cell-height = 2');
  assert.equal(result.fontSize, 14);
  assert.ok(result.fontFamily.startsWith('"JetBrainsMono Nerd Font",'));
  assert.equal(result.source, "ghostty");
  assert.deepEqual(Object.keys(result).sort(), ["fontFamily", "fontSize", "source"]);
  assert.ok(!JSON.stringify(result).includes("hidden"));
});
test("font reset, fallback families, quoted names and fractional sizes", () => {
  const value = parseGhosttyFontConfig('font-family = old\nfont-family =\nfont-family = "Maple Mono NF"\nfont-family = PingFang SC\nfont-size = 15.5');
  assert.ok(!value.fontFamily.includes('old'));
  assert.ok(value.fontFamily.startsWith('"Maple Mono NF", "PingFang SC",'));
  assert.equal(value.fontSize, 15.5);
  assert.equal(parseGhosttyFontConfig("font-size = invalid").fontSize, 14);
  assert.equal(parseGhosttyFontConfig("font-size = Infinity").fontSize, 14);
  assert.equal(parseGhosttyFontConfig("font-size = -2").fontSize, 8);
  assert.equal(parseGhosttyFontConfig("font-size = 900").fontSize, 72);
  assert.equal(parseGhosttyFontConfig("font-family = Bad\u0000Font").fontFamily, DEFAULT_GHOSTTY_FONT.fontFamily);
});
test("preferences network errors and malformed responses retain readable defaults", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  assert.deepEqual(await loadGhosttyFontPreferences(), DEFAULT_GHOSTTY_FONT);
  mock.mock.mockImplementation(async () => new Response('{"fontFamily":42,"fontSize":14}'));
  assert.deepEqual(await loadGhosttyFontPreferences(), DEFAULT_GHOSTTY_FONT);
  mock.mock.mockImplementation(async () => Response.json({ fontFamily: '"Maple Mono NF", monospace', fontSize: 32, source: "ghostty" }));
  const value = await loadGhosttyFontPreferences();
  assert.equal(value.fontSize, 32);
  assert.equal(value.fontFamily, '"Maple Mono NF", monospace');
  assert.equal(mock.mock.calls.at(-1).arguments[0], "/api/terminal/preferences");
});
