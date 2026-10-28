import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHistoryFixture } from './history-fixture.mjs';
const fixture = { sessionId: '01a142c9-2e81-764e-bdbc-1c44a4123328', runId: '6bf7d770-9f45-4ab4-818f-de157974cd5a', expectedText: 'No issues found.' };
test('real-history identity requires an exact parent/run and bounded real text', () => {
  assert.deepEqual(validateHistoryFixture(fixture, fixture.sessionId), fixture);
  for (const invalid of [{...fixture, sessionId: fixture.runId}, {...fixture, runId: '../outside'}, {...fixture, expectedText: ''}, {...fixture, expectedText: 'a'.repeat(161)}]) assert.throws(() => validateHistoryFixture(invalid, fixture.sessionId));
});
