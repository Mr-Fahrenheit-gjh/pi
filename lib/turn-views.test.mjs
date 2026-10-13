import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getFinalAnswerViews, keepWrittenFiles } = await jiti.import("./turn-views.ts");

function finalAssistant() {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    usage: { input: 1, output: 2 },
    content: [
      { type: "thinking", thinking: "Plan" },
      { type: "toolCall", toolCallId: "t1", toolName: "write", input: { path: "a.txt" } },
      { type: "text", text: "Done." },
    ],
  };
}

test("splits a final assistant message into its process part and its answer", () => {
  const message = finalAssistant();
  const views = getFinalAnswerViews(new WeakMap(), message);

  assert.deepEqual(views.answer.content, [message.content[2]]);
  assert.deepEqual(views.answer.usage, message.usage);
  assert.equal(views.process.content, message.content, "deferred thinking retains the original content indices; MessageView filters at render time");
  assert.equal(views.process.usage, undefined);
  assert.notEqual(views.answer, message);
});

test("hands every render the same copies of an unchanged message, so MessageView's memo holds (#1005)", () => {
  const cache = new WeakMap();
  const message = finalAssistant();
  const first = getFinalAnswerViews(cache, message);
  const again = getFinalAnswerViews(cache, message);

  assert.equal(again, first);
  assert.equal(again.answer, first.answer);
  assert.equal(again.process, first.process);
  // A replaced message is a new object and gets its own copies.
  assert.notEqual(getFinalAnswerViews(cache, { ...message }).answer, first.answer);
});

test("keeps progress prose before tools visible without changing thinking indices", () => {
  const message = finalAssistant();
  message.content.unshift({ type: "text", text: "Checking the file." });
  const views = getFinalAnswerViews(new WeakMap(), message);
  assert.deepEqual(views.answer.content, [message.content[0], message.content[3]]);
  assert.equal(views.process.content[1], message.content[1]);
  assert.equal(views.process.usage, undefined);
});

test("retains error-only fetch failures as cached process views, without a standalone answer", () => {
  const cache = new WeakMap();
  for (const content of [[], [{ type: "text", text: "Visible partial reply" }]]) {
    const message = { ...finalAssistant(), content, stopReason: "error", errorMessage: "  FETCH FAILED  " };
    const views = getFinalAnswerViews(cache, message);
    assert.equal(views.hasProcess, true);
    assert.equal(views.process.errorMessage, message.errorMessage);
    assert.equal(views.process.content, content);
    assert.equal(views.process.stopReason, "error");
    assert.equal(views.process.usage, content.length ? undefined : message.usage);
    assert.equal(Boolean(views.answer), content.length > 0);
    if (views.answer) assert.deepEqual(views.answer.content, content);
    assert.equal(getFinalAnswerViews(cache, message), views);
  }
  for (const stopReason of ["error", "length"]) {
    const views = getFinalAnswerViews(cache, { ...finalAssistant(), content: [], stopReason, errorMessage: "403 forbidden" });
    assert.ok(views.answer, "important errors and truncation retain a visible view");
    assert.equal(views.hasProcess, false);
  }
  const success = getFinalAnswerViews(cache, { ...finalAssistant(), content: [{ type: "text", text: "Retry succeeded" }] });
  assert.equal(success.answer.content[0].text, "Retry succeeded");
  assert.equal(success.hasProcess, false);
});

test("keeps the written-files list while the turn wrote the same files", () => {
  const views = getFinalAnswerViews(new WeakMap(), finalAssistant());
  const first = keepWrittenFiles(views, [{ filePath: "/p/a.txt" }]);

  assert.equal(keepWrittenFiles(views, [{ filePath: "/p/a.txt" }]), first);
  const changed = [{ filePath: "/p/a.txt" }, { filePath: "/p/b.txt" }];
  assert.equal(keepWrittenFiles(views, changed), changed);
  assert.equal(keepWrittenFiles(views, []).length, 0);
});
