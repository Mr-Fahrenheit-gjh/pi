// Candidate-only SDK adapter. Configuration/credentials/global installations are never written.
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../pi-task-recovery/engine.mjs', import.meta.url));
const importLine = `import { recordStop as piRecoveryStop, retrySpent as piRecoverySpent, recordRetry as piRecoveryRetry } from ${JSON.stringify(helper)};\n`;
export function patchCandidateRecovery(packageRoot, { checkOnly = false } = {}) {
  const root = realpathSync(packageRoot);
  if (root.includes('/lib/node_modules/') || root.includes('/.npm/_npx/')) throw new Error('Global/npm installations are not candidate roots');
  const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  if (!realpathSync(sdk).startsWith(root + '/')) throw new Error('Candidate SDK must not link to an outside installation');
  const version = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version;
  if (!['1.2.0', '1.3.0', '1.4.0'].includes(version)) throw new Error(`SDK ${version} requires a tested recovery adapter`);
  const chunks = join(sdk, 'dist/bundle/chunks');
  const bundled = readdirSync(chunks).filter(name => name.endsWith('.js')).map(name => join(chunks, name)).filter(path => readFileSync(path, 'utf8').includes('async _prepareRetry(message){'));
  if (bundled.length !== 1) throw new Error('Expected exactly one bundled AgentSession');
  const changes = [];
  for (const path of [join(sdk, 'dist/core/agent-session.js'), bundled[0]]) {
    if (!realpathSync(path).startsWith(root + '/')) throw new Error(`SDK patch target escapes candidate: ${path}`);
    const original = readFileSync(path, 'utf8');
    const regular = path.endsWith('/core/agent-session.js');
    const interruptImport = `import { installInterruptSteer as piInstallInterruptSteer } from '${regular ? '../' : '../../'}pi-interrupt-engine.mjs';\n`;
    const prefix = ['1.3.0', '1.4.0'].includes(version) && original.startsWith(interruptImport) ? interruptImport : '';
    if (original.slice(prefix.length).startsWith(importLine)) {
      for (const marker of ['piRecoveryStop(this.sessionManager)', 'piRecoverySpent(this.sessionManager)', 'piRecoveryRetry(this.sessionManager']) if (!original.includes(marker)) throw new Error(`Partial recovery patch: ${path}`);
      continue;
    }
    if (original.includes(importLine)) throw new Error(`Unrecognized recovery import order: ${path}`);
    if (checkOnly) throw new Error(`Recovery adapter missing: ${path}`);
    const replacements = regular ? [
      ['    async abort() {\n', '    async abort() {\n        piRecoveryStop(this.sessionManager);\n'],
      ['        this._retryAttempt++;\n', '        this._retryAttempt = Math.max(this._retryAttempt, piRecoverySpent(this.sessionManager));\n        this._retryAttempt++;\n'],
      ['        const delayMs = retryDelayMs(settings, this._retryAttempt);\n', '        piRecoveryRetry(this.sessionManager, this._retryAttempt);\n        const delayMs = retryDelayMs(settings, this._retryAttempt);\n'],
    ] : [
      ['async abort(){this._isAgentRunActive', 'async abort(){piRecoveryStop(this.sessionManager);this._isAgentRunActive'],
      ['if(this._retryAttempt++,this._retryAttempt>settings.maxRetries)', 'this._retryAttempt=Math.max(this._retryAttempt,piRecoverySpent(this.sessionManager));if(this._retryAttempt++,this._retryAttempt>settings.maxRetries)'],
      ['let delayMs=retryDelayMs(settings,this._retryAttempt);', 'piRecoveryRetry(this.sessionManager,this._retryAttempt);let delayMs=retryDelayMs(settings,this._retryAttempt);'],
    ];
    let text = original;
    for (const [before, after] of replacements) {
      if (text.split(before).length !== 2) throw new Error(`SDK patch target changed: ${path}`);
      text = text.replace(before, after);
    }
    changes.push({ path, text: prefix + importLine + text.slice(prefix.length) });
  }
  // Validate every normal/bundled target before writing either file.
  for (const change of changes) writeFileSync(change.path, change.text);
  return { passed: true, sdkVersion: version, changedFiles: changes.map(change => change.path), checkOnly };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node apply-candidate-recovery.mjs PACKAGE_ROOT [--check]');
  console.log(JSON.stringify(patchCandidateRecovery(process.argv[2], { checkOnly: process.argv.includes('--check') })));
}
