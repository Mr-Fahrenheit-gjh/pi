import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_ACTION_PAGE_SIZE, quickActionMatches, quickActionPage, quickActionShortcut, quickSessionMatches } from './quick-actions.ts';

test('paging covers every result once with a digit on every page, including short and empty lists', () => {
  assert.equal(QUICK_ACTION_PAGE_SIZE, 9);
  for (const count of [0, 1, 8, 9, 10, 14, 26]) {
    const visited = [];
    for (let selected = 0; selected < Math.max(1, count); selected += 9) {
      const page = quickActionPage(count, selected);
      assert.ok(page.end - page.start <= 9);
      assert.equal(page.number, Math.floor(selected / 9) + 1);
      assert.equal(page.total, Math.max(1, Math.ceil(count / 9)));
      for (let row = page.start; row < page.end; row++) visited.push(row);
    }
    assert.deepEqual(visited, Array.from({ length: count }, (_, i) => i));
    assert.equal(quickActionPage(count, 100).end, count);
    assert.equal(quickActionPage(count, -1).start, 0);
  }
});

test('numeric shortcuts preserve typed searches and use physical Option/Alt digits for filtered results', () => {
  for (let n = 1; n <= 9; n++) {
    assert.equal(quickActionShortcut({ key: String(n) }, ''), n - 1);
    assert.equal(quickActionShortcut({ key: String(n) }, 'notes'), null);
    assert.equal(quickActionShortcut({ key: String(n) }, ' '), null);
    assert.equal(quickActionShortcut({ key: 'option character', code: `Digit${n}`, altKey: true }, 'notes'), n - 1);
    assert.equal(quickActionShortcut({ key: String(n), code: `Numpad${n}`, altKey: true }, 'notes'), n - 1);
  }
  for (const flag of ['metaKey', 'ctrlKey', 'shiftKey', 'repeat', 'defaultPrevented']) {
    assert.equal(quickActionShortcut({ key: '1', code: 'Digit1', altKey: true, [flag]: true }, ''), null);
  }
  for (const key of ['0', 'a', 'Enter']) assert.equal(quickActionShortcut({ key }, ''), null);
});

const session = (id, name, modified = '2026-10-22T10:00:00Z') => ({ id, name, modified, firstMessage: '', cwd: '/project', path: `/${id}.jsonl`, created: modified, messageCount: 2 });

test('blank search shows recent conversations, not the current conversation or transient placeholders', () => {
  const catalog = [session('old', 'Old', '2026-10-21'), session('current', 'Current'), session('new', 'New'), { ...session('draft', 'Draft'), transient: true }];
  assert.deepEqual(quickSessionMatches(catalog, ' ', [], 'current').map(row => row.session.id), ['new', 'old']);
  assert.equal(catalog[0].id, 'old');
});

test('body search leads, preserves exact message targets and de-duplicates title hits', () => {
  const titled = session('title', 'budget report');
  const body = { session: session('body', 'Planning'), entryId: 'entry-7', blockIndex: 3, before: 'The ', match: 'budget', after: ' is ready.' };
  const rows = quickSessionMatches([titled], ' BUDGET ', [body, { ...body, session: titled }]);
  assert.deepEqual(rows.map(row => row.session.id), ['body', 'title']);
  assert.equal(rows[0].entryId, 'entry-7');
  assert.equal(rows[0].blockIndex, 3);
  assert.equal(rows[0].match, 'budget');
});

test('title fallback covers all matches while blank search shows exactly nine recents', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...session(String(i), 'Notes'), firstMessage: 'Find a report' }));
  assert.equal(quickSessionMatches(rows, 'report', []).length, 20);
  assert.equal(quickSessionMatches(rows, '', []).length, 9);
  assert.deepEqual(quickSessionMatches(rows, 'report', []).slice(9, 18).map(row => row.session.id), rows.slice(9, 18).map(row => row.id));
  assert.deepEqual(quickSessionMatches(rows, 'missing', []), []);
});

test('actions match useful aliases across interface languages', () => {
  assert.equal(quickActionMatches({ label: '打开项目终端', keywords: ['terminal', 'shell'] }, ' TERMINAL '), true);
  assert.equal(quickActionMatches({ label: 'New conversation' }, 'conversation'), true);
  assert.equal(quickActionMatches({ label: 'New conversation' }, 'settings'), false);
});
