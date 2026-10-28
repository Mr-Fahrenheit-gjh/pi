import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from './index.ts';

function setup(branch = [], provider = 'openai-codex', api = 'openai-codex-responses') {
  const handlers = new Map(), commands = new Map(), notices = [], statuses = [];
  const ctx = {
    model: { provider, api, id: 'test-model' },
    hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: { setStatus: (_key, value) => statuses.push(value), notify: (...args) => notices.push(args) },
  };
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
  });
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  const command = (name, arg = '') => commands.get(name).handler(arg, ctx);
  const request = (payload = { model: 'test-model', input: [], reasoning: { effort: 'high' } }) =>
    emit('before_provider_request', { payload });
  const complete = tier => emit('provider_stream_event', {
    provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id,
    data: { type: 'response.completed', response: tier === undefined ? {} : { service_tier: tier } },
  });
  emit('session_start');
  const detail = async () => { await command('fast', 'status'); return notices.at(-1)[0]; };
  return { ctx, emit, command, commands, request, complete, branch, notices, statuses, detail };
}

test('standard default, fast priority mapping, no mutation of input/thinking', async () => {
  const h = setup();
  assert.equal(h.request().service_tier, 'default');
  await h.command('fast', 'on');
  const payload = { model: 'test-model', input: ['hello'], reasoning: { effort: 'high' } };
  const result = h.request(payload);
  assert.equal(result.service_tier, 'priority');
  assert.equal(payload.service_tier, undefined);
  assert.equal(result.input, payload.input);
  assert.deepEqual(result.reasoning, { effort: 'high' });
  assert.equal(h.statuses.at(-1), 'Codex fast');
  assert.match(await h.detail(), /待确认/);
  h.complete('priority');
  assert.equal(h.statuses.at(-1), 'Codex fast');
  assert.match(await h.detail(), /已确认/);
});

test('only fast command; toggle/off work, ultrafast is rejected and not suggested', async () => {
  const h = setup();
  assert.deepEqual([...h.commands.keys()], ['fast']);
  assert.equal(h.commands.get('fast').getArgumentCompletions('ultra'), null);
  assert.equal(h.statuses.at(-1), undefined);
  await h.command('fast');
  assert.equal(h.request().service_tier, 'priority');
  for (const arg of ['status', 'bad', 'ultrafast']) await h.command('fast', arg);
  assert.equal(h.request().service_tier, 'priority');
  await h.command('fast');
  assert.equal(h.request().service_tier, 'default');
  assert.equal(h.statuses.at(-1), undefined);
  await h.command('fast', 'on');
  await h.command('fast', 'off');
  assert.equal(h.request().service_tier, 'default');
});

test('old ultrafast session selection restores to standard, not earlier fast', () => {
  const h = setup(['fast', 'ultrafast'].map(mode => ({type:'custom',customType:'codex-speed-mode',data:{mode}})));
  assert.equal(h.request().service_tier, 'default');
  assert.equal(h.statuses.at(-1), undefined);
});

test('hide badge for unsupported provider/API pairs without losing selection', async () => {
  const h = setup();
  await h.command('fast', 'on');
  h.ctx.model.provider = 'openai';
  h.emit('model_select');
  assert.equal(h.statuses.at(-1), undefined);
  h.ctx.model.provider = 'openai-codex';
  h.emit('model_select');
  assert.equal(h.statuses.at(-1), 'Codex fast');
});

test('scope: other providers, APIs, models, malformed payloads are untouched', async () => {
  const h = setup();
  for (const payload of [null, [], 'x', {}, { model: 'different-model' }]) {
    assert.equal(h.request(payload), undefined);
  }
  h.ctx.model.provider = 'openai';
  await h.command('fast', 'on');
  assert.equal(h.branch.length, 0);
  assert.equal(h.request(), undefined);
  h.ctx.model.provider = 'openai-codex';
  h.ctx.model.api = 'openai-responses';
  assert.equal(h.request(), undefined);
});

test('restore branch state on reload/tree; new sessions default standard', async () => {
  const h = setup();
  await h.command('fast', 'on');
  assert.equal(setup(h.branch).request().service_tier, 'priority');
  assert.equal(setup().request().service_tier, 'default');
  h.branch.length = 0;
  h.emit('session_tree');
  assert.equal(h.request().service_tier, 'default');
  h.branch.push({ type: 'custom', customType: 'codex-speed-mode', data: { mode: 'garbage' } });
  h.emit('session_start');
  assert.equal(h.request().service_tier, 'default');
});

test('fast default response is ambiguous, not a rejection or confirmation', async () => {
  const h = setup();
  await h.command('fast', 'on');
  h.request();
  const noticesBefore = h.notices.length;
  h.complete('default');
  assert.equal(h.statuses.at(-1), 'Codex fast');
  assert.equal(h.notices.length, noticesBefore);
  assert.match(await h.detail(), /生效未知/);
});

