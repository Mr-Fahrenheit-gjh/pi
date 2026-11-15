import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Register the current adapter, not the historical pi-memory-local plugin.
// No hooks are emitted; every execute below uses a synthetic config/token and fetch stub.
const sdk = '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent';
const require = createRequire(`${sdk}/package.json`);
const { createJiti } = require('jiti');
const load = createJiti(import.meta.url, { alias: { '@earendil-works/pi-ai': path.resolve(sdk, '../pi-ai/dist/index.js') }, moduleCache: false, fsCache: false });
const memory = await load.import('../../../工具/hy-memory迁移/index.ts');
const tools = new Map();
memory.default({ registerTool: tool => tools.set(tool.name, tool), on() {} });
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');

test('current Hy-Memory registers exactly six tools and the current schemas', () => {
  const properties = {
    memory_write: ['content', 'scope', 'target'],
    memory_search: ['limit', 'query', 'scope'],
    memory_read: ['memory_id', 'offset', 'scope', 'source'],
    memory_update: ['content', 'memory_id', 'scope'],
    memory_delete: ['memory_id', 'scope'],
    memory_status: ['request_id'],
  };
  assert.deepEqual([...tools.keys()].sort(), Object.keys(properties).sort());
  for (const [name, keys] of Object.entries(properties)) assert.deepEqual(Object.keys(tools.get(name).parameters.properties).sort(), keys, name);
  const schema = tools.get('memory_write').parameters;
  assert.deepEqual(schema.required, ['content']);
  assert.equal(schema.properties.content.maxLength, 12000);
  assert.deepEqual(schema.properties.target.anyOf.map(item => item.const), ['long_term', 'daily']);
  assert.deepEqual(schema.properties.scope.anyOf.map(item => item.const), ['global', 'project']);
  const write = tools.get('memory_write').description;
  assert.match(write, /成功代表已落盘回读，不是排队/);
  const append = read('./APPEND_SYSTEM.md');
  assert.match(append, /Hy-Memory 六工具/);
  assert.match(append, /`content \/ target \/ scope`/);
  assert.match(append, /同步落盘回读，不是排队/);
  assert.match(append, /memory_status.*不要重发写操作/);
  assert.doesNotMatch(append, /回复后静默保存|timing:\s*now/);
});

test('synthetic completed receipt is awaited; queued/lost writes require status, never an automatic retry', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hy-memory-contract-'));
  const originalConfig = process.env.PI_HY_MEMORY_CONFIG;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.PI_HY_MEMORY_CONFIG;
    else process.env.PI_HY_MEMORY_CONFIG = originalConfig;
    rmSync(dir, { recursive: true, force: true });
  });
  const tokenFile = path.join(dir, 'synthetic-token');
  writeFileSync(tokenFile, 'fixture-not-a-credential');
  process.env.PI_HY_MEMORY_CONFIG = path.join(dir, 'config.json');
  writeFileSync(process.env.PI_HY_MEMORY_CONFIG, JSON.stringify({ baseUrl: 'http://127.0.0.1:30148', tokenFile }));
  const requests = [];
  let respond;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Promise(resolve => { respond = value => resolve({ ok: true, json: async () => value }); });
  };
  const ctx = { cwd: '/synthetic/project', sessionManager: { getSessionId: () => 'fixture-session' } };
  const call = (name, args, id = 'fixture-call') => tools.get(name).execute(id, args, undefined, undefined, ctx);
  let finished = false;
  const pending = call('memory_write', { content: 'synthetic fact', target: 'long_term', scope: 'project' }).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false, 'must not claim success before receiving the completed response');
  const receipt = { state: 'completed', request_id: requests[0].body.request_id, result: { verified: true, content: 'synthetic fact' } };
  respond(receipt);
  assert.deepEqual(JSON.parse((await pending).content[0].text), receipt);
  assert.equal(requests[0].url, 'http://127.0.0.1:30148/v1/write');
  assert.equal(requests[0].body.scope, 'project');
  assert.equal(requests[0].body.raw, false);
  assert.ok(!('timing' in requests[0].body));
  assert.equal(requests[0].body.request_id, memory.requestIdentity('fixture-session', 'fixture-call'));

  const daily = call('memory_write', { content: 'synthetic daily', target: 'daily' }, 'daily-call');
  assert.equal(requests[1].body.scope, 'archive');
  assert.equal(requests[1].body.raw, true);
  respond({ state: 'queued', request_id: requests[1].body.request_id });
  await assert.rejects(daily, /request_id=.*memory_status.*不要重发/);
  assert.equal(requests.length, 2, 'queued response must not trigger a retry');

  globalThis.fetch = async () => { throw new Error('synthetic lost response'); };
  await assert.rejects(call('memory_write', { content: 'uncertain' }, 'lost-call'), error => {
    assert.match(error.message, /memory_status.*不要重发/);
    assert.ok(error.message.includes(memory.requestIdentity('fixture-session', 'lost-call')));
    return true;
  });
});
