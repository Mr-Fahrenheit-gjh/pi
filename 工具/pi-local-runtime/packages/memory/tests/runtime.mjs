import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const host = process.env.PI_TEST_HOST || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const require = createRequire(`${host}/package.json`);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-ai/compat': path.join(import.meta.dirname, 'summary-stub.mjs'),
  '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
}});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-local-'));
process.env.PI_MEMORY_DIR = dir;
for (const key of Object.keys(process.env)) if (key.startsWith('PI_MEMORY_') && key !== 'PI_MEMORY_DIR') delete process.env[key];
globalThis.fetch = () => { throw new Error('Network forbidden'); };
const m = await jiti.import(path.resolve(import.meta.dirname, '../index.ts'));
let calls = [], collection = false;
m._setExecFileForTest((file, args, opts, cb) => {
  assert.equal(file, 'qmd'); calls.push(args.join(' '));
  let out = '';
  if (args[0] === 'collection' && args[1] === 'list') out = JSON.stringify(collection ? ['pi-memory'] : []);
  if (args[0] === 'collection' && args[1] === 'add') { assert.ok(fs.existsSync(path.join(dir, 'daily'))); collection = true; }
  if (['search', 'vsearch', 'query'].includes(args[0])) out = JSON.stringify([{ path: 'daily/synthetic.md', content: 'SYNTHETIC_LOG' }]);
  cb(null, out, '');
});
const hooks = {}, tools = {};
m.default({ on: (n, f) => hooks[n] = f, registerTool: t => tools[t.name] = t });
let branchReads = 0;
const ctx = { hasUI: false, model: { provider: 'mock', id: 'mock' }, modelRegistry: { getApiKey: async () => 'synthetic' }, sessionManager: {
  getSessionId: () => 'synthetic-session', getBranch: () => { branchReads++; return Array.from({ length: 4 }, () => ({ type: 'message', message: { role: 'user', content: 'Synthetic decision', timestamp: 0 } })); }
}};
const call = (n, p) => tools[n].execute('test', p, undefined, undefined, ctx);
const turn = async () => (await hooks.before_agent_start({ prompt: 'synthetic', systemPrompt: 'BASE' }, ctx))?.systemPrompt;
try {
  await hooks.session_start({}, ctx); await turn();
  await hooks.session_shutdown({ reason: 'quit' }, ctx);
  assert.deepEqual(calls, []); assert.equal(branchReads, 0); assert.equal(globalThis.__memorySummaryCalls || 0, 0);
  console.log('PASS default startup/turn/quit: qmd=0, branch reads=0, LLM=0');
  for (const value of ['', '0', 'false', 'off', 'no', 'garbage']) { process.env.PI_MEMORY_EXIT_SUMMARY = value; assert.equal(m.isExitSummaryEnabled(), false); }
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) { process.env.PI_MEMORY_EXIT_SUMMARY = value; assert.equal(m.isExitSummaryEnabled(), true); }
  for (const mode of ['background', 'manual', 'off']) {
    process.env.PI_MEMORY_QMD_UPDATE = mode;
    for (const reason of ['startup', 'reload', 'new', 'resume', 'fork']) await hooks.session_start({ reason }, ctx);
  }
  assert.deepEqual(calls, []);
  console.log('PASS explicitly enabled summary still has zero startup qmd across update modes/lifecycle reasons');
  process.env.PI_MEMORY_QMD_UPDATE = 'off';
  await hooks.session_shutdown({ reason: 'reload' }, ctx); assert.equal(branchReads, 0);
  await hooks.session_shutdown({ reason: 'quit' }, ctx);
  assert.equal(globalThis.__memorySummaryCalls, 1); assert.match(fs.readFileSync(m.dailyPath(m.todayStr()), 'utf8'), /SYNTHETIC_SUMMARY/);
  process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = '1';
  await hooks.session_shutdown({ reason: 'reload' }, ctx); assert.equal(globalThis.__memorySummaryCalls, 2);
  console.log('PASS explicit summary aliases, mocked quit persistence, transition double opt-in');
  delete process.env.PI_MEMORY_EXIT_SUMMARY;
  const result = await call('memory_search', { query: 'synthetic' });
  assert.equal(result.details.count, 1); assert.ok(calls.some(c => c.startsWith('collection add'))); assert.ok(calls.some(c => c.startsWith('search')));
  assert.ok(!calls.includes('embed')); console.log('PASS first search detects/setup directories+collection+contexts/query (mock), off mode no embed');
  calls = []; await call('memory_search', { query: 'synthetic' }); assert.equal(calls.length, 1);
  console.log('PASS subsequent search uses cached initialization');
  await call('memory_write', { target: 'long_term', content: 'KEEP_FACT' });
  await call('memory_write', { target: 'long_term', content: 'REMOVE_FACT' });
  assert.match(await turn(), /REMOVE_FACT/);
  const forgotten = await call('memory_forget', { match: 'REMOVE_FACT' });
  assert.equal(forgotten.details.removed, 1); assert.doesNotMatch(await turn(), /REMOVE_FACT/);
  await call('memory_restore', { recoveryId: forgotten.details.recoveryId }); assert.match(await turn(), /REMOVE_FACT/);
  const before = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  await call('memory_restore', { recoveryId: forgotten.details.recoveryId }); assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), before);
  for (const action of ['add', 'done', 'undo', 'done', 'clear_done']) await call('scratchpad', { action, text: 'SYNTHETIC_TASK' });
  assert.match((await call('scratchpad', { action: 'list' })).content[0].text, /empty/);
  console.log('PASS forget recovery payload/restore idempotency/snapshot invalidation/scratchpad lifecycle');
  calls = []; collection = false; m._setQmdAvailable(false); m._clearQmdStatusCaches();
  process.env.PI_MEMORY_QMD_UPDATE = 'background';
  await call('memory_write', { target: 'daily', content: 'SYNTHETIC_LOG' });
  await new Promise(r => setTimeout(r, 650));
  assert.ok(calls.some(c => c.startsWith('collection add'))); assert.ok(calls.includes('update')); assert.ok(calls.includes('embed'));
  console.log('PASS write-driven lazy collection initialization/debounced update/embed (mock)');
  calls = []; collection = false; m._setQmdAvailable(false); m._clearQmdStatusCaches();
  process.env.PI_MEMORY_SNAPSHOT = 'per-turn';
  assert.match(await turn(), /SYNTHETIC_LOG/); assert.ok(calls.some(c => c.startsWith('collection add')));
  console.log('PASS explicit per-turn selective search lazy initialization');
  assert.equal(Object.keys(tools).length, 7);
} finally { m._clearUpdateTimer(); m._clearEmbedInFlight(); fs.rmSync(dir, { recursive: true, force: true }); }
