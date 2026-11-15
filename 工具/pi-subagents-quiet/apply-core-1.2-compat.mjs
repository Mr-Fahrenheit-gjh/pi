// Reapply after reinstalling pi-subagents. Refuse unknown upstream changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const path = join(homedir(), '.pi/agent/npm/node_modules/pi-subagents/src/watchdog/runtime.js');
const before = '        const incomingPrompt = promptFromBeforeAgentStart(event);';
const after = '        // Pi 1.2 custom continuations have no user prompt: keep the actual task.\n        const incomingPrompt = event?.messageType === "custom" ? this.userPrompt : promptFromBeforeAgentStart(event);';
const source = readFileSync(path, 'utf8');
if (source.includes(after)) console.log('Pi 1.2 compatibility patch already applied');
else {
  if (source.split(before).length !== 2) throw new Error('Upstream watchdog changed; review compatibility before patching');
  writeFileSync(path, source.replace(before, after));
  console.log('Applied Pi 1.2 watchdog compatibility patch');
}
