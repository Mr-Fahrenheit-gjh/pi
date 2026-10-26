import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildSessionContext } = await createJiti(import.meta.url).import("./session-reader.ts");
import { canContinueTask, buildTaskContinuationPrompt, TASK_CONTINUATION_REQUEST } from "./task-continuation.ts";

const user = { role: "user", content: "original task with private input" };
const assistant = (stopReason, content = []) => ({ role: "assistant", stopReason, content });
const entries = (messages) => messages.map((message, index) => ({ type: "message", id: `e${index}`, message }));
const checkpoint = (messages) => JSON.parse(buildTaskContinuationPrompt(entries(messages), "leaf").split("\n").at(-1));

test("offers manual continuation for interrupted or unfinished history, not completed work", () => {
  for (const reason of ["error", "aborted", "toolUse"]) assert.equal(canContinueTask([user, assistant(reason)]), true);
  for (const reason of ["stop", "length", "pending", "deferred", undefined]) assert.equal(canContinueTask([user, assistant(reason)]), false);
  assert.equal(canContinueTask([user]), true);
  assert.equal(canContinueTask([user, { role: "toolResult" }]), true);
  assert.equal(canContinueTask([]), false);
  assert.equal(canContinueTask([user, assistant("error"), { role: "bashExecution" }]), false);
  assert.equal(canContinueTask([user, assistant("stop"), { role: "custom" }, { role: "system" }]), false);
});

test("displayed branch summaries do not create new unfinished user turns", () => {
  for (const stopReason of ["stop", "aborted"]) {
    const history = entries([user, assistant(stopReason)]).map((entry, index) => ({
      ...entry, parentId: index ? "e0" : null, timestamp: "2026-01-01T00:00:00.000Z",
    }));
    history.push({
      type: "branch_summary", id: "summary", parentId: "e1",
      timestamp: "2026-01-01T00:00:01.000Z", fromId: "other", summary: "Branch explored",
    });
    const { messages } = buildSessionContext(history, "summary");
    assert.equal(messages.at(-1).role, "user");
    assert.equal(messages.at(-1).sourceEntryType, "branch_summary");
    assert.equal(canContinueTask(messages), stopReason === "aborted");
    assert.equal(canContinueTask(buildSessionContext(history, "summary", { tail: 1 }).messages), stopReason === "aborted");
    assert.equal(canContinueTask(buildSessionContext([history.at(-1)], "summary").messages), false);
  }
});

test("checkpoint distinguishes missing results from recorded errors and unverified results", () => {
  const messages = [user, assistant("toolUse", [
    { type: "toolCall", id: "missing", name: "send_message" },
    { type: "toolCall", id: "failed", name: "bash" },
    { type: "toolCall", toolCallId: "returned", toolName: "write" },
  ]),
  { role: "toolResult", toolCallId: "failed", isError: true },
  { role: "toolResult", toolCallId: "returned", isError: false }, assistant("error")];
  const result = checkpoint(messages);
  assert.deepEqual(result.recentToolObservations.map((item) => item.outcome), ["unknown", "error_recorded", "result_recorded_not_verified"]);
  assert.equal(result.inputEntryId, "e0");
  assert.equal(result.continuedFromLeafId, "leaf");
  assert.match(TASK_CONTINUATION_REQUEST, /UNKNOWN outcome/);
  assert.match(TASK_CONTINUATION_REQUEST, /existing permissions/);
});

test("bounded checkpoint never copies original requests, tool arguments/results, images or thinking", () => {
  const calls = Array.from({ length: 20 }, (_, index) => ({ type: "toolCall", id: `id-${index}`, name: "x".repeat(300), arguments: { password: "secret-args" } }));
  const messages = [user, assistant("toolUse", [...calls, { type: "thinking", thinking: "secret-thinking" }]),
    { role: "toolResult", toolCallId: "id-19", content: [{ type: "text", text: "secret-output" }, { type: "image", data: "secret-image" }] }, assistant("error")];
  const prompt = buildTaskContinuationPrompt(entries(messages), "leaf");
  assert.doesNotMatch(prompt, /private input|secret-/);
  assert.ok(prompt.length < 3000);
  const result = checkpoint(messages);
  assert.equal(result.observedToolCalls, 20);
  assert.equal(result.recentToolObservations.length, 6);
  assert.equal(result.recentToolObservations[0].callId, "id-14");
  assert.equal(result.recentToolObservations[0].tool.length, 80);
});

test("only the current input's tools enter the hint; no proof is invented for zero output", () => {
  const old = assistant("toolUse", [{ type: "toolCall", id: "old", name: "write" }]);
  const result = checkpoint([user, old, { role: "user", content: "new task" }, assistant("error")]);
  assert.equal(result.inputEntryId, "e2");
  assert.equal(result.observedToolCalls, 0);
  assert.deepEqual(result.recentToolObservations, []);
  assert.throws(() => buildTaskContinuationPrompt(entries([assistant("error")]), "leaf"), /no recorded user input/);
  assert.throws(() => buildTaskContinuationPrompt(entries([user, assistant("stop")]), "leaf"), /no interrupted task/);
});
