import test from 'node:test';
import assert from 'node:assert/strict';
import { quickActionMatches, quickSessionMatches } from './quick-actions.ts';

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

test('title fallback is immediate, includes first messages and remains bounded', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...session(String(i), 'Notes'), firstMessage: 'Find a report' }));
  assert.equal(quickSessionMatches(rows, 'report', []).length, 8);
  assert.deepEqual(quickSessionMatches(rows, 'missing', []), []);
});

test('actions match useful aliases across interface languages', () => {
  assert.equal(quickActionMatches({ label: '打开项目终端', keywords: ['terminal', 'shell'] }, ' TERMINAL '), true);
  assert.equal(quickActionMatches({ label: 'New conversation' }, 'conversation'), true);
  assert.equal(quickActionMatches({ label: 'New conversation' }, 'settings'), false);
});
