import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve only the selected agent installation; never another host's peers.
export function installedPackageURL(env = process.env, home = homedir()) {
  const agent = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent');
  const root = env.PI_SUBAGENTS_PACKAGE_ROOT?.trim() || path.join(agent, 'npm', 'node_modules', 'pi-subagents');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'pi-subagents') throw new Error('Invalid pi-subagents package root');
  const entry = path.join(root, 'index.js');
  if (!statSync(entry).isFile()) throw new Error('Missing pi-subagents entry');
  return pathToFileURL(entry).href;
}
