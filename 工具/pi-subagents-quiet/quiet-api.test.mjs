import assert from 'node:assert/strict';
import test from 'node:test';
import { quietSubagentAPI } from './quiet-api.ts';
import registerNotify, { createCompletionSendRegistry } from '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/notify.js';

function fakeAPI() {
  const records = [], messages = [], handlers = new Map();
  const pi = {
    appendEntry: (type, data) => records.push({ type, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
    events: { on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } },
  };
  return { pi, records, messages };
}

test('actual notifier records completed, failed and paused results without a model wake', async () => {
  const f = fakeAPI();
  const notify = registerNotify(quietSubagentAPI(f.pi), {
    currentSessionId: 'quiet-test', completionOwnerId: 'owner',
  }, { batchConfig: { enabled: false }, sendRegistry: createCompletionSendRegistry() });
  try {
    for (const [i, state] of ['completed', 'failed', 'paused'].entries()) {
      const accepted = await notify.deliver({
        id: `quiet-${i}`, runId: `quiet-${i}`, agent: 'delegate', source: 'async',
        sessionId: 'quiet-test', completionOwnerId: 'owner', state,
        success: state === 'completed', exitCode: state === 'failed' ? 1 : 0,
        summary: state === 'paused' ? 'Paused after interrupt.' : `test-${state}`,
        timestamp: Date.now() + i,
      });
      assert.equal(accepted, true);
    }
    assert.equal(f.records.length, 3);
    assert.equal(f.messages.length, 0);
    assert.ok(f.records.every(r => r.type === 'local.pi.subagents.completion'));
    assert.ok(f.records.every(r => typeof r.data.content === 'string'));
  } finally { notify.dispose(); }
});

test('incremental and grouped completion content is retained', () => {
  const f = fakeAPI(), api = quietSubagentAPI(f.pi);
  for (const customType of ['subagent-notify', 'subagent-incremental-child-notify']) {
    api.sendMessage({ customType, content: 'two children completed', display: true }, { triggerTurn: true });
  }
  assert.equal(f.records.length, 2);
  assert.equal(f.messages.length, 0);
  assert.equal(f.records[1].data.originalType, 'subagent-incremental-child-notify');
});

test('supervisor asks and explicit wake subscriptions pass through unchanged', () => {
  const f = fakeAPI(), api = quietSubagentAPI(f.pi);
  const options = { triggerTurn: true };
  for (const customType of ['supervisor-request', 'subagent-wait-subscription', 'subagent-workflow-result-write-failed']) {
    const message = { customType, content: 'needs action', display: true };
    api.sendMessage(message, options);
    assert.equal(f.messages.at(-1).message, message);
    assert.equal(f.messages.at(-1).options, options);
  }
  assert.equal(f.records.length, 0);
});
