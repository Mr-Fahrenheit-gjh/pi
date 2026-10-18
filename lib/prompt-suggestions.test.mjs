import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getPromptSuggestion, shouldShowPromptSuggestion } = await jiti.import("./prompt-suggestions.ts");
const widget = (data) => ({ key: "next-prompt-suggestion", lines: [JSON.stringify(data)], placement: "belowEditor" });
const suggestion = { version: 1, id: "generation-1", sessionId: "session-a", text: "帮我运行相关测试", acceptTab: true };
test("suggestions are versioned and owned by the currently selected session", () => {
  assert.deepEqual(getPromptSuggestion([widget(suggestion)], "session-a"), suggestion);
  assert.equal(getPromptSuggestion([widget(suggestion)], "session-b"), undefined);
  for (const data of [{ ...suggestion, version: 2 }, { ...suggestion, acceptTab: undefined }, { ...suggestion, text: "\x1b[31mbad" }, { ...suggestion, text: "x".repeat(241) }, { ...suggestion, id: "" }]) {
    assert.equal(getPromptSuggestion([widget(data)], "session-a"), undefined);
  }
  assert.equal(getPromptSuggestion([{ key: "next-prompt-suggestion", lines: ["not json"] }], "session-a"), undefined);
});
test("only an idle empty main composer without attachments or menus shows a suggestion", () => {
  const state = { suggestion, draftKey: "session-a", value: "", busy: false, attachments: 0, menuOpen: false };
  assert.equal(shouldShowPromptSuggestion(state), true);
  for (const change of [{draftKey: "session-b"}, {value: " "}, {busy: true}, {attachments: 1}, {menuOpen: true}, {dismissedId: suggestion.id}, {suggestion: undefined}]) {
    assert.equal(shouldShowPromptSuggestion({...state, ...change}), false);
  }
});
