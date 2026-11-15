import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from './index.ts';

function setup(branch = [], provider = 'openai-codex', api = 'openai-codex-responses') {
  const handlers = new Map(), commands = new Map(), notices = [], statuses = [];
  const ctx = {
    model: { provider, api, id: 'test-model', baseUrl: 'https://api.openai.com/v1' },
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
  const end = (overrides = {}) => emit('message_end', { message: {
    role: 'assistant', provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id,
    timestamp: 12345, stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 },
    ...overrides,
  } });
  const response = (response, type = 'response.completed') => emit('provider_stream_event', {
    provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id, data: { type, response },
  });
  const ledger = () => branch.filter(entry => entry.customType === 'openai-api-usage').map(entry => entry.data);
  return { ctx, emit, command, commands, request, complete, branch, notices, statuses, detail, end, response, ledger };
}

test('new OpenAI branches inherit the workbench service tier without overwriting it', () => {
  const h = setup([], 'openai', 'openai-responses');
  for (const tier of ['flex', 'ultrafast', 'priority', 'default']) {
    const payload = { model: 'test-model', service_tier: tier };
    assert.equal(h.request(payload).service_tier, tier);
    assert.equal(payload.service_tier, tier);
    assert.equal(h.statuses.at(-1), undefined);
  }
});

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

