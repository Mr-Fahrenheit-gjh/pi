import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const outputs = await createJiti(import.meta.url).import('./task-outputs.ts');
const nativeSource = readFileSync(new URL('../app/api/sessions/[id]/outputs/route.ts', import.meta.url), 'utf8');
const feynmanSource = readFileSync(new URL('../app/api/runtime/feynman/[...path]/route.ts', import.meta.url), 'utf8');
const write = name => [
  { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: name, name: 'write', arguments: { path: name } }] } },
  { type: 'message', message: { role: 'toolResult', toolCallId: name, toolName: 'write', isError: false } },
];

function fixture({ runtime = 'pi', live = true, missing = false, fail = false } = {}) {
  const events = [];
  const manager = { getCwd: () => '/project', getBranch(leaf) { events.push(['branch', leaf]); if (fail) throw Error('/private/session/path'); return write(leaf === 'sibling' ? 'sibling.md' : 'report.md'); } };
  const next = { NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 }) } };
  const exports = {};
  const source = runtime === 'pi' ? nativeSource : feynmanSource;
  const script = new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText);
  script.runInNewContext({ exports, URL, Response, require(id) {
    if (id.startsWith('node:')) return require(id);
    if (id === 'next/server') return next;
    if (id === '@/lib/task-outputs') return outputs;
    if (id === '@/lib/rpc-manager') return {
      getRpcSession() { if (runtime !== 'pi') throw Error('Cross-runtime access'); return live ? { isAlive: () => true, inner: { sessionManager: manager } } : null; },
    };
    if (id === '@/lib/session-reader') return {
      resolveSessionPath: async () => { events.push(['resolve']); return missing ? null : '/private/session.jsonl'; },
      openSessionManager() { events.push(['open']); return manager; },
      sliceActiveBranch(entries, leaf) { events.push(['slice', leaf]); return entries; },
    };
    if (id === '@/lib/feynman-store') return {
      feynmanPaths: () => ({ sessions: '/feynman/sessions' }),
      resolveFeynmanSession: async () => { events.push(['resolve-feynman']); return missing ? null : { path: '/feynman/session.jsonl', cwd: '/project' }; },
      feynmanSessionManager: async () => ({ open(path, root) { events.push(['open-feynman', path, root]); return manager; } }),
    };
    if (id === '@/lib/feynman-rpc') return {
      getFeynmanSession: () => live ? { cwd: '/project', send: async command => { events.push(['feynman-command', command.type]); return { entries: write('live.md'), leafId: 'live-leaf' }; } } : null,
    };
    if (id === '@/lib/feynman-mutations') return { FeynmanMutationError: class extends Error {} };
    if (id.startsWith('@/lib/')) return new Proxy({}, { get: () => () => { throw Error('Unexpected side-effect module: ' + id); } });
    throw Error(id);
  } });
  return {
    events,
    get: (leaf = 'selected') => exports.GET(new Request(`http://localhost/api/sessions/sid/outputs?leafId=${leaf}`), { params: Promise.resolve(runtime === 'pi' ? { id: 'sid' } : { path: ['sessions', 'sid', 'outputs'] }) }),
  };
}

test('native live history reads only the selected branch without opening a second session', async () => {
  const f = fixture(); const response = await f.get(); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(data.paths, ['/project/report.md']); assert.equal(data.sessionId, 'sid');
  assert.deepEqual(f.events, [['branch', 'selected']]);
});

test('native saved history is read-only and missing sessions return 404', async () => {
  const f = fixture({ live: false }); const data = await (await f.get('sibling')).json();
  assert.deepEqual(data.paths, ['/project/sibling.md']); assert.deepEqual(f.events, [['resolve'], ['open'], ['branch', 'sibling']]);
  const missing = fixture({ live: false, missing: true }); assert.equal((await missing.get()).status, 404); assert.deepEqual(missing.events, [['resolve']]);
});

test('native history failures do not reveal filesystem paths', async () => {
  const response = await fixture({ fail: true }).get(); assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /private/);
  assert.doesNotMatch(nativeSource, /startRpcSession|allowFileRoot|readdir|writeFile/);
});

test('Feynman output history stays in its own store and never starts a runtime', async () => {
  const f = fixture({ runtime: 'feynman' }); const response = await f.get(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).paths, ['/project/report.md']);
  assert.deepEqual(f.events, [['resolve-feynman'], ['open-feynman', '/feynman/session.jsonl', '/feynman/sessions'], ['branch', 'selected']]);
});

test('unsaved Feynman history uses only a read command; missing sessions do not fall through to Pi', async () => {
  const f = fixture({ runtime: 'feynman', missing: true }); const response = await f.get(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).paths, ['/project/live.md']);
  assert.deepEqual(f.events, [['resolve-feynman'], ['feynman-command', 'get_entries'], ['slice', 'selected']]);
  assert.equal((await fixture({ runtime: 'feynman', missing: true, live: false }).get()).status, 404);
});
