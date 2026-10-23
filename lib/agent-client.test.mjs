import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("only Pi user submissions carry the diagram preference without changing their text", async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  });
  let stored = null;
  globalThis.window = { location: { pathname: "/" }, localStorage: { getItem: () => stored } };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, command: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, data: {} }));
  };
  for (const enabled of [true, false]) {
    stored = enabled ? null : "false";
    for (const type of ["prompt", "steer", "follow_up"]) {
      const command = { type, message: "Keep this exact user text." };
      await sendAgentCommand("session-id", command);
      assert.deepEqual(requests.at(-1).command, { ...command, inlineVisuals: enabled });
      assert.equal(Object.hasOwn(command, "inlineVisuals"), false);
    }
  }
  await sendAgentCommand("session-id", { type: "get_state" });
  assert.deepEqual(requests.at(-1).command, { type: "get_state" });
  globalThis.window.location.pathname = "/feynman";
  await sendAgentCommand("session-id", { type: "prompt", message: "plain" });
  assert.equal(requests.at(-1).url, "/api/runtime/feynman/agent/session-id");
  assert.deepEqual(requests.at(-1).command, { type: "prompt", message: "plain" });
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});