test('mid-request switches preserve the in-flight observation and affect the next request', async () => {
  const h = setup([], 'openai', 'openai-responses');
  h.ctx.isIdle = () => false;
  h.request({ model: 'test-model', service_tier: 'flex' });
  await h.command('fast', 'on');
  assert.equal(h.branch.at(-1).data.mode, 'fast');
  assert.match(await h.detail(), /待确认/);
  h.complete('flex');
  assert.match(await h.detail(), /服务端返回 flex/);
  assert.equal(h.request().service_tier, 'priority');
  await h.command('fast', 'off');
  h.complete('priority');
  assert.match(await h.detail(), /服务端已确认/);
  assert.equal(h.request().service_tier, 'default');
  await h.command('fast', 'auto');
  assert.equal(h.request({ model: 'test-model', service_tier: 'flex' }).service_tier, 'flex');
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

test('auto is persisted/restored; explicit off overrides catalog while old selections survive', async () => {
  const h = setup([], 'openai', 'openai-responses');
  const payload = { model: 'test-model', service_tier: 'flex' };
  for (const [command, tier] of [['on', 'priority'], ['off', 'default'], ['auto', 'flex']]) {
    await h.command('fast', command);
    assert.equal(h.request(payload).service_tier, tier);
    assert.equal(setup(h.branch, 'openai', 'openai-responses').request(payload).service_tier, tier);
  }
  assert.deepEqual(h.commands.get('fast').getArgumentCompletions('au'), [{ value: 'auto', label: 'auto' }]);
  h.branch.length = 0;
  h.emit('session_tree');
  assert.equal(h.request(payload).service_tier, 'flex');
  for (const [mode, tier] of [['fast', 'priority'], ['standard', 'default'], ['ultrafast', 'default']]) {
    const saved = [{ type: 'custom', customType: 'codex-speed-mode', data: { mode } }];
    assert.equal(setup(saved, 'openai', 'openai-responses').request(payload).service_tier, tier);
  }
  const codex = setup();
  await codex.command('fast', 'auto');
  assert.equal(codex.request(payload).service_tier, 'default');
});

test('inherited flex/ultrafast is never a confirmed Fast badge, nor a notification', async () => {
  const h = setup([], 'openai', 'openai-responses');
  for (const tier of ['flex', 'ultrafast']) {
    h.request({ model: 'test-model', service_tier: tier }); h.complete(tier);
    assert.equal(h.statuses.at(-1), undefined);
    const count = h.notices.length;
    assert.match(await h.detail(), new RegExp(`返回 ${tier}`));
    assert.equal(h.notices.length, count + 1);
    assert.doesNotMatch(h.notices.at(-1)[0], /服务端已确认/);
  }
});

function apiUsageSetup() {
  const h = setup([], 'openai', 'openai-responses');
  h.ctx.model.id = 'gpt-6-astra';
  h.ctx.model.cost = { input: 3, output: 7, cacheRead: 1, cacheWrite: 4 };
  h.ctx.model.compat = { supportsExplicitPromptCacheMode: true };
  const request = (payload = {}) => h.request({ model: 'gpt-6-astra', ...payload });
  return { ...h, request };
}

test('ledger uses actual tier, immutable request catalog, normalized usage and metadata only', () => {
  const h = apiUsageSetup();
  h.request({ service_tier: 'priority', prompt_cache_options: {mode:'auto',ttl:'12h'}, input: ['PRIVATE INPUT'] });
  h.ctx.model.cost.input = 999;
  h.response({ id: 'resp_one', service_tier: 'flex', output: ['PRIVATE OUTPUT'] });
  h.end({ responseId: 'resp_one', content: ['PRIVATE MESSAGE'], usage: {
    input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20,
    cost: { total: 999 }, reasoning: 2,
  } });
  assert.deepEqual(h.ledger(), [{
    version: 1, messageTimestamp: 12345, model: 'gpt-6-astra',
    requestedTier: 'priority', actualTier: 'flex', cacheTtl: '12h',
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 },
    estimatedCostUsd: 84 * 0.5 / 1e6, costStatus: 'estimated', pricingSource: 'catalog', responseId: 'resp_one',
  }]);
  assert.doesNotMatch(JSON.stringify(h.ledger()), /PRIVATE|content|reasoning/);
  h.end();
  assert.equal(h.ledger().length, 1);
});

test('mid-request Fast switch retains the original usage ledger and next request tier', async () => {
  const h = apiUsageSetup();
  h.ctx.isIdle = () => false;
  h.request({ service_tier: 'flex', prompt_cache_options: { mode: 'auto', ttl: '12h' } });
  await h.command('fast', 'on');
  h.response({ id: 'in_flight', service_tier: 'flex' });
  h.end({ responseId: 'in_flight' });
  assert.equal(h.ledger().length, 1);
  assert.equal(h.ledger()[0].requestedTier, 'flex');
  assert.equal(h.ledger()[0].actualTier, 'flex');
  assert.equal(h.ledger()[0].cacheTtl, '12h');
  assert.equal(h.request().service_tier, 'priority');
});

test('missing returned tier remains unknown, including after a previous confirmed request', () => {
  const h = apiUsageSetup();
  h.request({ service_tier: 'ultrafast' }); h.complete('ultrafast'); h.end();
  h.request(); h.complete(undefined); h.end({ timestamp: 12346 });
  assert.equal(h.ledger()[0].actualTier, 'ultrafast');
  assert.deepEqual(h.ledger()[1], {
    version: 1, messageTimestamp: 12346, model: 'gpt-6-astra',
    requestedTier: 'default', actualTier: null, cacheTtl: null,
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 },
    estimatedCostUsd: null, costStatus: 'unknown', reason: 'missing-service-tier', pricingSource: 'catalog',
  });
});

test('retries reset completion state both with payload hooks and response.created', () => {
  for (const retry of ['payload', 'created']) {
    const h = apiUsageSetup();
    h.request({ service_tier: 'priority' });
    h.response({ id: 'old', service_tier: 'priority' });
    if (retry === 'payload') h.request({ service_tier: 'flex' });
    h.response({ id: 'new' }, 'response.created');
    h.response({ id: 'old', service_tier: 'ultrafast' }); // stale completion
    h.end({ responseId: 'new' });
    assert.equal(h.ledger()[0].actualTier, null);
    assert.equal(h.ledger()[0].responseId, 'new');
    assert.equal(h.ledger()[0].estimatedCostUsd, null);
    assert.equal(h.ledger()[0].requestedTier, retry === 'payload' ? 'flex' : 'priority');
  }
});

