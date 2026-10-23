import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { inlineVisualInstructions, bindInlineVisualPrompt, createInlineVisualExtension, updateInlineVisualPreference } = await jiti.import("./inline-visual-prompt.ts");

test("inline diagram instructions are optional and bounded", () => {
  const enabled = inlineVisualInstructions(true);
  assert.match(enabled, /only when it materially clarifies/);
  assert.match(enabled, /FIRST/);
  assert.match(enabled, /Never move diagrams to the end/);
  assert.match(enabled, /hard limit 6000/);
  assert.match(enabled, /No implicit multiplication/);
  const disabled = inlineVisualInstructions(false);
  assert.match(disabled, /Do not emit pi-visual/);
  assert.doesNotMatch(disabled, /Example:/);
});

test("extension reads preference per request, preserving prompt sections, tools and user text", async () => {
  const preference = {};
  const handlers = new Map();
  const extension = createInlineVisualExtension(preference);
  assert.equal(extension.hidden, true);
  extension.factory({ on: (event, handler) => handlers.set(event, handler) });
  const before = handlers.get("before_agent_start");
  const agent = { transformContext: async messages => messages };
  bindInlineVisualPrompt(agent, preference);
  const first = Object.freeze({ role: "system", content: "base", sections: { original: "unchanged" }, toolsAdded: [{ name: "read" }], timestamp: 1 });
  const user = Object.freeze({ role: "user", content: "Explain a derivative", timestamp: 2 });
  const messages = [first, user];
  before({ messageType: "user" });
  assert.equal(await agent.transformContext(messages), messages);
  updateInlineVisualPreference(preference, "prompt", true);
  const enabled = await agent.transformContext(messages);
  assert.match(enabled[0].sections["pi-web-inline-visuals"], /inline diagrams are enabled/);
  assert.equal(enabled[0].content, first.content);
  assert.equal(enabled[0].toolsAdded, first.toolsAdded);
  assert.equal(enabled[0].sections.original, "unchanged");
  assert.equal(enabled[1], user);
  assert.equal(first.sections["pi-web-inline-visuals"], undefined);
  updateInlineVisualPreference(preference, "steer", false);
  assert.match((await agent.transformContext(messages))[0].sections["pi-web-inline-visuals"], /switched off/);
  before({ messageType: "custom" });
  assert.equal(await agent.transformContext(messages), messages);
  handlers.get("input")({ text: "a queued question" });
  assert.match((await agent.transformContext(messages))[0].sections["pi-web-inline-visuals"], /switched off/);
});

test("only explicit booleans on user submission commands change the preference", () => {
  const preference = {};
  updateInlineVisualPreference(preference, "get_state", true);
  updateInlineVisualPreference(preference, "prompt", "true");
  assert.equal(preference.enabled, undefined);
  for (const type of ["prompt", "steer", "follow_up"]) {
    updateInlineVisualPreference(preference, type, true);
    assert.equal(preference.enabled, true);
    updateInlineVisualPreference(preference, type, undefined);
    assert.equal(preference.enabled, true);
    updateInlineVisualPreference(preference, type, false);
    assert.equal(preference.enabled, false);
  }
  assert.doesNotThrow(() => updateInlineVisualPreference(undefined, "prompt", true));
});
