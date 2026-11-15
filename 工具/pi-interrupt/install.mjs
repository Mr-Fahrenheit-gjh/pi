import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const enginePath = resolve(here, '../pi-web维护/pi-web-source-0.12.1-custom/lib/interrupt-steer.mjs');
const marker = '// pi-interrupt-steer-adapter:1';
export function patch(source, bundled = false) {
  const importLine = `import { installInterruptSteer as piInstallInterruptSteer } from '${bundled ? '../../' : '../'}pi-interrupt-engine.mjs';\n`;
  const suffix = `\n${marker}\npiInstallInterruptSteer(AgentSession);\n`;
  // Attachment presentation precedes our import in the shared CLI chunk.
  // Accept only its exact versioned import, never arbitrary leading source.
  const attachmentHeaders = ['presentFileReferences', 'presentTypedFileReferences as presentFileReferences'].map((name, index) =>
    `// pi-attachment-presentation-v${index + 1}\nimport { ${name} } from "../../pi-file-references.mjs";\n`);
  const header = bundled ? attachmentHeaders.find((value) => source.startsWith(value)) ?? '' : '';
  const prefix = header + importLine;
  const applied = source.includes(marker);
  if (applied && (!source.startsWith(prefix) || !source.endsWith(suffix) || source.split(importLine).length !== 2 || source.split(marker).length !== 2)) {
    throw new Error('Unrecognized interrupt patch shape');
  }
  const original = applied ? source.slice(prefix.length, -suffix.length) : source.slice(header.length);
  const anchors = bundled
    ? ['var AgentSession=class{', 'async _startRun(trigger,onStarted){', 'async _emitAgentSettled(){', 'async _queueSteer(text,images){', 'async waitForIdle(){this.isIdle||await this._getIdleWaitPromise()}']
    : ['export class AgentSession {', '    async _startRun(trigger, onStarted) {', '    async _emitAgentSettled() {', '    async _queueSteer(text, images) {', '    async abort() {'];
  for (const anchor of anchors) {
    if (original.split(anchor).length !== 2) throw new Error(`Unsupported AgentSession source: ${anchor}`);
  }
  return applied ? source : prefix + original + suffix;
}

export function plan(sdkRoot) {
  const root = realpathSync(sdkRoot);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || !['1.3.0', '1.4.0', '1.5.0'].includes(manifest.version)) {
    throw new Error(`Unsupported SDK identity: ${manifest.name}@${manifest.version}`);
  }
  const chunks = join(root, 'dist/bundle/chunks');
  const bundled = readdirSync(chunks).filter((name) => name.endsWith('.js'))
    .map((name) => join(chunks, name)).filter((path) => readFileSync(path, 'utf8').includes('async _prepareRetry(message){'));
  if (bundled.length !== 1) throw new Error('Expected exactly one bundled AgentSession');
  const files = [join(root, 'dist/core/agent-session.js'), bundled[0]];
  return [...files.map((path, index) => {
    const before = readFileSync(path, 'utf8');
    return { path, before, after: patch(before, index === 1) };
  }), { path: join(root, 'dist/pi-interrupt-engine.mjs'),
    before: existsSync(join(root, 'dist/pi-interrupt-engine.mjs')) ? readFileSync(join(root, 'dist/pi-interrupt-engine.mjs'), 'utf8') : null,
    after: readFileSync(enginePath, 'utf8') }];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sdk = args[args.indexOf('--sdk') + 1];
  if (!args.includes('--sdk') || !sdk || (args.includes('--apply') === args.includes('--check'))) {
    throw new Error('Usage: node install.mjs --sdk <SDK root> --check|--apply [--allow-external]');
  }
  const changes = plan(sdk); // Validate both source forms before any writes.
  if (args.includes('--check')) {
    const missing = changes.filter(({ before, after }) => before !== after);
    if (missing.length) throw new Error(`Interrupt adapter missing/stale: ${missing.map(({ path }) => path).join(', ')}`);
    console.log('Pi core, bundled CLI and vendored interrupt engine match');
  } else {
    const outside = relative(realpathSync(process.cwd()), realpathSync(sdk));
    if ((outside.startsWith('..') || outside.startsWith('/')) && !args.includes('--allow-external')) {
      throw new Error('External installation requires explicit --allow-external; confirm activation separately');
    }
    const backup = join(realpathSync(sdk), 'dist/pi-interrupt-backup');
    mkdirSync(backup, { recursive: true });
    for (const change of changes) {
      if (change.before === change.after) continue;
      if (change.before !== null) {
        const saved = join(backup, createHash('sha256').update(change.path).digest('hex').slice(0, 16) + '.js');
        if (!existsSync(saved)) copyFileSync(change.path, saved);
      }
      writeFileSync(change.path, change.after);
      console.log('Patched', change.path);
    }
  }
}