test('modern cache options beat legacy retention, including an omitted TTL', () => {
  for (const [options,expected] of [[{mode:'auto',ttl:'12h'},'12h'],[{mode:'explicit'},null]]) {
    const h=apiUsageSetup();
    h.request({prompt_cache_options:options,prompt_cache_retention:'30m'});
    h.response({id:'modern',service_tier:'default'});h.end({responseId:'modern'});
    assert.equal(h.ledger()[0].cacheTtl,expected);
  }
});

test('mismatched response IDs never confirm the assistant result tier', () => {
  const h = apiUsageSetup();
  h.request({ service_tier: 'priority', prompt_cache_retention: '12h' });
  h.response({ id: 'old', service_tier: 'default' });
  h.end({ responseId: 'new' });
  assert.equal(h.ledger()[0].requestedTier, null);
  assert.equal(h.ledger()[0].cacheTtl, null);
  assert.equal(h.ledger()[0].actualTier, null);
  assert.equal(h.ledger()[0].responseId, 'new');
  assert.equal(h.ledger()[0].estimatedCostUsd, null);
});

test('errors/aborts without usage are skipped and clear request state; partial usage is unknown', () => {
  for (const stopReason of ['error', 'aborted']) {
    const h = apiUsageSetup();
    h.request(); h.complete('default');
    h.end({ stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
    h.end();
    assert.equal(h.ledger().length, 0);
    h.request({ service_tier: 'flex' });
    h.end({ stopReason });
    assert.equal(h.ledger().length, 1);
    assert.equal(h.ledger()[0].actualTier, null);
    assert.equal(h.ledger()[0].estimatedCostUsd, null);
  }
});

test('only real assistant usage is recorded; no messages, timestamps, or usage are synthesized', () => {
  for (const overrides of [{ role: 'user' }, { role: 'toolResult' }, { usage: undefined },
    { timestamp: undefined }, { usage: { input: 1 } },
    { usage: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 } }]) {
    const h = apiUsageSetup(); h.request(); h.complete('default'); h.end(overrides);
    assert.equal(h.ledger().length, 0);
  }
});

test('model/session changes discard pending metadata and unrelated events cannot inject it', () => {
  for (const lifecycle of ['model_select', 'session_tree', 'session_start']) {
    const h = apiUsageSetup(); h.request(); h.complete('priority'); h.emit(lifecycle); h.end();
    assert.equal(h.ledger().length, 0);
    h.request();
    for (const event of [
      { provider: 'custom', api: 'openai-responses', model: 'gpt-6-astra' },
      { provider: 'openai', api: 'openai-completions', model: 'gpt-6-astra' },
      { provider: 'openai', api: 'openai-responses', model: 'other-model' },
    ]) h.emit('provider_stream_event', { ...event, data: { type: 'response.completed', response: { service_tier: 'ultrafast' } } });
    h.end();
    assert.equal(h.ledger()[0].actualTier, null);
  }
});

test('Codex, unsupported providers/APIs, and foreign model requests never write API ledger', () => {
  for (const [provider, api] of [['openai-codex', 'openai-codex-responses'],
    ['custom', 'openai-responses'], ['openai', 'openai-completions']]) {
    const h = setup([], provider, api); h.request(); h.complete('default'); h.end();
    assert.equal(h.ledger().length, 0);
  }
  const h = apiUsageSetup();
  h.request({ model: 'foreign' }); h.complete('default'); h.end();
  assert.equal(h.ledger().length, 0);
});

test('headless API ledger does not need UI and does not alter historical entries', () => {
  const h = apiUsageSetup();
  const historical = { type: 'custom', customType: 'openai-api-usage', data: { version: 0, old: true } };
  h.branch.push(historical);
  h.ctx.hasUI = false; h.ctx.ui = undefined;
  h.request(); h.complete('default'); h.end();
  assert.equal(h.branch[0], historical);
  assert.deepEqual(h.branch[0].data, { version: 0, old: true });
  assert.equal(h.ledger().length, 2);
});

test('headless hooks do not require UI', () => {
  const h = setup();
  h.ctx.hasUI = false;
  h.ctx.ui = undefined;
  h.emit('session_start');
  assert.equal(h.request().service_tier, 'default');
  h.complete('priority');
});
