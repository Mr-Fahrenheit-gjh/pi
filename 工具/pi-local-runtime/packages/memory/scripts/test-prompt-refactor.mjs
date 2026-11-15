import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const host = process.env.PI_TEST_HOST || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const require = createRequire(`${host}/package.json`);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-ai/compat': `${host}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
}});
const m = await jiti.import(path.resolve(import.meta.dirname, '../index.ts'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-prompt-'));
process.env.PI_MEMORY_QMD_UPDATE = 'off';
delete process.env.PI_MEMORY_SNAPSHOT;
process.env.PI_MEMORY_EXIT_SUMMARY = '0';
m._setBaseDir(dir);
m._resetMemorySnapshot();
// No subprocesses, qmd collection changes, UI, or provider calls.
m._setExecFileForTest((...args) => { args.at(-1)(new Error('qmd unavailable in isolated test'), '', ''); });
const hooks = {}, tools = {};
m.default({ on: (name, fn) => { hooks[name] = fn; }, registerTool: t => { tools[t.name] = t; } });
const ctx = { hasUI: false, sessionManager: { getSessionId: () => 'isolated-test' } };
const turn = async prompt => (await hooks.before_agent_start({ prompt, systemPrompt: 'BASE' }, ctx))?.systemPrompt;
const call = (name, params) => tools[name].execute('test', params, undefined, undefined, ctx);
const text = r => r.content.map(c => c.text || '').join('\n');
try {
  m.ensureDirs();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'LONG_TERM_SENTINEL');
  fs.writeFileSync(path.join(dir, 'SCRATCHPAD.md'), '- [ ] OPEN_SENTINEL\n- [x] DONE_SENTINEL');
  fs.writeFileSync(m.dailyPath(m.todayStr()), 'TODAY_SENTINEL');
  fs.writeFileSync(m.dailyPath(m.yesterdayStr()), 'YESTERDAY_SENTINEL');
  await hooks.session_start({}, ctx);
  const first = await turn('first');
  assert.match(first, /LONG_TERM_SENTINEL/);
  assert.match(first, /OPEN_SENTINEL/);
  assert.doesNotMatch(first, /TODAY_SENTINEL|YESTERDAY_SENTINEL|DONE_SENTINEL|## Daily log:/);
  assert.equal(await turn('different question'), first);
  assert.match(text(await call('memory_read', { target: 'daily' })), /TODAY_SENTINEL/);
  assert.match(text(await call('memory_read', { target: 'daily', date: m.yesterdayStr() })), /YESTERDAY_SENTINEL/);
  assert.equal((await call('memory_read', { target: 'list' })).details.files.length, 2);
  await call('memory_write', { target: 'daily', content: 'NEW_DAILY_SENTINEL' });
  await call('scratchpad', { action: 'add', text: 'NEW_OPEN_SENTINEL' });
  assert.equal(await turn('after high-frequency writes'), first);
  await hooks.session_before_compact({}, ctx);
  const compacted = await turn('after compact');
  assert.match(compacted, /NEW_OPEN_SENTINEL/);
  assert.doesNotMatch(compacted, /TODAY_SENTINEL|YESTERDAY_SENTINEL|NEW_DAILY_SENTINEL|HANDOFF/);
  assert.match(text(await call('memory_read', { target: 'daily' })), /HANDOFF/);
  await call('memory_write', { target: 'long_term', content: 'NEW_LONG_TERM_SENTINEL' });
  assert.match(await turn('after durable write'), /NEW_LONG_TERM_SENTINEL/);
  assert.ok(tools.memory_search);
  assert.match(text(await call('memory_search', { query: 'TODAY_SENTINEL', mode: 'keyword' })), /qmd/i);
  process.env.PI_MEMORY_SNAPSHOT = 'per-turn';
  process.env.PI_MEMORY_NO_SEARCH = '1';
  assert.doesNotMatch(await turn('legacy explicit mode'), /TODAY_SENTINEL|YESTERDAY_SENTINEL|NEW_DAILY_SENTINEL/);
  console.log('PASS: default injection, open-only scratchpad, byte-stable turns, daily read/list/write, compaction handoff/read + refresh, long-term dirty refresh, search registration/degradation, per-turn standard context');
} finally {
  m._resetBaseDir();
  m._resetMemorySnapshot();
  fs.rmSync(dir, { recursive: true, force: true });
}
