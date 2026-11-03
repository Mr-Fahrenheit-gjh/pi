import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const { newSessionGreeting } = await createJiti(import.meta.url).import("./new-session-greeting.ts");
test("greeting follows local time at day-period boundaries", () => {
  for (const [hour, minute, period] of [[0, 0, "Morning"], [11, 59, "Morning"], [12, 0, "Afternoon"], [17, 59, "Afternoon"], [18, 0, "Evening"], [23, 59, "Evening"]]) {
    assert.equal(newSessionGreeting(new Date(2026, 9, 20, hour, minute), "", () => 0), `${period}, Mr.Fahrenheit`);
  }
});
test("each visit can pick from eight short greetings with the same name", () => {
  const date = new Date(2026, 9, 20, 14);
  const greetings = Array.from({ length: 8 }, (_, index) =>
    newSessionGreeting(date, "", () => index / 8));
  assert.deepEqual(greetings, [
    "Afternoon", "Hello", "Hey there", "Hi there", "Welcome back",
    "Good to see you", "Nice to see you", "Happy to see you",
  ].map((text) => `${text}, Mr.Fahrenheit`));
  assert.equal(newSessionGreeting(date, "", () => 0.999999), greetings.at(-1));
});

test("the previous greeting is excluded, including across time-period changes", () => {
  const date = new Date(2026, 9, 20, 14);
  const greetings = Array.from({ length: 8 }, (_, index) =>
    newSessionGreeting(date, "", () => index / 8));
  for (const previous of greetings) {
    const next = Array.from({ length: 7 }, (_, index) =>
      newSessionGreeting(date, previous, () => index / 7));
    assert.equal(new Set(next).size, 7);
    assert.ok(!next.includes(previous));
  }
  assert.equal(newSessionGreeting(date, "Morning, Mr.Fahrenheit", () => 0), greetings[0]);
  assert.equal(newSessionGreeting(date, "outdated copy", () => 0), greetings[0]);
});

test("welcome chooses once on entry, remembers the choice and does not rotate on focus or a timer", async () => {
  const source = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const effect = source.slice(source.indexOf('const [greeting, setGreeting]'), source.indexOf('const completionNotificationsEnabled'));
  assert.match(effect, /if \(session \|\| packageTarget\) return;/);
  assert.match(effect, /localStorage\.getItem\("pi:last-new-session-greeting"\)/);
  assert.match(effect, /newSessionGreeting\(new Date\(\), previous\)/);
  assert.match(effect, /localStorage\.setItem\("pi:last-new-session-greeting", next\)/);
  assert.match(effect, /\}, \[session, packageTarget\]\);/);
  assert.doesNotMatch(effect, /setInterval|setTimeout|addEventListener/);
});

test("reference greeting stays light and the composer has a subtle shadow", async () => {
  const css = await readFile(new URL("../app/workspace.css", import.meta.url), "utf8");
  assert.match(css, /\.new-session-greeting\s*\{[^}]*font-weight: 300;/);
  assert.match(css, /\.new-session-greeting\s*\{[^}]*letter-spacing: 0;/);
  assert.match(css, /font-size: clamp\(26px, 3\.2vw, 40px\)/);
  assert.match(css, /\.composer-surface\s*\{[^}]*box-shadow: 0 4px 20px/);
});
