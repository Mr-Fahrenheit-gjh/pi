import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_TYPE, readState, saveState, recordStop, retrySpent, recordRetry, recoveryDecision } from './engine.mjs';

function manager(sessionId = 's1') {
  const entries = [];
  return { entries, getSessionId: () => sessionId, getBranch: () => entries,
    appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
}
function pending(overrides = {}) {
  return { version: 1, sessionId: 's1', runId: 'r1', status: 'pending', spent: 0,
    tools: [], admitted: true, waitingForInput: false, ownerPid: 12, ...overrides };
}
const options = { sessionId: 's1', currentPid: 34 };
test('unfinished model work resumes and reserves one attempt', () => {
  assert.deepEqual(recoveryDecision(pending(), options), { action: 'resume', spent: 1 });
});
test('three attempts are a durable limit, not reset by a process restart', () => {
  for (let spent = 0; spent < 3; spent++) assert.equal(recoveryDecision(pending({ spent }), options).spent, spent + 1);
  assert.equal(recoveryDecision(pending({ spent: 3 }), options).reason, 'retry-exhausted');
});
test('completed, cancelled and paused tasks never restart', () => {
  for (const status of ['done', 'cancelled', 'paused']) assert.equal(recoveryDecision(pending({ status }), options).action, 'none');
});
test('Stop is persisted even while no model request is running', () => {
  const m = manager(); saveState(m, pending()); recordStop(m);
  assert.equal(readState(m).status, 'cancelled');
  assert.equal(recoveryDecision(readState(m), options).action, 'none');
});
test('forks and other sessions do not inherit recovery authority', () => {
  const m = manager('fork'); saveState(m, pending());
  assert.equal(readState(m), undefined);
  assert.equal(recoveryDecision(pending(), { ...options, sessionId: 'fork' }).action, 'none');
});
test('a live owner prevents a second worker', () => {
  assert.equal(recoveryDecision(pending(), { ...options, ownerAlive: true }).reason, 'owner-alive');
});
test('unknown tool outcomes and interrupted confirmations pause safely', () => {
  assert.equal(recoveryDecision(pending({ tools: [{ id: 't', name: 'bash' }] }), options).reason, 'tool-outcome-unknown');
  assert.equal(recoveryDecision(pending({ waitingForInput: true }), options).reason, 'confirmation-interrupted');
});
test('an input that never committed is not guessed or regenerated', () => {
  assert.equal(recoveryDecision(pending({ admitted: false }), options).reason, 'input-not-committed');
});
test('committed final answers are not generated twice', () => {
  assert.equal(recoveryDecision(pending({ finalAnswerCommitted: true }), options).action, 'complete');
});
test('native retries and restart recoveries share one checkpoint', () => {
  const m = manager(); saveState(m, pending({ spent: 1 }));
  assert.equal(retrySpent(m), 1); recordRetry(m, 2);
  assert.equal(recoveryDecision(readState(m), options).spent, 3);
  recordRetry(m, 3); assert.equal(recoveryDecision(readState(m), options).action, 'pause');
});
test('latest branch checkpoint is authoritative', () => {
  const m = manager(); saveState(m, pending());
  m.entries.push({ type: 'custom', customType: 'unrelated', data: {} });
  saveState(m, pending({ status: 'done' }));
  assert.equal(readState(m).status, 'done');
});
test('invalid retry counters fail closed', () => {
  for (const spent of [NaN, -1, 1.5, undefined]) assert.equal(recoveryDecision(pending({ spent }), options).action, 'pause');
});
