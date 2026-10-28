import { readFileSync, writeFileSync, realpathSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export const before = 'hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,';
export const after = 'hasQueuedMessages: () => session.hasPendingInterruptSteer?.() === true || session.agent?.hasQueuedMessages?.() === true,';
export function patch(source) {
  const applied = source.split(after).length === 2 && !source.includes(before);
  if (source.includes(after) && !applied) throw new Error('Unrecognized mixed pi-subagents interrupt patch');
  const original = applied ? source.replace(after, before) : source;
  if (original.split(before).length !== 2 || original.split('prompt: (text) => session.prompt(text),').length !== 2) {
    throw new Error('Unrecognized pi-subagents child factory; refusing interrupt lifecycle patch');
  }
  return applied ? source : source.replace(before, after);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), rootArg = args[args.indexOf('--package') + 1];
  if (!args.includes('--package') || !rootArg || (args.includes('--apply') === args.includes('--check'))) {
    throw new Error('Usage: node apply-subagents.mjs --package <pi-subagents root> --apply|--check [--allow-external]');
  }
  const root = realpathSync(rootArg);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'pi-subagents' || manifest.version !== '0.75.0') throw new Error('Only verified pi-subagents 0.75.0 is supported');
  const target = join(root, 'src/runs/shared/child-session.js');
  const source = readFileSync(target, 'utf8'), updated = patch(source);
  if (args.includes('--check')) {
    if (updated !== source) throw new Error('pi-subagents interrupt lifecycle adapter missing');
    console.log('pi-subagents interrupt lifecycle adapter matches');
  } else if (updated !== source) {
    const outside = relative(realpathSync(process.cwd()), root);
    if ((outside.startsWith('..') || outside.startsWith('/')) && !args.includes('--allow-external')) throw new Error('Confirm external activation first; requires --allow-external');
    const backup = target + '.before-pi-interrupt';
    if (!existsSync(backup)) copyFileSync(target, backup);
    writeFileSync(target, updated);
    console.log('Patched', target);
  }
}
