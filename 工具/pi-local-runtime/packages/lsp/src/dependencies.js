// Pi peer imports are resolved by the active host's official extension loader.
// No process-wide hooks and no fallback to a different Pi host.
export { Type } from 'typebox';
export { defineTool } from '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const localRequire = createRequire(import.meta.url);
const installedRequire = createRequire(join(homedir(), '.pi/agent/npm/package.json'));
const helpers = new Set(['@spences10/pi-child-env', '@spences10/pi-project-trust', '@spences10/pi-tui-modal']);
export function resolve_helper(name) {
    if (!helpers.has(name)) throw new Error(`Not an LSP helper: ${name}`);
    try { return localRequire.resolve(name); }
    catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return installedRequire.resolve(name);
    }
}
// Imports stay inside Pi's jiti graph, so transitive peer imports use host aliases.
export const { create_child_process_env: create_shared_child_process_env } = await import(resolve_helper('@spences10/pi-child-env'));
export const { resolve_project_trust, create_project_trust_wrapper } = await import(resolve_helper('@spences10/pi-project-trust'));
export const { show_command_output_modal, show_picker_modal } = await import(resolve_helper('@spences10/pi-tui-modal'));
