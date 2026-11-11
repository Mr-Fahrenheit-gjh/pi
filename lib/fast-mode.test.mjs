import assert from 'node:assert/strict';
import test from 'node:test';
import { readFastModeState, setFastMode } from './fast-mode.ts';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

function fixture(path = '/agent/extensions/codex-speed/index.ts') {
  const branch = [], calls = [];
  const ctx = { model: { provider: 'openai-codex', api: 'openai-codex-responses' }, isIdle: () => false };
  const session = {
    sessionManager: { getBranch: () => branch },
    extensionRunner: {
      getCommand: () => ({ sourceInfo: { path }, handler: async (arg, context) => {
        assert.equal(context, ctx);
        calls.push(arg);
        branch.push({ type: 'custom', customType: 'codex-speed-mode', data: { mode: { on: 'fast', off: 'standard', auto: 'auto' }[arg] } });
      } }),
      createCommandContext: () => ctx,
    },
    prompt() { assert.fail('must not prompt'); },
    abort() { assert.fail('must not abort'); },
  };
  return { session, branch, calls, ctx };
}

test('fixed Fast command works while busy and restores all three branch modes', async () => {
  const h = fixture();
  assert.deepEqual(readFastModeState(h.session), { available: true, supported: true, mode: 'auto' });
  for (const mode of ['fast', 'standard', 'auto']) assert.equal((await setFastMode(h.session, mode)).mode, mode);
  assert.deepEqual(h.calls, ['on', 'off', 'auto']);
  h.branch.push({ type: 'custom', customType: 'codex-speed-mode', data: { mode: 'ultrafast' } });
  assert.equal(readFastModeState(h.session).mode, 'standard');
  h.branch.length = 0;
  assert.equal(readFastModeState(h.session).mode, 'auto');
});

test('wrapper dispatch preserves the running extension request and reports the persisted branch state', async t => {
  const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
  const path = process.env.PI_WEB_CODEX_SPEED_EXTENSION
    ?? fileURLToPath(new URL('../../../pi-codex-speed/index.ts', import.meta.url));
  const speed = (await jiti.import(path)).default;
  const manager = SessionManager.inMemory('/tmp');
  const handlers = new Map(), commands = new Map();
  const ctx = { model: { provider: 'openai', api: 'openai-responses', id: 'gpt-fixture' },
    isIdle: () => false, hasUI: false, sessionManager: manager };
  speed({ on: (key, fn) => handlers.set(key, fn), registerCommand: (key, cmd) => commands.set(key, cmd),
    appendEntry: (key, data) => manager.appendCustomEntry(key, data) });
  handlers.get('session_start')({}, ctx);
  const inner = { sessionId: manager.getSessionId(), sessionManager: manager,
    isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    agent: { state: {} }, model: ctx.model,
    extensionRunner: { getCommand: key => ({ ...commands.get(key), sourceInfo: { path } }), createCommandContext: () => ctx },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    prompt() { assert.fail('must not prompt'); }, abort() { assert.fail('must not abort'); }, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const request = () => handlers.get('before_provider_request')({ payload: { model: 'gpt-fixture' } }, ctx);
  assert.equal(request().service_tier, 'default');
  const epoch = wrapper.taskContinuationEpoch;
  assert.equal((await wrapper.send({ type: 'set_fast_mode', mode: 'fast' })).mode, 'fast');
  assert.equal(wrapper.taskContinuationEpoch, epoch, 'Fast is not user steering');
  assert.equal(inner.isStreaming, true);
  assert.equal((await wrapper.send({ type: 'get_state' })).fastModeState.mode, 'fast');
  assert.equal(request().service_tier, 'priority');
});

test('rejects untrusted commands, unsupported adapters, missing plugins and arbitrary input', async () => {
  for (const path of ['/other/index.ts', '/pi-codex-speed/index.ts.evil', undefined]) {
    const h = fixture(path);
    if (path === undefined) h.session.extensionRunner.getCommand = () => undefined;
    await assert.rejects(setFastMode(h.session, 'fast'), /unavailable/);
    assert.deepEqual(h.calls, []);
  }
  const h = fixture('/workspace/pi-codex-speed/index.ts');
  await assert.rejects(setFastMode(h.session, '/fast on'), /Invalid/);
  h.ctx.model.api = 'openai-completions';
  await assert.rejects(setFastMode(h.session, 'fast'), /requires/);
  h.ctx.model.api = 'openai-codex-responses';
  h.session.extensionRunner.getCommand = () => ({ sourceInfo: { path: '/workspace/pi-codex-speed/index.ts' }, handler() {} });
  await assert.rejects(setFastMode(h.session, 'fast'), /refused/);
});
