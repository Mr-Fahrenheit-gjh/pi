import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve only the selected agent installation; never another host's peers.
export function installedPackageURL(env = process.env, home = homedir()) {
  const agent = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent');
  const root = env.PI_BACKGROUND_TASK_PACKAGE_ROOT?.trim() || path.join(agent, 'npm', 'node_modules', 'pi-background-task');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'pi-background-task') throw new Error('Invalid pi-background-task package root');
  const entry = path.join(root, 'dist/index.js');
  if (!statSync(entry).isFile()) throw new Error('Missing pi-background-task entry');
  return pathToFileURL(entry).href;
}
