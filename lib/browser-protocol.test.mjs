import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { parseBrowserCommand, isBrowserId } = await createJiti(import.meta.url).import("./browser-protocol.ts");
test("browser input is a bounded command allowlist, not a CDP/JavaScript endpoint", () => {
  for (const input of [{ type: "Runtime.evaluate", expression: "process.exit()" }, { type: "navigate", url: "file:///etc/passwd" }, { type: "navigate", url: "javascript:alert(1)" }, { type: "navigate", url: "https://user:pass@example.com" }, { type: "resize", width: 999999, height: 1 }, { type: "text", text: "a".repeat(65537) }, { type: "mouse", x: Infinity }, { type: "key", modifiers: 255 }, null]) assert.equal(parseBrowserCommand(input), null);
  assert.deepEqual(parseBrowserCommand({ type: "navigate", url: "example.com", dangerous: "ignored" }), { type: "navigate", url: "http://example.com/" });
  assert.equal(isBrowserId("a".repeat(32)), true); assert.equal(isBrowserId("../../etc/passwd"), false);
});
test("Unicode input and ordinary browser history commands are supported", () => {
  assert.deepEqual(parseBrowserCommand({ type: "text", text: "中文🙂" }), { type: "text", text: "中文🙂" });
  for (const type of ["back", "forward", "reload", "copy"]) assert.deepEqual(parseBrowserCommand({ type }), { type });
});