test('server mismatch, missing tier and error never claim confirmed', async () => {
  const h = setup();
  await h.command('fast', 'on');
  h.request(); h.complete('flex');
  assert.match(await h.detail(), /返回 flex/);
  h.request(); h.complete(undefined);
  assert.match(await h.detail(), /未报告/);
  h.request(); h.complete('\x1b[31muntrusted');
  assert.match(await h.detail(), /未知档位/);
  h.emit('message_end', { message: { role: 'assistant', provider: 'openai-codex', model: 'test-model', stopReason: 'error' } });
  assert.match(await h.detail(), /请求失败/);
  assert.equal(h.statuses.at(-1), 'Codex fast');
});

test('ignore unrelated stream events and reset verification on model switch', async () => {
  const h = setup();
  h.request();
  h.emit('provider_stream_event', { provider: 'openai', api: 'openai-responses', model: 'test-model', data: { type: 'response.completed', response: { service_tier: 'default' } } });
  assert.match(await h.detail(), /待确认/);
  h.complete('default');
  assert.match(await h.detail(), /已确认/);
  h.emit('model_select');
  assert.match(await h.detail(), /未发送/);
  h.complete('default');
  assert.match(await h.detail(), /未发送/);
});

test('reject changes during active request', async () => {
  const h = setup();
  h.ctx.isIdle = () => false;
  await h.command('fast', 'on');
  assert.equal(h.branch.length, 0);
  assert.equal(h.request().service_tier, 'default');
});

test('OpenAI Responses supports toggle, aliases, fallback, errors and restore', async () => {
  const h = setup([], 'openai', 'openai-responses');
  assert.equal(h.request().service_tier, 'default');
  await h.command('fast', 'on');
  assert.equal(h.statuses.at(-1), 'OpenAI fast');
  assert.equal(h.request().service_tier, 'priority');
  for (const tier of ['fast', 'priority']) {
    h.complete(tier);
    assert.match(await h.detail(), /已确认/);
  }
  const noticesBefore = h.notices.length;
  h.complete('default');
  assert.equal(h.notices.length, noticesBefore);
  assert.match(await h.detail(), /返回 default/);
  assert.doesNotMatch(await h.detail(), /服务端已确认/);
  h.complete(undefined);
  assert.match(await h.detail(), /未报告/);
  h.emit('message_end', { message: { role: 'assistant', provider: 'openai', model: 'test-model', stopReason: 'error' } });
  assert.match(await h.detail(), /请求失败/);
  assert.equal(setup(h.branch, 'openai', 'openai-responses').request().service_tier, 'priority');
  await h.command('fast', 'off');
  assert.equal(h.request().service_tier, 'default');
  assert.equal(h.statuses.at(-1), undefined);
});

test('switch between supported providers resets confirmation and ignores stale events', async () => {
  const h = setup();
  await h.command('fast', 'on');
  h.request(); h.complete('priority');
  h.ctx.model = { provider: 'openai', api: 'openai-responses', id: 'test-model' };
  h.emit('model_select');
  assert.equal(h.statuses.at(-1), 'OpenAI fast');
  assert.match(await h.detail(), /未发送/);
  h.request();
  h.emit('provider_stream_event', {
    provider: 'openai-codex', api: 'openai-codex-responses', model: 'test-model',
    data: { type: 'response.completed', response: { service_tier: 'priority' } },
  });
  assert.match(await h.detail(), /待确认/);
  h.complete('fast');
  assert.match(await h.detail(), /已确认/);
});

test('unsupported providers and Chat Completions stay untouched', async () => {
  for (const [provider, api] of [['custom', 'openai-responses'], ['openai', 'openai-completions']]) {
    const h = setup([], provider, api);
    await h.command('fast', 'on');
    assert.equal(h.branch.length, 0);
    assert.equal(h.request(), undefined);
  }
});

test('toggles and tier mismatches stay quiet; details remain available', async () => {
  for (const [provider, api] of [['openai', 'openai-responses'], ['openai-codex', 'openai-codex-responses']]) {
    const h = setup([], provider, api);
    await h.command('fast', 'on');
    h.request(); h.complete('flex');
    assert.equal(h.notices.length, 0);
    assert.match(await h.detail(), /返回 flex/);
    const count = h.notices.length;
    await h.command('fast', 'off');
    assert.equal(h.notices.length, count);
    assert.equal(h.statuses.at(-1), undefined);
  }
});

test('headless hooks do not require UI', () => {
  const h = setup();
  h.ctx.hasUI = false;
  h.ctx.ui = undefined;
  h.emit('session_start');
  assert.equal(h.request().service_tier, 'default');
  h.complete('priority');
});
