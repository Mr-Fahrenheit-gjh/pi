import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./service-restart.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("service-restart.ts", source, ts.ScriptTarget.Latest, true);
const functions = file.statements.filter(ts.isFunctionDeclaration);
function harness(overrides = {}) {
  const state = { epoch: "original", pending: false, error: null };
  const timers = [];
  const calls = [];
  let nextAttempt = 0;
  const context = vm.createContext({ Request, URL, Set, process: { getuid: () => 501, cwd: () => "/tmp/web" },
    randomUUID: () => `attempt-${++nextAttempt}`,
    getAgentDir: () => "/tmp/agent",
    piMetaControl: async (_options, action) => action === "drain" ? { ok: true, available: false } : { ok: true, available: false, sessions: 0, terminals: 0 },
    shutdownPiMeta: async () => {},
    piMetaStartingOrUnresolved: () => false,
    serviceRestartState: () => state,
    supported: async () => true,
    restartBlockers: () => ({ sessions: 0, terminals: 0 }),
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {},
    execFile(...args) { calls.push(args); },
    ...overrides,
  });
  for (const name of ["isLocalServiceRequest", "launchdOwnsProcess", "requestServiceRestart", "acquireMetaDeploymentLease", "ownsMetaDeploymentLease", "commitMetaDeploymentLease", "cancelMetaDeploymentLease"]) {
    const declaration = functions.find((node) => node.name.text === name);
    const js = ts.transpileModule(declaration.getText(file).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInContext(js, context);
  }
  return { state, timers, calls, context };
}

test("restart is local, same-origin, formal-port only", () => {
  const { context: c } = harness();
  const req = (host, origin) => new Request(`http://${host}/api/service/restart`, { headers: { host, ...(origin ? { origin } : {}) } });
  assert.equal(c.isLocalServiceRequest(req("127.0.0.1:30141", "http://127.0.0.1:30141"), true), true);
  for (const [host, origin] of [["127.0.0.1:30158", "http://127.0.0.1:30158"], ["192.168.1.2:30141", "http://192.168.1.2:30141"], ["localhost:30141", "https://evil.example"], ["localhost:30141", null]]) {
    assert.equal(c.isLocalServiceRequest(req(host, origin), true), false);
  }
});

test("service ownership must match this process or its launchd parent", () => {
  const { context: c } = harness();
  assert.equal(c.launchdOwnsProcess("\tpid = 123\n", 456, 123), true);
  assert.equal(c.launchdOwnsProcess("\tpid = 456\n", 456, 123), true);
  assert.equal(c.launchdOwnsProcess("\tpid = 999\n", 456, 123), false);
  assert.equal(c.launchdOwnsProcess("no such service", 456, 123), false);
});

test("running sessions, terminals, unsupported instances and pending restart never launch", async () => {
  for (const blockers of [{ sessions: 1, terminals: 0 }, { sessions: 0, terminals: 1 }]) {
    const h = harness({ restartBlockers: () => blockers });
    assert.equal((await h.context.requestServiceRestart()).reason, "busy");
    assert.equal(h.calls.length, 0); assert.equal(h.timers.length, 0);
  }
  const unsupported = harness({ supported: async () => false });
  assert.equal((await unsupported.context.requestServiceRestart()).reason, "unsupported");
  assert.equal(unsupported.timers.length, 0);
  const pending = harness(); pending.state.pending = true;
  assert.equal((await pending.context.requestServiceRestart()).reason, "pending");
  assert.equal(pending.timers.length, 0);
});

test("confirmed idle restart drains new work, rechecks busy state and uses fixed launchctl args", async () => {
  let busy = false;
  const h = harness({ restartBlockers: () => ({ sessions: busy ? 1 : 0, terminals: 0 }) });
  assert.equal((await h.context.requestServiceRestart()).ok, true);
  assert.equal(h.state.pending, true);
  busy = true;
  await h.timers.find((timer) => timer.ms === 500).fn();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.pending, false);
  assert.equal(h.state.error, "busy");
  const success = harness();
  await success.context.requestServiceRestart();
  await success.timers.find((timer) => timer.ms === 500).fn();
  assert.equal(success.calls[0][0], "/bin/launchctl");
  assert.equal(JSON.stringify(success.calls[0][1]), JSON.stringify(["kickstart", "-k", "gui/501/cn.pi.web"]));
});

test("Pi Meta is drained and rechecked before restart; busy or unavailable workers fail closed", async () => {
  const actions = [];
  const busy = harness({ piMetaControl: async (_options, action) => { actions.push(action); return { ok: false, reason: "busy", available: true, sessions: 1, terminals: 0 }; } });
  assert.equal((await busy.context.requestServiceRestart()).reason, "busy");
  assert.deepEqual(actions, ["drain"]);
  assert.equal(busy.state.pending, false);
  assert.equal(busy.calls.length, 0);

  const unavailable = harness({ piMetaControl: async () => { throw new Error("offline"); } });
  assert.equal((await unavailable.context.requestServiceRestart()).reason, "busy");
  assert.equal(unavailable.state.pending, false);
  assert.equal(unavailable.calls.length, 0);

  const sequence = [];
  const ready = harness({ piMetaControl: async (_options, action) => {
    sequence.push(action);
    return { ok: true, available: true, pending: true, owned: true, sessions: 0, terminals: 0 };
  }, shutdownPiMeta: async () => { sequence.push("shutdown"); } });
  assert.equal((await ready.context.requestServiceRestart()).ok, true);
  await ready.timers.find((timer) => timer.ms === 500).fn();
  assert.deepEqual(sequence, ["drain", "status", "shutdown"]);
  assert.equal(ready.calls.length, 1);

  const changed = [];
  const raced = harness({ piMetaControl: async (_options, action) => {
    changed.push(action);
    return { ok: true, available: true, pending: true, owned: true, sessions: action === "status" ? 1 : 0, terminals: 0 };
  } });
  assert.equal((await raced.context.requestServiceRestart()).ok, true);
  await raced.timers.find((timer) => timer.ms === 500).fn();
  assert.deepEqual(changed, ["drain", "status", "resume"]);
  assert.equal(raced.calls.length, 0);
  assert.equal(raced.state.pending, false);
  assert.equal(raced.state.error, "busy");
});

