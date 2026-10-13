import assert from "node:assert/strict";
import test from "node:test";
import {
  fleetCanResume, fleetCommand, fleetReadableDetails, fleetRequest, fleetRunId,
  fleetState, fleetStateLabel, fleetUrl, normalizeFleetView,
} from "./subagent-fleet-view.ts";

const id = "aa470515-756d-4326-84a7-981447987f46";

test("projects installed v1 snapshot; child and host identifiers are display-only", () => {
  const view = normalizeFleetView({ available: true, asyncSnapshot: {
    runs: [{ id, kind: "workflow", label: "计划", state: "running", activity: { currentTool: "read" },
      children: [{ id: "stage-a", kind: "step", label: "检查", state: "complete" },
        { id: "host-a", kind: "host-step", state: "running" }] }],
    omitted: { runs: 2, children: 3 },
  } });
  assert.equal(view.runs[0].id, id);
  assert.equal(view.runs[0].activity, "read");
  assert.equal(view.runs[0].children[0].id, undefined);
  assert.equal(view.runs[0].children[1].id, undefined);
  assert.deepEqual(view.runs[0].metrics, []);
  assert.equal(view.active, true);
  assert.equal(view.omittedRuns, 2);
  assert.equal(view.omittedChildren, 3);
});

test("never resolves opaque fleet keys, even if an entry supplies id", () => {
  const view = normalizeFleetView({ available: true, fleet: {
    entries: [{ key: id, id, agent: "explore", role: "侦察", model: "model-x", tokens: { total: 0, input: 0 }, cost: 0 }],
    totalActive: 4, omitted: 3,
  } });
  assert.equal(view.fleet[0].id, undefined);
  assert.equal(view.fleet[0].role, "侦察");
  assert.equal(view.fleet[0].model, "model-x");
  assert.deepEqual(view.fleet[0].metrics, [{ label: "Tokens", value: 0 }, { label: "输入", value: 0 }, { label: "费用（USD）", value: 0 }]);
  assert.equal(view.active, true);
  assert.equal(view.omitted, 3);
});

test("unknown/malformed fields fail softly, duplicate ids collapse, metrics must exist", () => {
  for (const value of [null, undefined, 42, [], { asyncSnapshot: { runs: "bad" } }]) {
    assert.deepEqual(normalizeFleetView(value).runs, []);
  }
  const view = normalizeFleetView({ available: true, asyncSnapshot: { runs: [null, [],
    { id, state: "pending", newField: {} }, { id, state: "complete" },
    { id: "../bad", state: "future-state", tokens: { total: NaN, input: -1 }, cost: Infinity },
    { id: "fleet-1" }, { id: "step-x", kind: "step" },
  ] } });
  assert.equal(view.runs.length, 4);
  assert.equal(view.runs[0].state, "queued");
  assert.equal(view.runs[1].id, undefined);
  assert.equal(view.runs[2].id, undefined);
  assert.equal(view.runs[3].id, undefined);
  assert.deepEqual(view.runs[1].metrics, []);
  assert.equal(fleetStateLabel("future-state"), "future-state");
  assert.equal(fleetStateLabel("__proto__"), "__proto__");
  assert.equal(fleetState("__proto__"), "__proto__");
});

test("bounds cyclic child data and detects active descendants", () => {
  const run = { id, state: "complete", children: [{ state: "running" }] };
  run.children.push(run);
  const view = normalizeFleetView({ available: true, asyncSnapshot: { runs: [run] } });
  assert.equal(view.active, true);
  assert.equal(view.runs[0].children[1].id, undefined);
});

test("control ids are safe, paths/synthetic labels rejected; states govern resume", () => {
  assert.equal(fleetRunId(id), id);
  assert.equal(fleetRunId("run_123"), "run_123");
  assert.equal(fleetRunId("x".repeat(128)), "x".repeat(128));
  assert.equal(fleetRunId("x".repeat(129)), undefined);
  for (const value of ["", "async", "fleet-1", "step:0", "nested:1", "../x", "x/y", "x…", " x", "x\n", {}, "x".repeat(161)]) {
    assert.equal(fleetRunId(value), undefined);
  }
  assert.equal(fleetCanResume("paused"), true);
  assert.equal(fleetCanResume("stopped"), false);
  assert.equal(fleetCanResume("interrupted"), false);
  assert.equal(fleetCanResume("running"), false);
  assert.equal(fleetCanResume("unknown"), false);
});

test("exact API URLs and command payloads; messages required for steer/resume", () => {
  assert.equal(fleetUrl("session /?"), "/api/agent/session%20%2F%3F/subagents");
  const url = new URL(fleetUrl("session", id), "http://localhost");
  assert.equal(url.searchParams.get("id"), id);
  assert.equal(url.searchParams.get("view"), "transcript");
  assert.equal(url.searchParams.get("lines"), "100");
  assert.deepEqual(fleetCommand("stop", id, "ignored"), { method: "stop", params: { id } });
  assert.deepEqual(fleetCommand("interrupt", id), { method: "interrupt", params: { id } });
  assert.deepEqual(fleetCommand("resume", id, "  继续  "), { method: "resume", params: { id, message: "继续" } });
  assert.deepEqual(fleetCommand("steer", id, "检查", "follow_up"), { method: "steer", params: { id, message: "检查", mode: "follow_up" } });
  assert.throws(() => fleetCommand("steer", id, " "), /填写消息/);
  assert.throws(() => fleetCommand("resume", id), /填写消息/);
  assert.throws(() => fleetCommand("stop", "fleet-1"), /无效/);
  assert.throws(() => fleetUrl("session", "../bad"), /无效/);
});

test("records remain plain text, including HTML and structured unknown details", () => {
  assert.equal(fleetReadableDetails("<script>bad()</script>"), "<script>bad()</script>");
  assert.equal(fleetReadableDetails({ result: "完成" }), '{\n  "result": "完成"\n}');
  assert.equal(fleetReadableDetails(undefined), "");
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(fleetReadableDetails(cyclic), "记录无法显示");
});

test("fetch passes abort signal, POST returns RPC data, HTTP/RPC errors surface", async (t) => {
  const controller = new AbortController();
  const data = { text: "accepted", details: { state: "running" } };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, fleetUrl("s"));
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, "no-store");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), fleetCommand("stop", id));
    return Response.json(data);
  });
  assert.deepEqual(await fleetRequest(fleetUrl("s"), controller.signal, fleetCommand("stop", id)), data);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(fleetRequest("/test", controller.signal), /unavailable/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ success: false, error: { message: "invalid state" } }));
  await assert.rejects(fleetRequest("/test", controller.signal), /invalid state/);
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    options.signal.throwIfAborted();
    return Response.json({});
  });
  controller.abort();
  await assert.rejects(fleetRequest("/test", controller.signal), { name: "AbortError" });
});
