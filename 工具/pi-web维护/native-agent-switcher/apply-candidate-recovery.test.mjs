import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchCandidateRecovery } from './apply-candidate-recovery.mjs';

function fixture(version = '1.2.0') {
  const root = mkdtempSync(join(tmpdir(), 'pi-candidate-sdk-'));
  const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(sdk, 'dist/core'), { recursive: true }); mkdirSync(join(sdk, 'dist/bundle/chunks'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version }));
  const normal = join(sdk, 'dist/core/agent-session.js'); const bundled = join(sdk, 'dist/bundle/chunks/agent.js');
  writeFileSync(normal, '    async abort() {\n        this._retryAttempt++;\n        const delayMs = retryDelayMs(settings, this._retryAttempt);\n');
  writeFileSync(bundled, 'async _prepareRetry(message){async abort(){this._isAgentRunActive;if(this._retryAttempt++,this._retryAttempt>settings.maxRetries){}let delayMs=retryDelayMs(settings,this._retryAttempt);');
  return { root, sdk, normal, bundled };
}

for (const version of ['1.2.0', '1.3.0', '1.4.0', '1.5.0']) test(`candidate ${version} adapter is idempotent and validates regular and bundled hooks`, () => {
  const f = fixture(version);
  try {
    assert.throws(() => patchCandidateRecovery(f.root, { checkOnly: true }), /missing/);
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, 2);
    const before = readFileSync(f.normal, 'utf8');
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, 0);
    assert.equal(patchCandidateRecovery(f.root, { checkOnly: true }).passed, true);
    assert.equal(readFileSync(f.normal, 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const order of ['recovery-first', 'interrupt-first']) test(`candidate adapters compose without duplicate hooks: ${order}`, () => {
  const f = fixture('1.3.0');
  try {
    if (order === 'recovery-first') patchCandidateRecovery(f.root);
    for (const [path, relative] of [[f.normal, '../'], [f.bundled, '../../']]) {
      const prefix = `import { installInterruptSteer as piInstallInterruptSteer } from '${relative}pi-interrupt-engine.mjs';\n`;
      writeFileSync(path, prefix + readFileSync(path, 'utf8'));
    }
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, order === 'interrupt-first' ? 2 : 0);
    assert.equal(patchCandidateRecovery(f.root, { checkOnly: true }).passed, true);
    for (const path of [f.normal, f.bundled]) {
      const text = readFileSync(path, 'utf8');
      assert.ok(text.startsWith('import { installInterruptSteer'));
      assert.equal(text.split('piRecoveryStop(this.sessionManager)').length - 1, 1);
      assert.equal(text.split('recordStop as piRecoveryStop').length - 1, 1);
    }
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const version of ['1.4.0', '1.5.0']) for (const [revision, names] of [
  ['v1', 'presentFileReferences'], ['v2', 'presentTypedFileReferences as presentFileReferences'],
]) test(`recovery preserves the exact ${revision} attachment and interrupt prefix on SDK ${version}`, () => {
  const f = fixture(version);
  try {
    const prefix = `// pi-attachment-presentation-${revision}\nimport { ${names} } from "../../pi-file-references.mjs";\nimport { installInterruptSteer as piInstallInterruptSteer } from '../../pi-interrupt-engine.mjs';\n`;
    writeFileSync(f.bundled, prefix + readFileSync(f.bundled, 'utf8'));
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, 2);
    assert.ok(readFileSync(f.bundled, 'utf8').startsWith(prefix));
    assert.equal(patchCandidateRecovery(f.root, { checkOnly: true }).passed, true);
    assert.equal(patchCandidateRecovery(f.root).changedFiles.length, 0);
    writeFileSync(f.bundled, readFileSync(f.bundled, 'utf8').replace(`presentation-${revision}`, 'presentation-v99'));
    assert.throws(() => patchCandidateRecovery(f.root), /Unsupported attachment prefix/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unsupported SDK and changed patch targets leave both files untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.normal, 'utf8');
    writeFileSync(join(f.sdk, 'package.json'), JSON.stringify({ version: '1.6.0' }));
    assert.throws(() => patchCandidateRecovery(f.root), /tested recovery adapter/);
    writeFileSync(join(f.sdk, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    writeFileSync(f.bundled, 'async _prepareRetry(message){changed}');
    assert.throws(() => patchCandidateRecovery(f.root), /target changed/);
    assert.equal(readFileSync(f.normal, 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an outside patch target is refused without modifying it', () => {
  const f = fixture('1.3.0');
  const outside = f.root + '-outside.js';
  try {
    const original = readFileSync(f.normal, 'utf8');
    writeFileSync(outside, original);
    rmSync(f.normal); symlinkSync(outside, f.normal);
    assert.throws(() => patchCandidateRecovery(f.root), /escapes candidate/);
    assert.equal(readFileSync(outside, 'utf8'), original);
    assert.ok(!readFileSync(f.bundled, 'utf8').includes('piRecoveryStop'));
  } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

test('partly removed hooks are refused rather than marked already applied', () => {
  const f = fixture();
  try {
    patchCandidateRecovery(f.root);
    writeFileSync(f.normal, readFileSync(f.normal, 'utf8').replace('piRecoveryStop(this.sessionManager);', ''));
    assert.throws(() => patchCandidateRecovery(f.root, { checkOnly: true }), /Partial recovery patch/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