test("deployment holds admission closed until its own lease is released", async () => {
  const actions = [];
  const h = harness({ piMetaControl: async (_options, action) => {
    actions.push(action);
    return { ok: true, available: true, pending: true, owned: true, sessions: 0, terminals: 0 };
  }, shutdownPiMeta: async () => { actions.push("shutdown"); } });
  const lease = await h.context.acquireMetaDeploymentLease();
  assert.equal(lease.ok, true);
  assert.equal(h.state.pending, true);
  assert.equal(h.context.ownsMetaDeploymentLease(lease.leaseId), true);
  assert.deepEqual(actions, ["drain", "shutdown"]);
  assert.equal((await h.context.acquireMetaDeploymentLease()).reason, "busy");
  lease.release();
  assert.equal(h.state.pending, false);
  assert.equal(h.context.ownsMetaDeploymentLease(lease.leaseId), false);
  lease.release();
});

test("committed deployment remains blocked on disconnect until safe cancellation", async () => {
  const h = harness();
  const lease = await h.context.acquireMetaDeploymentLease();
  assert.equal(h.context.commitMetaDeploymentLease("wrong"), false);
  assert.equal(h.context.commitMetaDeploymentLease(lease.leaseId), true);
  lease.release();
  assert.equal(h.state.pending, true);
  assert.equal(h.context.ownsMetaDeploymentLease(lease.leaseId), true);
  assert.equal(h.context.cancelMetaDeploymentLease("wrong"), false);
  assert.equal(h.context.cancelMetaDeploymentLease(lease.leaseId), true);
  assert.equal(h.state.pending, false);
});

test("deployment never shuts down a busy or unverified Meta worker", async () => {
  let shutdown = 0;
  const h = harness({ piMetaControl: async () => ({ ok: false, available: true, reason: "busy" }), shutdownPiMeta: async () => { shutdown++; } });
  assert.equal((await h.context.acquireMetaDeploymentLease()).reason, "busy");
  assert.equal(h.state.pending, false);
  assert.equal(shutdown, 0);
  const unknown = harness({ piMetaStartingOrUnresolved: () => true });
  assert.equal((await unknown.context.acquireMetaDeploymentLease()).reason, "busy");
  assert.equal(unknown.state.pending, false);
});

test("a timed-out restart cannot complete or overwrite a later attempt", async () => {
  let unblock, entered;
  const enteredShutdown = new Promise(resolve => { entered = resolve; });
  const waitForShutdown = new Promise(resolve => { unblock = resolve; });
  const leases = [];
  const h = harness({
    piMetaControl: async (_options, action, leaseId) => {
      leases.push({ action, leaseId });
      return { ok: true, available: true, pending: true, owned: true, sessions: 0, terminals: 0 };
    },
    shutdownPiMeta: async () => { entered(); await waitForShutdown; },
  });
  assert.equal((await h.context.requestServiceRestart()).ok, true);
  const first = h.timers.find(timer => timer.ms === 500).fn();
  await enteredShutdown;
  h.timers.find(timer => timer.ms === 12000).fn();
  assert.equal(h.state.pending, false);
  assert.equal((await h.context.requestServiceRestart()).ok, true);
  const secondId = h.state.attemptId;
  assert.notEqual(secondId, leases[0].leaseId);
  unblock();
  await first;
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.pending, true);
  assert.equal(h.state.attemptId, secondId);
});

test("a submitted restart never reopens admission on watchdog or ambiguous command failure", async () => {
  const h = harness();
  assert.equal((await h.context.requestServiceRestart()).ok, true);
  await h.timers.find(timer => timer.ms === 500).fn();
  assert.equal(h.calls.length, 1);
  h.timers.find(timer => timer.ms === 12000).fn();
  assert.equal(h.state.pending, true);
  h.calls[0][3](new Error("command outcome uncertain"));
  assert.equal(h.state.pending, true);
  assert.equal(h.state.error, "restart-failed");
});

test("a definite launchctl spawn failure restores normal admission", async () => {
  const h = harness();
  assert.equal((await h.context.requestServiceRestart()).ok, true);
  await h.timers.find((timer) => timer.ms === 500).fn();
  const error = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  h.calls[0][3](error);
  assert.equal(h.state.pending, false);
  assert.equal(h.state.error, "restart-failed");
});

test("RPC and PTY creation reject new work while restart drains", async () => {
  for (const file of ["rpc-manager.ts", "terminal-manager.ts"]) {
    const code = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(code, /assertServiceNotRestarting\(\)/);
  }
  const route = await readFile(new URL("../app/api/service/restart/route.ts", import.meta.url), "utf8");
  assert.match(route, /body\?\.confirmed !== true/);
  assert.match(route, /isLocalServiceRequest\(request, true\)/);
  assert.match(source, /__piStartLocks\?\.size/);
  assert.match(source, /hasActiveSessionWorkProvider/);
  assert.match(source, /getRestartBlockingRpcSessionIds/);
});
