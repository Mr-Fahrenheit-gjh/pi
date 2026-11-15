// Historical pi-memory-local + notesoup compatibility only: seven tools, forget/restore,
// and deferred writes below are NOT the current Hy-Memory contract or deployment proof.
// Current six-tool/schema/synchronous-receipt regression: 项目/规则优化/运行规则/hy-memory-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hasNotesoupContextOwner } from './context-policy.mjs';
import { configureHostSdk } from '../pi-subagents-quiet/host-sdk.mjs';
import { resolveHostPeerAliases } from '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js';
const host = configureHostSdk();
const { createJiti } = createRequire(`${host}/package.json`)('jiti');
const peers = resolveHostPeerAliases(host);
assert.deepEqual(peers.missing, []);
const load = createJiti(import.meta.url, { alias: peers.aliases, moduleCache: false });
const memory = await load.import('../../项目/规则优化/agent-eval-20261002/packages/pi-memory-local/index.ts');
const { default: workflow } = await load.import('./index.ts');
const owned = [{ name: 'empty_brain' }, { name: 'get_context_remaining' }];

function fixture(t, hasOwner = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-owner-'));
  const savedEnv = { ...process.env };
  process.env.PI_MEMORY_QMD_UPDATE = 'off';
  process.env.PI_MEMORY_INCLUDE_DAILY = '1';
  process.env.PI_MEMORY_NO_SEARCH = '1';
  process.env.PI_MEMORY_SNAPSHOT = 'stable';
  process.env.PI_CODING_AGENT_DIR = dir;
  memory._setBaseDir(dir); memory._resetMemorySnapshot(); memory.ensureDirs();
  const hooks = new Map(), tools = new Map();
  let all = hasOwner ? owned : [];
  const api = {
    on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); }, appendEntry() {},
    getAllTools: () => all,
    getActiveTools() { throw new Error('Ownership is not the active tool set'); },
  };
  memory.default(api); workflow(api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => 'test-owner', getBranch() { throw new Error('No automatic summary'); } } };
  const emit = async (name, event = {}) => { const results = []; for (const fn of hooks.get(name) ?? []) results.push(await fn(event, ctx)); return results; };
  const prompt = async () => (await emit('before_agent_start', { systemPrompt: 'BASE', prompt: 'task' }))[0]?.systemPrompt ?? 'BASE';
  const call = (name, args) => tools.get(name).execute('test', args, undefined, undefined, ctx);
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  put('MEMORY.md', 'STABLE_A'); put('SCRATCHPAD.md', '- [ ] OLD_WORK');
  put(`daily/${memory.todayStr()}.md`, 'OLD_DAILY');
  t.after(() => { memory._clearUpdateTimer(); memory._clearEmbedInFlight(); memory._resetMemorySnapshot(); memory._resetBaseDir(); for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, hooks, tools, api, ctx, emit, prompt, call, put, setOwner: value => { all = value ? owned : []; } };
}
function preparation() {
  return { isSplitTurn: true, messagesToSummarize: [{ role: 'user', content: 'goal' }], turnPrefixMessages: [{ role: 'user', content: 'latest decision' }] };
}

test('public all-tools pair only; hidden/inactive tools still mean loaded ownership', () => {
  for (const names of [[], owned.slice(0, 1), owned.slice(1)]) assert.equal(hasNotesoupContextOwner({ getAllTools: () => names }), false);
  assert.equal(hasNotesoupContextOwner({ getAllTools: () => owned.map(t => ({ ...t, exposure: 'hidden' })) }), true);
});

test('loaded owner injects stable memory only in both snapshot modes; explicit tools remain', async t => {
  const f = fixture(t);
  for (const mode of ['stable', 'per-turn']) {
    process.env.PI_MEMORY_SNAPSHOT = mode;
    const prompt = await f.prompt();
    assert.match(prompt, /STABLE_A/); assert.doesNotMatch(prompt, /OLD_WORK|OLD_DAILY/);
    assert.match(prompt, /notesoup session notes/);
  }
  assert.equal(f.tools.size, 7);
  assert.match(JSON.stringify(await f.call('memory_read', { target: 'daily' })), /OLD_DAILY/);
  assert.match(memory.buildMemoryContext('SEARCH_DETAIL'), /SEARCH_DETAIL/);
  assert.doesNotMatch(memory.buildMemoryContext('SEARCH_DETAIL', true), /SEARCH_DETAIL|OLD_WORK|OLD_DAILY/);
});

