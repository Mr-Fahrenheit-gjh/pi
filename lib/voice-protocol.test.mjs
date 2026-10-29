import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { VoiceTranscript, voiceContext, voiceFinalAnswer, commentaryChunks, audioExtension, VoiceOperationLedger } = await jiti.import("./voice-protocol.ts");
const entry = (role, content, stopReason) => ({ message: { role, content, stopReason } });

test("voice context excludes tools, thinking, custom and system payloads", () => {
  const context = voiceContext([entry("system", "hidden system"), entry("user", "hello"), entry("assistant", [
    { type: "thinking", thinking: "hidden reasoning" }, { type: "toolCall", arguments: "secret" }, { type: "text", text: "public" },
  ]), entry("toolResult", "secret output"), entry("custom", "hidden custom")]);
  assert.equal(context, "user: hello\nassistant: public");
  assert.ok(voiceContext([entry("user", "x".repeat(50_000))]).length <= 12_000);
});

test("only the exact final public answer after the owned user turn is returned", () => {
  const owned = [entry("user", "owned"), entry("assistant", [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Done" }], "stop")];
  assert.equal(voiceFinalAnswer(owned, "owned"), "Done");
  assert.equal(voiceFinalAnswer(owned, "another"), null);
  assert.equal(voiceFinalAnswer([...owned, entry("user", "keyboard"), entry("assistant", "other", "stop")], "owned"), null);
  assert.equal(voiceFinalAnswer([...owned, entry("custom", "notification"), entry("assistant", "other", "stop")], "owned"), null);
  assert.equal(voiceFinalAnswer([entry("user", "owned"), entry("assistant", "partial", "error")], "owned"), null);
});

test("transcript orders deltas, deduplicates IDs and selects only user speech up to delegation offset", () => {
  const transcript = new VoiceTranscript();
  const add = (id, delta, start, end, output = false) => transcript.add({ type: output ? "session.output_transcript.delta" : "session.input_transcript.delta", event_id: id, delta, start_ms: start, end_ms: end });
  add("b", "world", 10, 20); add("a", "hello ", 0, 10); add("a", "duplicate", 0, 10); add("c", "assistant secret", 5, 10, true); add("d", "later", 20, 30);
  assert.equal(transcript.task(-1, 20), "hello world");
  assert.equal(transcript.task(20, 30), "later");
  add("invalid", "bad", 30, -1);
  assert.equal(transcript.text("user"), "hello worldlater");
});

test("each commentary is conservatively below 500 tokens; actual MIME determines extension", () => {
  const text = "中文🙂 hello ".repeat(500);
  const chunks = commentaryChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((s) => new TextEncoder().encode(s).length <= 480));
  assert.equal(audioExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(audioExtension("audio/mp4"), "mp4");
  assert.equal(audioExtension("audio/ogg"), undefined);
});

test("delegation ledger claims once and fails closed at its bound", () => {
  const ledger = new VoiceOperationLedger(); let executions = 0;
  const create = () => ({ execution: ++executions });
  assert.equal(ledger.claim("same", create), ledger.claim("same", create));
  assert.equal(executions, 1);
  for (let i = 0; i < 39; i++) ledger.claim(String(i), create);
  assert.throws(() => ledger.claim("overflow", create), /operation-limit/);
});
