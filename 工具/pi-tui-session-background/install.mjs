import { readFileSync, writeFileSync, readdirSync, realpathSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const marker = '// pi-tui-session-background:1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
export function patch(source, bundled = false) {
  const imported = `import { installTuiBackground as piInstallTuiBackground } from '../../pi-tui-session-background.mjs';\n` +
    (bundled ? '' : `import { emitSessionShutdownEvent } from '../../core/extensions/runner.js';\n`);
  const block = `\n${marker}\n${imported}piInstallTuiBackground(InteractiveMode, emitSessionShutdownEvent);\n// pi-tui-session-background:end\n`;
  const start = source.indexOf(bundled ? 'async run(){' : '    async run() {');
  const end = source.indexOf(bundled ? 'async checkForPackageUpdates(){' : '    async checkForPackageUpdates() {', start);
  if (start < 0 || end < start) throw new Error('Unsupported InteractiveMode.run shape');
  if (source.includes(marker)) {
    if (source.split(block).length !== 2 || !source.includes('await this.runInitialPrompts(initialMessage,initialImages,initialMessages);') ||
        !source.includes('this.promptInForeground(userInput)')) {
      throw new Error('Unrecognized TUI background adapter');
    }
    return source;
  }
  const replacements = bundled ? [
    ['await this.session.prompt(initialMessage,{images:initialImages})', 'await this.promptInForeground(initialMessage,{images:initialImages})'],
    ['await this.session.prompt(message)', 'await this.promptInForeground(message)'],
    ['await this.session.prompt(userInput)', 'await this.promptInForeground(userInput)'],
  ] : [
    ['await this.session.prompt(initialMessage, { images: initialImages });', 'await this.promptInForeground(initialMessage, { images: initialImages });'],
    ['await this.session.prompt(message);', 'await this.promptInForeground(message);'],
    ['await this.session.prompt(userInput);', 'await this.promptInForeground(userInput);'],
  ];
  // Restrict replacements to run(), never touch compaction or other prompt call sites.
  let run = source.slice(start, end);
  for (const [from, to] of replacements) {
    if (run.split(from).length !== 2) throw new Error(`Unsupported TUI input loop: ${from}`);
    run = run.replace(from, to);
  }
  const initialStart = run.indexOf(bundled
    ? 'if(this.maybeWarnAboutAnthropicSubscriptionAuth(),initialMessage)'
    : '        // Process initial messages');
  const initialEnd = run.indexOf(bundled ? 'for(;;){let userInput=' : '        // Main interactive loop', initialStart);
  if (initialStart < 0 || initialEnd < initialStart) throw new Error('Unsupported TUI initial prompt batch');
  run = run.slice(0, initialStart) +
    (bundled ? 'this.maybeWarnAboutAnthropicSubscriptionAuth();' : '') +
    'await this.runInitialPrompts(initialMessage,initialImages,initialMessages);\n' + run.slice(initialEnd);
  if (!source.includes(bundled ? 'var InteractiveMode=class' : 'export class InteractiveMode')) throw new Error('Missing InteractiveMode');
  if (bundled && !source.includes('emitSessionShutdownEvent')) throw new Error('Missing session shutdown emitter');
  const body = source.slice(0, start) + run + source.slice(end);
  // Keep the existing interrupt adapter's leading import and terminal suffix intact.
  // Its maintenance checker deliberately requires those exact boundaries.
  const boundary = body.indexOf('\n// pi-interrupt-steer-adapter:1\n');
  return boundary < 0 ? body + block : body.slice(0, boundary) + block + body.slice(boundary);
}
export function plan(sdkRoot) {
  const root = realpathSync(sdkRoot);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.4.0') {
    throw new Error(`Unsupported SDK: ${manifest.name}@${manifest.version}`);
  }
  const chunks = join(root, 'dist/bundle/chunks');
  const matches = readdirSync(chunks).filter((p) => p.endsWith('.js'))
    .map((p) => join(chunks, p)).filter((p) => readFileSync(p, 'utf8').includes('var InteractiveMode=class'));
  if (matches.length !== 1) throw new Error('Expected exactly one bundled InteractiveMode');
  const files = [join(root, 'dist/modes/interactive/interactive-mode.js'), matches[0]];
  const result = files.map((path, index) => {
    const before = readFileSync(path, 'utf8');
    return { path, before, after: patch(before, index === 1) };
  });
  const path = join(root, 'dist/pi-tui-session-background.mjs');
  result.push({ path, before: existsSync(path) ? readFileSync(path, 'utf8') : null,
    after: readFileSync(join(here, 'background.mjs'), 'utf8') });
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--sdk');
  if (index < 0 || !args[index + 1] || ['--apply', '--check', '--rollback'].filter((mode) => args.includes(mode)).length !== 1) {
    throw new Error('Usage: node install.mjs --sdk PATH --check|--apply|--rollback [--allow-external]');
  }
  const changes = plan(args[index + 1]);
  if (args.includes('--check')) {
    if (changes.some((c) => c.before !== c.after)) throw new Error('TUI background adapter missing/stale');
    console.log('Core TUI, bundled CLI and adapter match');
  } else {
    const outside = relative(realpathSync(process.cwd()), realpathSync(args[index + 1]));
    if ((outside.startsWith('..') || outside.startsWith('/')) && !args.includes('--allow-external')) {
      throw new Error('External activation requires approval and --allow-external');
    }
    const backup = join(realpathSync(args[index + 1]), 'dist/pi-tui-session-background-backup');
    mkdirSync(backup, { recursive: true });
    const receiptPath = join(backup, 'last-apply.json');
    if (args.includes('--rollback')) {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const allowed = new Set(changes.map((c) => c.path));
      if (receipt.version !== 1 || !Array.isArray(receipt.files) || receipt.files.length > 3) throw new Error('Invalid rollback receipt');
      for (const file of receipt.files) {
        if (!allowed.has(file.path) || sha(readFileSync(file.path, 'utf8')) !== file.afterSha) {
          throw new Error('Installed files changed since activation; refusing to overwrite other patches');
        }
        if (file.backup && (dirname(file.backup) !== backup || sha(readFileSync(file.backup, 'utf8')) !== file.beforeSha)) {
          throw new Error('Invalid rollback backup');
        }
      }
      // Restore importers first, then remove a newly introduced adapter module.
      for (const file of receipt.files.filter((file) => file.backup)) copyFileSync(file.backup, file.path);
      for (const file of receipt.files.filter((file) => !file.backup)) unlinkSync(file.path);
      console.log('Restored pre-activation files; existing processes are unchanged');
    } else {
      const files = changes.filter((c) => c.before !== c.after).map((c) => {
        const saved = c.before === null ? null : join(backup, `${sha(c.path).slice(0, 16)}-${sha(c.before).slice(0, 16)}.js`);
        if (saved && !existsSync(saved)) copyFileSync(c.path, saved);
        return { path: c.path, beforeSha: c.before === null ? null : sha(c.before), afterSha: sha(c.after), backup: saved };
      });
      if (files.length) {
        writeFileSync(receiptPath, JSON.stringify({ version: 1, files }, null, 2) + '\n');
        // Make the imported module available before updating either importer.
        for (const c of [changes[2], ...changes.slice(0, 2)]) {
          if (c.before === c.after) continue;
          writeFileSync(c.path, c.after);
          console.log('Patched', c.path);
        }
      } else console.log('TUI background adapter already matches');
    }
  }
}