test('fingerprint sees same-length/same-mtime external edits, preserves unchanged prefix', async t => {
  const f = fixture(t); const a = await f.prompt();
  f.put('SCRATCHPAD.md', '- [ ] DIFFERENT_WORK');
  f.put(`daily/${memory.todayStr()}.md`, 'DIFFERENT_DAILY');
  assert.equal(await f.prompt(), a);
  const file = path.join(f.dir, 'MEMORY.md'), stat = fs.statSync(file);
  f.put('MEMORY.md', 'STABLE_B'); fs.utimesSync(file, stat.atime, stat.mtime);
  const b = await f.prompt(); assert.match(b, /STABLE_B/); assert.doesNotMatch(b, /STABLE_A/);
  assert.equal(await f.prompt(), b);
});

test('late registration and owner removal invalidate scope without relying on factory order', async t => {
  const f = fixture(t, false);
  assert.match(await f.prompt(), /OLD_WORK|OLD_DAILY/);
  f.setOwner(true); assert.doesNotMatch(await f.prompt(), /OLD_WORK|OLD_DAILY/);
  f.setOwner(false); process.env.PI_MEMORY_SNAPSHOT = 'per-turn';
  assert.match(await f.prompt(), /OLD_WORK/);
  process.env.PI_MEMORY_SNAPSHOT = 'stable';
  assert.match(await f.prompt(), /OLD_WORK/);
  const p = preparation(); await f.emit('session_before_compact', { preparation: p });
  assert.equal(p.isSplitTurn, false); assert.match(fs.readFileSync(memory.dailyPath(memory.todayStr()), 'utf8'), /HANDOFF/);
});

test('owner yields compaction without cancellation, handoff or private reset/enabled queries', async t => {
  const f = fixture(t);
  for (const state of [{ enabled: true }, { enabled: false }, { enabled: false, existingReset: true }]) {
    const p = preparation(), before = structuredClone(p);
    const result = await f.emit('session_before_compact', { preparation: p, fixturePrivateState: state });
    assert.deepEqual(p, before); assert.deepEqual(result, [undefined, undefined]);
  }
  assert.equal(fs.readFileSync(memory.dailyPath(memory.todayStr()), 'utf8'), 'OLD_DAILY');
  const archived = await f.emit('tool_result', { toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(18000) }] });
  assert.match(JSON.stringify(archived), /tool-output/);
  assert.equal(fs.readdirSync(path.join(f.dir, 'tool-output')).length, 1);
});

test('write/forget/restore refresh stable memory; deferred daily write does not churn snapshot', async t => {
  const f = fixture(t); const original = await f.prompt();
  await f.call('memory_write', { target: 'daily', content: 'EXPLICIT_DAILY' });
  await f.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] });
  assert.equal(await f.prompt(), original);
  await f.call('memory_write', { target: 'long_term', content: 'RECOVER_ME', timing: 'now' });
  assert.match(await f.prompt(), /RECOVER_ME/);
  const deleted = await f.call('memory_forget', { match: 'RECOVER_ME' });
  assert.doesNotMatch(await f.prompt(), /RECOVER_ME/);
  await f.call('memory_restore', { recoveryId: deleted.details.recoveryId });
  assert.match(await f.prompt(), /RECOVER_ME/);
  await f.call('memory_write', { target: 'long_term', content: 'DEFERRED_FACT' });
  await f.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] });
  assert.match(await f.prompt(), /DEFERRED_FACT/);
});

test('owner suppresses opt-in exit summary and still removes terminal handler', async t => {
  const f = fixture(t); process.env.PI_MEMORY_EXIT_SUMMARY = '1';
  const before = fs.readFileSync(memory.dailyPath(memory.todayStr()), 'utf8');
  let branchReads = 0;
  f.ctx.sessionManager.getBranch = () => { branchReads++; return []; };
  await f.emit('session_shutdown', { reason: 'quit' });
  assert.equal(branchReads, 0);
  assert.equal(fs.readFileSync(memory.dailyPath(memory.todayStr()), 'utf8'), before);
  // Structural assertion complements the hook test without starting qmd/MCP.
  const source = fs.readFileSync(new URL('../../项目/规则优化/agent-eval-20261002/packages/pi-memory-local/index.ts', import.meta.url), 'utf8');
  const shutdown = source.slice(source.indexOf('pi.on("session_shutdown"'), source.indexOf('// --- input:'));
  assert.ok(shutdown.indexOf('terminalInputUnsubscribe();') < shutdown.indexOf('hasNotesoupContextOwner(pi)'));
  assert.match(shutdown, /clearTimeout\(updateTimer\)/);
});
