import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
import { quickActionMatches, quickActionShortcut, quickSessionMatches } from '../lib/quick-actions.ts';
import { quickActionsShortcutMode } from '../hooks/useKeyboardShortcuts.ts';
import { enLocale } from '../lib/i18n/messages/en.ts';
const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('./SessionSidebar.tsx', import.meta.url), 'utf8');
const menu = readFileSync(new URL('./QuickActions.tsx', import.meta.url), 'utf8');
const evaluate = (source, context) => new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText).runInNewContext(context);
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function actionsFixture(selectedSession = { id: 'current', cwd: '/conversation' }, runtime = 'pi', inlineVisualsEnabled = true) {
  const calls = [];
  const context = {
    quickCwd: '/browser-folder', selectedSession, pageRuntime: () => runtime, translate: key => enLocale.messages[key],
    runtimePage: target => target === 'meta' ? '/pi-meta' : '/', window: { location: { assign: path => calls.push(['navigate', path]) } },
    inlineVisualsEnabled, setInlineVisualsEnabled: value => calls.push(['inlineVisuals', value]),
    isMobile: false, splitOpen: false, setSplitOpen: value => calls.push(['splitOpen', value]),
    setActiveChatPane: value => calls.push(['activePane', value]), setRightPanelOpen: value => calls.push(['rightPanel', value]),
    setSidebarOpen: value => calls.push(['sidebar', value]), setRightPanelExpanded: value => calls.push(['expanded', value]),
    sidebarControlRef: { current: { renameSession: session => calls.push(['rename', session]) } },
  };
  evaluate(section(shell, '  const quickActions: QuickAction[] =', '  // Subagent work tabs:') + '\nglobalThis.result = quickActions;', context);
  return { actions: Array.from(context.result), calls };
}

function rows(search = '', mode = 'command') {
  const { actions } = actionsFixture();
  const session = { id: 'other', name: 'File notes', firstMessage: '', modified: '2026-10-22', cwd: '/project' };
  const context = { mode, useMemo: fn => fn(), quickActionMatches, quickSessionMatches, actions, sessions: [session], search, contentResponse: undefined, currentSessionId: 'current', files: { key: 'key', paths: search === 'file' ? ['report.md'] : [] }, fileKey: 'key', t: key => key, onFile() {}, onSession() {} };
  evaluate(section(menu, '  const rows = useMemo(', '  const selected =') + '\nglobalThis.result = rows;', context);
  return Array.from(context.result, row => row.key);
}

test('command and chat modes never mix commands with conversation or file results', () => {
  assert.deepEqual(rows(), ['action:new', 'action:terminal', 'action:outputs', 'action:rename', 'action:fork', 'action:finder', 'action:inline-visuals', 'action:runtime-meta', 'action:split']);
  assert.deepEqual(rows('file'), ['action:outputs']);
  assert.deepEqual(rows('', 'chat'), ['session:other']);
  assert.deepEqual(rows('file', 'chat'), ['session:other', 'file:report.md']);
  assert.deepEqual(rows('rename', 'chat'), []);
});

test('Pi Meta command switches runtimes and hides Pi-only visuals', () => {
  const pi = actionsFixture(null, 'pi');
  pi.actions.find(action => action.id === 'runtime-meta').run();
  assert.deepEqual(pi.calls, [['navigate', '/pi-meta']]);
  const meta = actionsFixture(null, 'meta');
  assert.equal(meta.actions.some(action => action.id === 'inline-visuals'), false);
  meta.actions.find(action => action.id === 'runtime-meta').run();
  assert.deepEqual(meta.calls, [['navigate', '/']]);
});

test('Intelligence UI command reflects the current preference and toggles the existing setting', () => {
  assert.match(shell, /const inlineVisualsEnabled = useInlineVisuals\(\)/);
  for (const enabled of [true, false]) {
    const fixture = actionsFixture(null, 'pi', enabled);
    const action = fixture.actions.find(action => action.id === 'inline-visuals');
    assert.ok(action, 'available without a selected session');
    assert.equal(action.label, enLocale.messages[enabled ? 'quickActions.disableInlineVisuals' : 'quickActions.enableInlineVisuals']);
    action.run();
    assert.deepEqual(fixture.calls, [['inlineVisuals', !enabled]]);
    for (const query of ['intelligence ui', 'intellgence ui', 'interactive', '交互图解', '互動圖解']) {
      assert.equal(quickActionMatches(action, query), true, query);
    }
  }
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const React = await jiti.import('react');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { I18nProvider } = await jiti.import('@/hooks/useI18n.tsx');
const { QuickActions } = await jiti.import('./QuickActions.tsx');

function renderActivity({ mode = 'chat', running = [], awaiting = [], unread = [], actions = [{ id: 'command', label: 'Command fixture', run() {} }] } = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(QuickActions, {
    actions, mode, onModeChange() {},
    sessions: ['active', 'idle'].map(id => ({ id, name: `${id} fixture`, cwd: '/project', firstMessage: '', modified: '2026-10-23' })),
    cwd: '/project', currentSessionId: null,
    runningSessionIds: new Set(running), awaitingInputSessionIds: new Set(awaiting), unreadSessionIds: new Set(unread),
    onSession() {}, onFile() {}, onClose() {},
  })));
}

