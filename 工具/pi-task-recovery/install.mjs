import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, lstatSync, readlinkSync, symlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const directory = dirname(fileURLToPath(import.meta.url));
const helper = JSON.stringify(join(directory, 'engine.mjs'));
const importLine = `import { recordStop as piRecoveryStop, retrySpent as piRecoverySpent, recordRetry as piRecoveryRetry } from ${helper};\n`;
const roots = [
  '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent',
  '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent',
];
const backup = join(homedir(), '.pi', 'backups', 'pi-task-recovery-1.2.0');
const link = join(homedir(), '.pi/agent/extensions/task-recovery');
if (existsSync(link) && (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== directory)) throw new Error(`Refusing to replace ${link}`);
const changes = [];
function replaceOne(text, oldText, newText, path) {
  if (text.split(oldText).length !== 2) throw new Error(`Expected one patch target in ${path}: ${oldText.slice(0, 60)}`);
  return text.replace(oldText, newText);
}
for (const root of roots) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (version !== '1.2.0') throw new Error(`Unsupported core version ${version}: ${root}`);
  const paths = [join(root, 'dist/core/agent-session.js')];
  const chunks = join(root, 'dist/bundle/chunks');
  const candidates = readdirSync(chunks).filter(name => name.endsWith('.js')).map(name => join(chunks, name))
    .filter(path => readFileSync(path, 'utf8').includes('async _prepareRetry(message){'));
  if (candidates.length !== 1) throw new Error(`Expected one bundled AgentSession in ${root}, got ${candidates.length}`);
  paths.push(candidates[0]);
  for (const path of paths) {
    const original = readFileSync(path, 'utf8');
    if (original.startsWith(importLine)) continue;
    let text = original;
    if (path.endsWith('/core/agent-session.js')) {
      text = replaceOne(text, '    async abort() {\n', '    async abort() {\n        piRecoveryStop(this.sessionManager);\n', path);
      text = replaceOne(text, '        this._retryAttempt++;\n', '        this._retryAttempt = Math.max(this._retryAttempt, piRecoverySpent(this.sessionManager));\n        this._retryAttempt++;\n', path);
      text = replaceOne(text, '        const delayMs = retryDelayMs(settings, this._retryAttempt);\n', '        piRecoveryRetry(this.sessionManager, this._retryAttempt);\n        const delayMs = retryDelayMs(settings, this._retryAttempt);\n', path);
    } else {
      text = replaceOne(text, 'async abort(){this._isAgentRunActive', 'async abort(){piRecoveryStop(this.sessionManager);this._isAgentRunActive', path);
      text = replaceOne(text, 'if(this._retryAttempt++,this._retryAttempt>settings.maxRetries)', 'this._retryAttempt=Math.max(this._retryAttempt,piRecoverySpent(this.sessionManager));if(this._retryAttempt++,this._retryAttempt>settings.maxRetries)', path);
      text = replaceOne(text, 'let delayMs=retryDelayMs(settings,this._retryAttempt);', 'piRecoveryRetry(this.sessionManager,this._retryAttempt);let delayMs=retryDelayMs(settings,this._retryAttempt);', path);
    }
    changes.push({ path, original, text: importLine + text });
  }
}
// Validate every target before touching either installation. Never copy auth/settings to Git.
mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const change of changes) {
  const suffix = createHash('sha256').update(change.path).digest('hex').slice(0, 12);
  const saved = join(backup, suffix + '.js');
  if (!existsSync(saved)) copyFileSync(change.path, saved);
  writeFileSync(change.path, change.text);
  console.log('Patched', change.path);
}
const settingsPath = join(homedir(), '.pi/agent/settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const retryBefore = settings.retry ?? null;
settings.retry = { ...settings.retry, enabled: true, maxRetries: 3, baseDelayMs: 15000, maxAgentDelayMs: 60000,
  provider: { ...settings.retry?.provider, maxRetries: 0 } };
const temporary = settingsPath + '.recovery-tmp';
writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
renameSync(temporary, settingsPath);
if (!existsSync(link)) symlinkSync(directory, link, 'dir');
else if (!lstatSync(link).isSymbolicLink()) throw new Error(`Refusing to replace ${link}`);
const settingsBackup = join(backup, 'retry-before.json');
if (!existsSync(settingsBackup)) writeFileSync(settingsBackup, JSON.stringify(retryBefore, null, 2) + '\n', { mode: 0o600 });
console.log('Global recovery extension installed; retry delays 15/30/60 seconds, max 3. Restart running hosts to load core hooks.');
