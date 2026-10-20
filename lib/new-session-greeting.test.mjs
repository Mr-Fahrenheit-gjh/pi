import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const { newSessionGreeting } = await createJiti(import.meta.url).import("./new-session-greeting.ts");
test("greeting follows local time at day-period boundaries", () => {
  for (const [hour, minute, period] of [[0, 0, "Morning"], [11, 59, "Morning"], [12, 0, "Afternoon"], [17, 59, "Afternoon"], [18, 0, "Evening"], [23, 59, "Evening"]]) {
    assert.equal(newSessionGreeting(new Date(2026, 9, 20, hour, minute)), `${period}, Mr.Fahrenheit`);
  }
});
test("reference greeting stays light and the composer has a subtle shadow", async () => {
  const css = await readFile(new URL("../app/workspace.css", import.meta.url), "utf8");
  assert.match(css, /\.new-session-greeting\s*\{[^}]*font-weight: 300;/);
  assert.match(css, /\.new-session-greeting\s*\{[^}]*letter-spacing: 0;/);
  assert.match(css, /font-size: clamp\(26px, 3\.2vw, 40px\)/);
  assert.match(css, /\.composer-surface\s*\{[^}]*box-shadow: 0 4px 20px/);
});