test('segmented mode controls sit below search, expose shortcuts and select only the active mode', () => {
  for (const mode of ['command', 'chat']) {
    const html = renderActivity({ mode });
    assert.ok(html.indexOf('quick-actions-search') < html.indexOf('quick-actions-modes'));
    assert.ok(html.indexOf('quick-actions-modes') < html.indexOf('quick-actions-results'));
    assert.match(html, /aria-keyshortcuts="Meta\+K Control\+K"/);
    assert.match(html, /aria-keyshortcuts="Meta\+J Control\+J"/);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.equal(html.includes('placeholder="Search commands…"'), mode === 'command');
    assert.equal(html.includes('active fixture'), mode === 'chat');
    assert.equal(html.includes('Command fixture'), mode === 'command');
  }
});

test('switching modes clears search and selection, and returns focus without closing the dialog', () => {
  for (const mode of ['command', 'chat']) {
    const calls = [];
    const context = { mode, setQuery: value => calls.push(['query', value]), setIndex: value => calls.push(['index', value]), onModeChange: value => calls.push(['mode', value]), input: { current: { focus: () => calls.push(['focus']) } } };
    evaluate(section(menu, '  const switchMode =', '  const search =') + '\nglobalThis.switchMode = switchMode;', context);
    context.switchMode(mode);
    assert.deepEqual(calls, [['focus']]);
    calls.length = 0;
    const next = mode === 'command' ? 'chat' : 'command';
    context.switchMode(next);
    assert.deepEqual(calls, [['query', ''], ['index', 0], ['mode', next], ['focus']]);
  }
});

function optionWithLabel(html, label) {
  const option = html.match(/<button\b[^>]*role="option"[\s\S]*?<\/button>/g)?.find(row => row.includes(label));
  assert.ok(option, `${label} option was rendered`);
  return option;
}

test('conversation status icons match the sidebar and have accessible labels and tooltips', () => {
  const cases = [
    [{ running: ['active'] }, 'sidebar-spin', 'sidebar.agentRunning'],
    [{ awaiting: ['active'] }, 'session-tree-awaiting', 'sidebar.agentAwaitingInput'],
    [{ unread: ['active'] }, 'session-tree-unread', 'sidebar.newSessionActivity'],
  ];
  for (const [activity, className, labelKey] of cases) {
    const html = renderActivity(activity);
    const row = optionWithLabel(html, 'active fixture');
    assert.ok(row.includes(className));
    assert.ok(row.includes(`aria-label="${enLocale.messages[labelKey]}"`));
    assert.ok(row.includes(`title="${enLocale.messages[labelKey]}"`));
    assert.doesNotMatch(optionWithLabel(html, 'idle fixture'), /quick-action-status/);
    assert.doesNotMatch(optionWithLabel(renderActivity({ mode: 'command' }), 'Command fixture'), /quick-action-status/);
  }
});

test('overlapping conversation states prefer input, then running, then unread; cleared states have no icon', () => {
  for (let flags = 0; flags < 8; flags++) {
    const row = optionWithLabel(renderActivity({
      awaiting: flags & 4 ? ['active'] : [], running: flags & 2 ? ['active'] : [], unread: flags & 1 ? ['active'] : [],
    }), 'active fixture');
    const expected = flags & 4 ? 'session-tree-awaiting' : flags & 2 ? 'sidebar-spin' : flags & 1 ? 'session-tree-unread' : null;
    for (const className of ['session-tree-awaiting', 'sidebar-spin', 'session-tree-unread']) {
      assert.equal(row.includes(className), className === expected, `flags=${flags}, icon=${className}`);
    }
    assert.equal(row.includes('quick-action-status'), Boolean(expected));
  }
});

