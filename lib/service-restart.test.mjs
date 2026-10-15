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
  const context = vm.createContext({ Request, URL, Set, process: { getuid: () => 501 },
    serviceRestartState: () => state,
    supported: async () => true,
    restartBlockers: () => ({ sessions: 0, terminals: 0 }),
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {},
    execFile(...args) { calls.push(args.slice(0, 3)); },
    ...overrides,
  });
  for (const name of ["isLocalServiceRequest", "launchdOwnsProcess", "requestServiceRestart"]) {
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
  h.timers.find((timer) => timer.ms === 500).fn();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.pending, false);
  assert.equal(h.state.error, "busy");
  const success = harness();
  await success.context.requestServiceRestart();
  success.timers.find((timer) => timer.ms === 500).fn();
  assert.equal(success.calls[0][0], "/bin/launchctl");
  assert.equal(JSON.stringify(success.calls[0][1]), JSON.stringify(["kickstart", "-k", "gui/501/cn.pi.web"]));
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
