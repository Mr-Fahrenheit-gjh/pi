// Select an explicitly retained real run; never creates or rewrites runtime records.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export function validateHistoryFixture(fixture, sessionId) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok(uuid.test(sessionId) && fixture.sessionId === sessionId, 'History fixture parent mismatch');
  assert.ok(uuid.test(fixture.runId), 'Exact real history run UUID required');
  assert.ok(typeof fixture.expectedText === 'string' && fixture.expectedText.trim().length >= 8 && fixture.expectedText.length <= 160, 'Bounded real child text required');
  return fixture;
}
export function loadHistoryFixture(sessionId) {
  const config = JSON.parse(readFileSync(resolve(here, 'local-update.json'), 'utf8'));
  const fixture = config.historyFixtureFile
    ? JSON.parse(readFileSync(realpathSync(resolve(here, config.historyFixtureFile)), 'utf8'))
    : { sessionId, runId: '184ba6e2-ce63-48db-b4eb-8b205a05bc41', expectedText: 'SUBAGENT_UPDATE_SMOKE_OK' };
  return validateHistoryFixture(fixture, sessionId);
}