test('each page has at most nine numbered rows with aligned slots and accessible positions', () => {
  const actions = Array.from({ length: 12 }, (_, i) => ({ id: `command-${i}`, label: `Command ${i + 1} fixture`, run() {} }));
  const html = renderActivity({ actions, mode: 'command' });
  assert.equal((html.match(/role="option"/g) ?? []).length, 9);
  for (let i = 0; i < 9; i++) {
    const option = optionWithLabel(html, actions[i].label);
    assert.match(option, new RegExp(`aria-keyshortcuts="${i + 1}"`));
    assert.match(option, new RegExp(`aria-posinset="${i + 1}"`));
    assert.match(option, /aria-setsize="12"/);
    assert.ok(option.indexOf('quick-action-shortcut') < option.indexOf('quick-action-copy'));
    assert.match(option, new RegExp(`<kbd[^>]*>${i + 1}</kbd>`));
  }
  assert.doesNotMatch(html, /Command 10 fixture/);
  assert.match(html, /aria-label="Next results"/);
  const css = readFileSync(new URL('../app/workflow-polish.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-columns: 28px minmax\(0, 1fr\) 96px/);
  assert.match(css, /width: 100%; height: 52px/);
});

test('plain 1–9 executes the matching row once, without hijacking search, IME or modified keys', () => {
  const source = ts.createSourceFile('QuickActions.tsx', menu, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onKeyDown') return node.initializer.expression;
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(`(${findHandler(source).getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
  const cases = [
    ['first', { key: '1' }, '', 12, 0], ['ninth', { key: '9' }, '', 12, 8],
    ['second page first', { key: '1' }, '', 14, 9, 9],
    ['second page last', { key: '5' }, '', 14, 13, 9],
    ['second page missing row', { key: '9' }, '', 14, null, 9],
    ['Option digit while searching', { key: '¡', code: 'Digit1', altKey: true }, 'report', 12, 0],
    ['number while searching', { key: '2' }, 'report', 12, null],
    ['space-prefixed numeric search', { key: '2' }, ' ', 12, null],
    ['zero is not a shortcut', { key: '0' }, '', 12, null],
    ['missing row', { key: '9' }, '', 6, null],
    ['no rows', { key: '1' }, '', 0, null],
    ...['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented'].map(flag => [flag, { key: '1', [flag]: true }, '', 12, null]),
    ['IME', { key: '1', nativeEvent: { isComposing: true } }, '', 12, null],
    ['legacy IME', { key: '1', nativeEvent: { keyCode: 229 } }, '', 12, null],
  ];
  for (const [label, flags, query, count, expected, pageStart = 0] of cases) {
    const calls = [];
    let prevented = false;
    const target = {};
    const rows = Array.from({ length: count }, (_, index) => ({ run: () => calls.push(index) }));
    const handler = script.runInNewContext({ query, rows, quickActionsShortcutMode, visibleRows: rows.slice(pageStart, pageStart + 9), quickActionShortcut, input: { current: target }, document: { activeElement: target }, choose: run => run() });
    handler({ nativeEvent: {}, preventDefault() { prevented = true; }, ...flags });
    assert.deepEqual(calls, expected === null ? [] : [expected], label);
    assert.equal(prevented, expected !== null, label);
  }
});

test('Rename matches English and Chinese aliases and opens the current conversation editor', () => {
  const selected = { id: 'clicked/session', cwd: '/conversation' };
  const f = actionsFixture(selected);
  const rename = f.actions.find(action => action.id === 'rename');
  for (const query of ['rename', 'title', '重命名', '改名', '重新命名']) assert.ok(quickActionMatches(rename, query));
  rename.run();
  assert.deepEqual(f.calls, [['expanded', false], ['sidebar', true], ['rename', selected]]);
  assert.deepEqual(rows('rename'), ['action:rename']);
});

test('Rename is absent without a saved native conversation or for read-only subagents', () => {
  for (const [session, runtime] of [[null, 'pi'], [{ id: 'draft', transient: true }, 'pi'], [{ id: 'peer' }, 'feynman'], [{ id: 'child', relation: { kind: 'subagent' } }, 'pi']]) {
    assert.equal(actionsFixture(session, runtime).actions.some(action => action.id === 'rename'), false);
  }
});

function renameFixture({ archived = false, pinned = false } = {}) {
  const changes = [], requests = [];
  const family = { root: { id: 'current/session', name: 'Old name', cwd: '/conversation' } };
  const context = {
    useCallback: fn => fn, familyByRootId: new Map([[family.root.id, family]]), renameSessionRef: { current: null },
    uiState: {}, runningSessionIds: new Set(), groupExpansion: { '/conversation': false, '/other': false }, shownGroupExpansion: { '/conversation': false },
    isFamilyArchived: () => archived, isFamilyPinned: () => pinned && !archived, workspaceKeyOf: session => session.cwd,
    setSidebarTab: value => changes.push(['tab', value]), setSessionSearchQuery: value => changes.push(['query', value]),
    setSessionSearchOpen: value => changes.push(['search', value]), setArchiveView: value => changes.push(['archive', value]),
    setPinnedCollapsed: value => changes.push(['pinned', value]), savePinnedCollapsed: value => changes.push(['savePinned', value]),
    branches: { 'current/session': false, 'parent/session': false, other: false },
    setBranchExpansion: update => { context.branches = update(context.branches); },
    saveGroupChoices: (choices, keys) => changes.push(['groups', JSON.parse(JSON.stringify(choices)), Array.from(keys)]),
    setConfirmDeleteRootId: value => changes.push(['confirmDelete', value]),
    renaming: null, setRenamingRootId: value => { context.renaming = typeof value === 'function' ? value(context.renaming) : value; },
    sessionRowTitle: session => session.name || session.id,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; }, loads: 0,
    loadSessions: () => { context.loads++; },
  };
  evaluate(section(sidebar, '  const startRename = useCallback(', "  // A project's display name") + '\nglobalThis.open = renameSession; globalThis.commit = commitRename;', context);
  return { context, family, changes, requests };
}

test('Rename clears sidebar search, reveals a collapsed group, and reuses the exact row editor', () => {
  const f = renameFixture(); f.context.open(f.family.root);
  assert.equal(f.context.renaming, f.family.root.id);
  assert.equal(f.context.renameSessionRef.current, f.context.open);
  assert.deepEqual(f.changes, [['tab', 'sessions'], ['query', ''], ['search', false], ['archive', false], ['groups', { '/conversation': true, '/other': false }, ['/conversation']], ['confirmDelete', null]]);
  assert.deepEqual(f.requests, [], 'opening the editor never writes a name');
});

test('Rename reveals default-collapsed projects and fork ancestors without opening unrelated branches', () => {
  const f = renameFixture();
  f.context.shownGroupExpansion = {};
  f.family.root.relation = { kind: 'fork', originSessionId: 'parent/session' };
  f.context.familyByRootId.set('parent/session', { root: { id: 'parent/session' } });
  f.context.open(f.family.root);
  assert.ok(f.changes.some(([key, choices]) => key === 'groups' && choices['/conversation'] === true));
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.branches)), { other: false });
  assert.equal(f.context.renaming, f.family.root.id);
});

test('Rename reveals pinned or archived rows without changing their saved status', () => {
  for (const options of [{ pinned: true }, { archived: true }]) {
    const f = renameFixture(options); f.context.open(f.family.root);
    assert.equal(f.context.renaming, f.family.root.id);
    assert.ok(f.changes.some(([key, value]) => key === 'archive' && value === Boolean(options.archived)));
    assert.equal(f.changes.some(([key]) => key === 'groups'), false);
    assert.equal(f.changes.some(([key, value]) => key === 'pinned' && value === false), Boolean(options.pinned));
    assert.deepEqual(f.requests, []);
  }
});

test('Rename does not fall back to a different conversation for transient or missing IDs', () => {
  const f = renameFixture();
  f.context.open({ ...f.family.root, transient: true }); f.context.open({ id: 'missing' });
  assert.equal(f.context.renaming, null); assert.deepEqual(f.changes, []); assert.deepEqual(f.requests, []);
});

test('the reused rename flow trims and saves only the target, then refreshes; unchanged names do not write', async () => {
  const f = renameFixture(); f.context.open(f.family.root);
  await f.context.commit(f.family, 'Old name'); assert.deepEqual(f.requests, []);
  await f.context.commit(f.family, '  New name  ');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/sessions/current%2Fsession');
  assert.equal(f.requests[0].options.method, 'PATCH'); assert.deepEqual(JSON.parse(f.requests[0].options.body), { name: 'New name' });
  assert.equal(f.context.loads, 1); assert.equal(f.context.renaming, null);
});

function forkFixture() {
  const requests = [], opens = [], toasts = [];
  const context = {
    useCallback: fn => fn, forkingIdsRef: { current: new Set() }, selectedSessionIdRef: { current: 'current' }, forkSessionRef: { current: null },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    forkFailureMessage: code => ({ key: `error:${code}`, params: {} }), sessionRowTitle: session => session.name ?? session.id,
    splitBeforeForkSuffix: () => null, shortTitle: value => value, TOAST_TITLE_MAX: 40, t: key => key,
    showToast: (...args) => toasts.push(args), openForkedRef: { current: (session, rowKey) => opens.push([session.id, rowKey]) },
    allSessions: [], unread: new Set(), loads: 0, uiRefreshes: 0,
    markReadState(ids, isRead) { for (const id of ids) { if (isRead) context.unread.delete(id); else context.unread.add(id); } },
    async refreshUiState() { context.uiRefreshes++; },
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
  assert.equal(f.context.uiRefreshes, 1);
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
