import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const source = readFileSync(new URL('./package-subagent-history.ts', import.meta.url), 'utf8')
  .replaceAll('"./regular-file"', JSON.stringify(new URL('./regular-file.ts', import.meta.url).href))
  .replaceAll('"./subagent-fleet-view"', JSON.stringify(new URL('./subagent-fleet-view.ts', import.meta.url).href));
const { readOwnedPackageRun, listOwnedPackageRuns } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('persisted ownership survives absent snapshots, rejects foreign runs and symlink artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-history-'));
  try {
    const parent = join(root, 'parent.jsonl'), foreign = join(root, 'foreign.jsonl');
    writeFileSync(parent, '{}'); writeFileSync(foreign, '{}');
    const id = 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa'; mkdirSync(join(root, id));
    const statusPath = join(root, id, 'status.json');
    writeFileSync(statusPath, JSON.stringify({ runId: id, sessionId: parent, state: 'complete', startedAt: 10, steps: [{ agent: 'delegate' }] }));
    assert.equal(readOwnedPackageRun(id, parent, root).state, 'complete');
    assert.equal(readOwnedPackageRun(id, foreign, root), undefined);
    assert.equal(readOwnedPackageRun('../' + id, parent, root), undefined);
    assert.equal(listOwnedPackageRuns(parent, root).length, 1);
    const alias = join(root, 'alias.jsonl'); symlinkSync(parent, alias);
    assert.equal(readOwnedPackageRun(id, alias, root).id, id);
    rmSync(statusPath); symlinkSync(parent, statusPath);
    assert.equal(readOwnedPackageRun(id, parent, root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
