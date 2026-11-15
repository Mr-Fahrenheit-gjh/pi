import assert from 'node:assert/strict';
import profiles, { LSP_NAMES } from '../index.ts';
let command;
let writes = 0;
const names = ['read', 'edit', 'write', 'bash', 'memory', 'todo', 'subagent', 'computer_use_status', 'agent_browser', 'chatgpt_computer_use', 'credential_login', ...LSP_NAMES];
let active = [...names];
const make = (name, path = `/mock/${name}`) => ({ name, description: name, parameters: {}, sourceInfo: { path, source: 'extension', scope: 'temporary', origin: 'top-level' } });
let all = names.map(n => make(n));
const api = {
  registerCommand(name, definition) { assert.equal(name, 'tool-profile'); command = definition; },
  getActiveTools: () => [...active], getAllTools: () => all.map(t => ({ ...t })),
  setActiveTools(names) { writes++; active = names; },
};
profiles(api);
assert.equal(writes, 0);
const notices = [];
const ctx = { isIdle: () => true, ui: { notify: s => notices.push(s) } };
const run = p => command.handler(p, ctx);
await run('general');
for (const name of ['read', 'edit', 'write', 'bash', 'memory', 'todo', 'subagent', 'computer_use_status', 'agent_browser']) assert(active.includes(name));
for (const name of [...LSP_NAMES, 'chatgpt_computer_use', 'credential_login']) assert(!active.includes(name));
await run('coding');
for (const name of LSP_NAMES) assert(active.includes(name));
assert(!active.includes('credential_login'));
await run('full');
assert.deepEqual(new Set(active), new Set(names));
await run('general');
active.push('late_browser', 'chatgpt_computer_use');
active = active.filter(n => n !== 'agent_browser');
// Different extension with same name, even same schema reference, must not restore.
const old = all.find(t => t.name === 'lsp_hover');
all = all.map(t => t.name === 'lsp_hover' ? { ...old, sourceInfo: { ...old.sourceInfo, path: '/replacement' } } : t);
// Same source metadata but a different schema value must not restore either.
all = all.map(t => t.name === 'lsp_definition' ? { ...t, parameters: { type: 'string' } } : t);
all = all.filter(t => t.name !== 'credential_login'); // authorization narrowed
await run('coding');
assert(active.includes('late_browser'));
assert(!active.includes('agent_browser'));
assert(!active.includes('chatgpt_computer_use'));
assert(!active.includes('lsp_hover'));
assert(!active.includes('lsp_definition'));
await run('full');
assert(active.includes('chatgpt_computer_use'));
assert(!active.includes('credential_login'));
assert(!active.includes('lsp_hover'));
// A replacement that its owner explicitly activates can be hidden by a new command.
active.push('lsp_hover');
await run('general');
await run('coding');
assert(active.includes('lsp_hover'));
const before = writes;
await command.handler('general', { ...ctx, isIdle: () => false });
await run('oops');
await run('status');
assert.equal(writes, before);
assert(notices.at(-1).includes('Active:'));
assert.deepEqual(command.getArgumentCompletions('co'), [{ value: 'coding', label: 'coding' }]);
await run('general');
profiles(api); // fresh instance has no restoration claims
await run('full');
assert(!active.includes('lsp_hover'));
// Missing provenance fails closed; cloned provenance with equal values restores.
active = ['lsp_hover', 'lsp_definition'];
all = [make('lsp_hover'), { name: 'lsp_definition', parameters: {} }];
await run('general');
all = all.map(t => t.sourceInfo ? { ...t, sourceInfo: { ...t.sourceInfo } } : t);
await run('full');
assert.deepEqual(active, ['lsp_hover']);
// JSON object key order and allocation are not definition changes.
active = ['credential_login'];
all = [{ ...make('credential_login'), parameters: { type: 'object', properties: { x: { type: 'string', description: 'x' } } } }];
await run('general');
all = [{ ...structuredClone(all[0]), parameters: { properties: { x: { description: 'x', type: 'string' } }, type: 'object' } }];
await run('full');
assert.deepEqual(active, ['credential_login']);
// Snapshot values, not mutable objects: detect in-place source/schema/description changes.
for (const mutate of [
  t => { t.sourceInfo.path = '/other-extension'; },
  t => { t.parameters.type = 'string'; },
  t => { t.description = 'different executor contract'; },
  t => { t.promptGuidelines = ['Different guidance']; },
]) {
  active = ['credential_login'];
  all = [make('credential_login')];
  await run('general');
  mutate(all[0]);
  await run('full');
  assert.deepEqual(active, []);
}
// Cyclic or non-JSON schema cannot establish a restoration claim.
const cyclic = {};
cyclic.self = cyclic;
for (const parameters of [cyclic, { unsupported: () => {} }, { value: BigInt(1) }]) {
  active = ['credential_login'];
  all = [{ ...make('credential_login'), parameters }];
  await run('general');
  await run('full');
  assert.deepEqual(active, []);
}
console.log('PASS mock: round trips, external changes, source/schema/description replacements, cloned/reordered metadata, narrowed registry, busy/status, missing identity');
