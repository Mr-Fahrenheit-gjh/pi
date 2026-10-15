import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { serviceRestartState } = await jiti.import("./service-restart-state.ts");
const { acquireSessionLivenessLease, hasActiveSessionLivenessProvider, hasActiveSessionWorkProvider, registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function waitingWrapper(wait) {
  const wrapper = Object.create(AgentSessionWrapper.prototype);
  Object.assign(wrapper, {
    _alive: true, closing: false, activeMutatingCommands: 0, pendingPromptCount: 0,
    sessionReplacement: null, inner: { sessionManager: { getCwd: () => process.cwd() }, isStreaming: false, isCompacting: false, isBashRunning: false },
    resetIdleTimer() {}, shouldWaitForExtensions: () => true, waitForExtensionsBound: wait,
  });
  return wrapper;
}

test("extension and prompt-admission waits block restarting and recheck draining", async (t) => {
  const state = serviceRestartState();
  t.after(() => { state.pending = false; });
  for (const phase of ["extensions", "admission"]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const wrapper = waitingWrapper(phase === "extensions" ? () => gate : async () => {});
    wrapper.acquirePromptAdmission = () => gate;
    const prompt = wrapper.send({ type: "prompt", message: "race" });
    await nextTurn();
    assert.equal(wrapper.isBusyForRestart(), true, `${phase} must count as work`);
    state.pending = true;
    release(() => {});
    await assert.rejects(prompt, /Pi Web is restarting/);
    state.pending = false;
    assert.equal(wrapper.activeMutatingCommands, 0);
  }
});

test("compact and other work-starting commands cannot bypass draining", async (t) => {
  const state = serviceRestartState(); state.pending = true;
  t.after(() => { state.pending = false; });
  const wrapper = waitingWrapper(async () => {});
  for (const type of ["compact", "prompt", "bash", "reload", "steer", "follow_up", "navigate_tree", "clone"]) {
    await assert.rejects(wrapper.send({ type }), /Pi Web is restarting/);
  }
  assert.equal(wrapper.activeMutatingCommands, 0);
});

test("idle selected-browser leases do not block restart; extension work still does", () => {
  const id = "restart-idle-browser-test";
  const lease = acquireSessionLivenessLease(id);
  try {
    assert.equal(hasActiveSessionLivenessProvider({ sessionId: id }), true);
    assert.equal(hasActiveSessionWorkProvider({ sessionId: id }), false);
    const release = registerSessionLivenessProvider({ name: "subagent-task", sessionId: id, isActive: () => true });
    try { assert.equal(hasActiveSessionWorkProvider({ sessionId: id }), true); }
    finally { release(); }
    assert.equal(hasActiveSessionWorkProvider({ sessionId: id }), false);
  } finally { lease.release(); }
});
