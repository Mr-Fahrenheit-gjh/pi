import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePiMetaControl } from "./pi-meta-control.mjs";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("drain refuses active work and synchronously closes admissions while idle", () => {
  const state = { epoch: "fixture", pending: false, error: null };
  assert.deepEqual(handlePiMetaControl(state, "drain", { sessions: 1, terminals: 0 }, A), { ok: false, reason: "busy", sessions: 1, terminals: 0 });
  assert.equal(state.pending, false);
  const ready = handlePiMetaControl(state, "drain", { sessions: 0, terminals: 0 }, A);
  assert.equal(ready.ok, true);
  assert.equal(state.pending, true);
  assert.equal(handlePiMetaControl(state, "status", { sessions: 0, terminals: 0 }, A).owned, true);
  assert.equal(handlePiMetaControl(state, "drain", { sessions: 0, terminals: 0 }, B).reason, "pending");
  assert.equal(handlePiMetaControl(state, "resume", { sessions: 0, terminals: 0 }, A).ok, true);
  assert.equal(state.pending, false);
});

test("committing shutdown cancels the watchdog and cannot reopen admissions", () => {
  const state = { epoch: "fixture", pending: false, error: null };
  assert.equal(handlePiMetaControl(state, "drain", { sessions: 0, terminals: 0 }, A).ok, true);
  assert.equal(handlePiMetaControl(state, "commit", { sessions: 0, terminals: 0 }, A).ok, true);
  assert.equal(state.pending, true);
  assert.equal(handlePiMetaControl(state, "status", { sessions: 0, terminals: 0 }, A).closing, true);
  assert.equal(handlePiMetaControl(state, "resume", { sessions: 0, terminals: 0 }, A).ok, false);
  assert.equal(state.pending, true);
});

test("an expired transaction cannot resume or commit a later drain", () => {
  const state = { epoch: "fixture", pending: false, error: null };
  assert.equal(handlePiMetaControl(state, "drain", { sessions: 0, terminals: 0 }, A).ok, true);
  assert.equal(handlePiMetaControl(state, "resume", { sessions: 0, terminals: 0 }, A).ok, true);
  assert.equal(handlePiMetaControl(state, "drain", { sessions: 0, terminals: 0 }, B).ok, true);
  assert.equal(handlePiMetaControl(state, "resume", { sessions: 0, terminals: 0 }, A).reason, "stale");
  assert.equal(handlePiMetaControl(state, "commit", { sessions: 0, terminals: 0 }, A).reason, "stale");
  assert.equal(handlePiMetaControl(state, "status", { sessions: 0, terminals: 0 }, B).owned, true);
  assert.equal(handlePiMetaControl(state, "resume", { sessions: 0, terminals: 0 }, B).ok, true);
});
