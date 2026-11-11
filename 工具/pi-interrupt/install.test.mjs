import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patch, plan, enginePath } from './install.mjs';
import { before, after, patch as patchSubagents } from './apply-subagents.mjs';
const core = 'export class AgentSession {\n    async _startRun(trigger, onStarted) {\n}\n    async _emitAgentSettled() {\n}\n    async _queueSteer(text, images) {\n}\n    async abort() {\n}\n}\n';
const bundled = 'var AgentSession=class{async _startRun(trigger,onStarted){}async _emitAgentSettled(){}async _queueSteer(text,images){}async waitForIdle(){this.isIdle||await this._getIdleWaitPromise()}async _prepareRetry(message){}};';

test('core and bundled adapters are idempotent and refuse unknown/partial source', () => {
  for (const [source, bundle] of [[core, false], [bundled, true]]) {
    const changed = patch(source, bundle);
    assert.equal(patch(changed, bundle), changed);
    assert.throws(() => patch(source.replace('_queueSteer', '_unknown'), bundle), /Unsupported/);
    assert.throws(() => patch(changed + 'changed externally', bundle), /Unrecognized/);
    assert.throws(() => patch(changed.replace('_startRun', '_unsupportedStartRun'), bundle), /Unsupported/);
  }
});

test('plan validates all files before apply, rejects SDK 1.2/unknown versions, check notices changed engine bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-interrupt-adapter-'));
  try {
    mkdirSync(join(root, 'dist/core'), { recursive: true });
    mkdirSync(join(root, 'dist/bundle/chunks'), { recursive: true });
    const manifest = (version) => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
    manifest('1.3.0');
    writeFileSync(join(root, 'dist/core/agent-session.js'), core);
    writeFileSync(join(root, 'dist/bundle/chunks/session.js'), bundled);
    const changes = plan(root);
    assert.equal(changes.length, 3);
    assert.equal(readFileSync(changes[0].path, 'utf8'), core, 'plan does not write');
    const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [install, '--sdk', root, ...args], { cwd: root, encoding: 'utf8' });
    assert.notEqual(run('--check').status, 0);
    assert.equal(run('--apply').status, 0);
    assert.equal(run('--check').status, 0);
    assert.equal(run('--apply').status, 0);
    assert.equal(readFileSync(join(root, 'dist/pi-interrupt-engine.mjs'), 'utf8'), readFileSync(enginePath, 'utf8'));
    writeFileSync(join(root, 'dist/pi-interrupt-engine.mjs'), 'stale engine');
    assert.notEqual(run('--check').status, 0);
    assert.equal(run('--apply').status, 0);
    for (const version of ['1.4.0', '1.5.0']) {
      manifest(version);
      assert.equal(plan(root).length, 3);
      assert.equal(run('--check').status, 0);
    }
    for (const version of ['1.2.0', '1.3.1', '1.3.0-rc', '1.4.1', '1.4.0-rc', '1.5.1', '1.5.0-rc']) {
      manifest(version);
      assert.throws(() => plan(root), /Unsupported SDK identity/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared bundle accepts only exact attachment v1/v2 imports before interrupt and preserves its terminal contract', () => {
  for (const [version, name] of [[1, 'presentFileReferences'], [2, 'presentTypedFileReferences as presentFileReferences']]) {
    const header = `// pi-attachment-presentation-v${version}\nimport { ${name} } from "../../pi-file-references.mjs";\n`;
    const composed = header + patch(bundled, true);
    assert.equal(patch(composed, true), composed);
    assert.throws(() => patch(composed.replace('pi-file-references.mjs', 'unverified.mjs'), true), /Unrecognized/);
    assert.throws(() => patch(composed.replace(name, 'unexpectedExport'), true), /Unrecognized/);
    assert.throws(() => patch('// arbitrary leading code\n' + composed, true), /Unrecognized/);
    assert.throws(() => patch(composed + '\n// trailing code', true), /Unrecognized/);
    assert.throws(() => patch(composed, false), /Unrecognized/);
  }
});

test('pi-subagents lifecycle factory includes transaction work without changing low-level SDK queues', () => {
  const source = `prompt: (text) => session.prompt(text),\n${before}`;
  const updated = patchSubagents(source);
  assert.ok(updated.includes(after));
  assert.equal(patchSubagents(updated), updated);
  assert.throws(() => patchSubagents('unknown factory'), /Unrecognized/);
  assert.throws(() => patchSubagents(updated.replace('session.prompt(text)', 'undefined')), /Unrecognized/);
  assert.throws(() => patchSubagents(`${updated}\n${before}`), /Unrecognized/);
});
