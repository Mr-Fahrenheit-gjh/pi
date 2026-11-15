import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { abbreviateToolResult, unifySplitPreparation } from './engine.mjs';
import { hasNotesoupContextOwner } from './context-policy.mjs';

export default function workflowIntegrity(pi: ExtensionAPI) {
  const directory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'tool-output');
  function archive(text: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, createHash('sha256').update(text).digest('hex') + '.txt');
    try {
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
    return path;
  }
  pi.on('session_before_compact', event => {
    // A loaded notesoup owns resets/compaction, including when toggled off with
    // existing resets. Do not mutate its preparation or cancel on its behalf.
    if (hasNotesoupContextOwner(pi)) return;
    // Without notesoup, preserve the SDK's native compaction contract.
    unifySplitPreparation(event.preparation);
  });
  pi.on('tool_result', event => {
    try { return abbreviateToolResult(event, archive); }
    catch (error) {
      // Never discard a result if its source could not be saved. No wake/notification.
      pi.appendEntry('workflow-output-archive-error', { tool: event.toolName, error: String(error) });
      return;
    }
  });
}
