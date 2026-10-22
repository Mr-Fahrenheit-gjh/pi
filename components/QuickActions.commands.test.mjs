import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { quickActionMatches, quickSessionMatches } from '../lib/quick-actions.ts';
const sidebar = readFileSync(new URL('./SessionSidebar.tsx', import.meta.url), 'utf8');
const menu = readFileSync(new URL('./QuickActions.tsx', import.meta.url), 'utf8');
const evaluate = (source, context) => new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText).runInNewContext(context);
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function rows(search = '') {
  const ids = ['new', 'terminal', 'outputs', 'fork', 'finder'];
  const actions = ids.map(id => ({ id, label: id === 'outputs' ? 'Conversation files' : id, run() {} }));
  const session = { id: 'other', name: 'File notes', firstMessage: '', modified: '2026-10-22', cwd: '/project' };
  const context = { useMemo: fn => fn(), quickActionMatches, quickSessionMatches, actions, sessions: [session], search, contentResponse: undefined, currentSessionId: 'current', files: { key: 'key', paths: ['report.md'] }, fileKey: 'key', t: key => key, onFile() {}, onSession() {} };
  evaluate(section(menu, '  const rows = useMemo(', '  const selected =') + '\nglobalThis.result = rows;', context);
  return Array.from(context.result, row => row.key);
}

test('all five commands precede recent conversations and matching file results', () => {
  assert.deepEqual(rows(), ['action:new', 'action:terminal', 'action:outputs', 'action:fork', 'action:finder', 'session:other']);
  assert.deepEqual(rows('file'), ['action:outputs', 'session:other', 'file:report.md']);
});

function forkFixture() {
  const requests = [], opens = [], toasts = [];
  const context = {
    useCallback: fn => fn, forkingIdsRef: { current: new Set() }, selectedSessionIdRef: { current: 'current' }, forkSessionRef: { current: null },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    forkFailureMessage: code => ({ key: `error:${code}`, params: {} }), sessionRowTitle: session => session.name ?? session.id,
    splitBeforeForkSuffix: () => null, shortTitle: value => value, TOAST_TITLE_MAX: 40, t: key => key,
    showToast: (...args) => toasts.push(args), openForkedRef: { current: (session, rowKey) => opens.push([session.id, rowKey]) },
    allSessions: [], unread: new Set(), loads: 0,
    setAllSessions(fn) { context.allSessions = fn(context.allSessions); }, setUnreadSessionIds(fn) { context.unread = fn(context.unread); },
    loadSessions() { context.loads++; },
  };
  evaluate(section(sidebar, '  const forkSession = useCallback(', '\n\n  // Open in new tab') + '\nglobalThis.invoke = forkSession;', context);
  return { context, requests, opens, toasts, respond(index, body, ok = true, status = 200) { requests[index].resolve({ ok, status, json: async () => body }); } };
}

test('Fork targets the supplied conversation, shares in-flight deduplication and opens its copy', async () => {
  const f = forkFixture(), source = { id: 'clicked/session' };
  const first = f.context.invoke(source, null); await f.context.invoke(source, null);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/sessions/clicked%2Fsession/fork');
  assert.equal(f.requests[0].options.method, 'POST'); assert.equal(f.requests[0].options.body, '{}');
  f.respond(0, { session: { id: 'copy', name: 'Copy' } }); await first;
  assert.deepEqual(f.opens, [['copy', null]]); assert.equal(f.context.forkingIdsRef.current.size, 0);
  assert.equal(f.context.forkSessionRef.current, f.context.invoke);
});

test('a later conversation selection wins over a delayed Fork response', async () => {
  const f = forkFixture(); const request = f.context.invoke({ id: 'current' }, null);
  f.context.selectedSessionIdRef.current = 'selected-later'; f.respond(0, { session: { id: 'copy' } }); await request;
  assert.deepEqual(f.opens, []); assert.equal(f.context.unread.has('copy'), true); assert.equal(f.context.loads, 1);
  f.toasts[0][1][0].onClick(); assert.deepEqual(f.opens, [['copy', null]]);
});

test('Fork refuses transient placeholders and retains existing error/row behavior', async () => {
  const f = forkFixture(); await f.context.invoke({ id: 'draft', transient: true }, null); assert.equal(f.requests.length, 0);
  const missing = f.context.invoke({ id: 'gone' }, 'row:gone'); f.respond(0, { code: 'not_found' }, false, 404); await missing;
  assert.equal(f.context.loads, 1); assert.equal(f.toasts[0][0], 'error:not_found');
  const row = f.context.invoke({ id: 'current' }, 'row:current'); f.respond(1, { session: { id: 'row-copy' } }); await row;
  assert.deepEqual(f.opens, [['row-copy', 'row:current']]);
});

function finderFixture(reply) {
  const requests = [], errors = [], toasts = [];
  const context = {
    Error, useCallback: fn => fn, selectedCwd: '/browser-folder', selectedCwdProp: '/fallback-folder',
    fetch: async (url, options) => { requests.push({ url, options }); if (reply instanceof Error) throw reply; return reply; },
    setFileManagerError: value => errors.push(value), showToast: value => toasts.push(value), t: key => key,
    FILE_MANAGER_ERROR_KEYS: { remote: 'sidebar.openInExplorerRemoteOnly' },
  };
  evaluate(section(sidebar, '  const openInFileManager = useCallback(', '\n\n  const fileManagerLabel') + '\nglobalThis.invoke = openInFileManager;', context);
  return { context, requests, errors, toasts };
}

test('Finder uses the explicit conversation cwd, never the file-browser folder', async () => {
  const f = finderFixture({ ok: true });
  assert.equal(await f.context.invoke('/conversation/with spaces ; $(no shell)', true), false);
  assert.equal(f.requests[0].url, '/api/open-in-explorer');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { cwd: '/conversation/with spaces ; $(no shell)' });
  assert.deepEqual(f.errors, [null]); assert.deepEqual(f.toasts, []);
  await f.context.invoke(); assert.deepEqual(JSON.parse(f.requests[1].options.body), { cwd: '/browser-folder' });
});

test('Finder failures use the existing translated toast; network failures settle without a launch or retry', async () => {
  const remote = finderFixture({ ok: false, status: 403, json: async () => ({ error: 'remote' }) });
  assert.equal(await remote.context.invoke('/conversation', true), true);
  assert.deepEqual(remote.toasts, ['sidebar.openInExplorerRemoteOnly']);
  const network = finderFixture(new Error('offline')); assert.equal(await network.context.invoke('/conversation', true), true);
  assert.deepEqual(network.toasts, ['offline']); assert.equal(network.requests.length, 1);
});
