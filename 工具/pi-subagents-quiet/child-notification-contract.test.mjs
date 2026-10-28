import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { configureHostSdk } from './host-sdk.mjs';
import { resolveHostPeerAliases } from '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js';

const host = configureHostSdk();
const { createJiti } = createRequire(`${host}/package.json`)('jiti');
const peers = resolveHostPeerAliases(host);
assert.deepEqual(peers.missing, []);
const load = createJiti(import.meta.url, { alias: peers.aliases, moduleCache: false });
const sdk = await import(`${host}/dist/index.js`);
const { loadExtensionFromFactory } = await import(`${host}/dist/core/extensions/loader.js`);
const { default: childSharedTools } = await load.import('./child-shared-tools.ts');
const { createChildHooks } = await load.import('/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-hooks.js');
const { projectWindow } = await load.import('/Users/guojiahang/.pi/agent/npm/node_modules/notesoup/plugins/pi/window.ts');
const { DEFAULT_SUBAGENT_TOOL_DESCRIPTION, buildSubagentToolPromptMetadata } = await load.import('/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/extension/tool-description.js');
const { buildSystemPrompt } = await import(`${host}/dist/core/system-prompt.js`);
const { formatAsyncStartedMessage } = await load.import('/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js');

async function fixture(t, projectionOrder) {
  const cwd = process.cwd(), bus = sdk.createEventBus(), runtime = sdk.createExtensionRuntime();
  // Use the exact upstream factory and our actual configured child-only entry, not a proxy API.
  const hooks = createChildHooks({ cwd, waitTool: { enabled: true, defaultTimeoutMs: 1000 } });
  const extensions = [];
  const add = async (factory, name) => extensions.push(await loadExtensionFromFactory(factory, cwd, bus, runtime, name));
  await add(hooks[0].factory, hooks[0].name);
  const projection = pi => pi.on('context_with_system', event => ({ messages: projectWindow(event.messages, 'test-window') }));
  if (projectionOrder === 'before') await add(projection, 'notesoup-projection');
  await add(childSharedTools, 'configured-child-shared-tools');
  if (projectionOrder === 'after') await add(projection, 'notesoup-projection');
  const runner = new sdk.ExtensionRunner(extensions, runtime, cwd, sdk.SessionManager.inMemory(), undefined);
  const errors = [];
  runner.onError(error => errors.push(error));
  t.after(() => assert.deepEqual(errors, []));
  const tool = runner.getToolDefinition('bg_wait');
  assert.ok(tool);
  assert.match(tool.description, /This child runtime does not install/);
  assert.match(tool.parameters.properties.id.description, /already notify this session natively/);
  const definition = { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) };
  return { runner, tool, definition };
}

function transcript(wait) {
  return [
    { role: 'system', content: 'BASE', toolsAdded: [wait], timestamp: 1 },
    { role: 'user', content: 'old turn', timestamp: 2 },
    { role: 'system', content: 'DELTA', toolsAdded: [wait, { name: 'other', description: 'unchanged', parameters: { type: 'object' } }], toolsRemoved: ['obsolete'], timestamp: 3 },
    { role: 'custom', customType: 'notesoup/boot', content: 'new window', display: false, details: { windowId: 'test-window' }, timestamp: 4 },
    { role: 'user', content: 'current turn', timestamp: 5 },
    { role: 'system', content: 'LATE', toolsAdded: [wait], toolsRemoved: ['other'], timestamp: 6 },
  ];
}
function descriptionsAreLocal(messages) {
  assert.equal(messages[0].role, 'system');
  for (const message of messages) for (const tool of message.toolsAdded ?? []) {
    if (tool.name !== 'bg_wait') continue;
    assert.match(tool.description, /Routine subagent completion is silent/);
    assert.doesNotMatch(tool.description, /already notify this session natively/);
    for (const schema of Object.values(tool.parameters.properties)) assert.doesNotMatch(schema.description, /already notify this session natively/);
  }
}

test('real child factory + configured child extension + SDK request transform covers initial and delta declarations', async t => {
  const { runner, tool, definition } = await fixture(t);
  const input = transcript(definition), original = structuredClone(input);
  const output = await runner.emitContext(input);
  descriptionsAreLocal(output);
  assert.deepEqual(input, original);
  assert.equal(runner.getToolDefinition('bg_wait').execute, tool.execute);
  assert.match(tool.parameters.properties.id.description, /already notify this session natively/); // Registry/executor remain upstream-owned.
  for (let i = 0; i < input.length; i++) {
    const { toolsAdded: before, ...beforeRest } = input[i];
    const { toolsAdded: after, ...afterRest } = output[i];
    assert.deepEqual(afterRest, beforeRest);
    assert.deepEqual(after?.map(t => t.name), before?.map(t => t.name));
  }
  assert.deepEqual(await runner.emitContext(output), output); // No repeated prefixes or description churn.
});

for (const order of ['before', 'after']) test(`real notesoup reset projection preserves child tool contracts (${order})`, async t => {
  const { runner, definition } = await fixture(t, order);
  const input = transcript(definition), output = await runner.emitContext(input);
  descriptionsAreLocal(output);
  assert.equal(output[1].customType, 'notesoup/boot');
  assert.ok(!output.some(message => message.content === 'old turn'));
  assert.equal(output.at(-1).content, 'LATE');
  assert.deepEqual(output.at(-1).toolsRemoved, ['other']);
});

for (const order of [undefined, 'before', 'after']) test(`child request removes delegation gate from SDK prompt and tool deltas (${order ?? 'plain'})`, async t => {
  const { runner } = await fixture(t, order);
  const metadata = buildSubagentToolPromptMetadata();
  const tool = { name: 'subagent', description: DEFAULT_SUBAGENT_TOOL_DESCRIPTION, parameters: { type: 'object' }, ...metadata };
  const built = buildSystemPrompt({ cwd: process.cwd(), selectedTools: ['subagent'], toolSnippets: { subagent: metadata.promptSnippet }, toolGuidelines: { subagent: metadata.promptGuidelines } });
  const content = built;
  assert.equal(typeof content, 'string');
  assert.match(content, /Do not invoke subagents unless/);
  const input = [{ role: 'system', content, sections: { rules: content, untouched: 'Keep permissions', removed: null }, toolsAdded: [tool], timestamp: 1 },
    { role: 'custom', customType: 'notesoup/boot', content: 'new window', display: false, details: { windowId: 'test-window' }, timestamp: 2 },
    { role: 'user', content: 'Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.', timestamp: 2 },
    { role: 'system', content, toolsAdded: [tool], toolsRemoved: ['obsolete'], timestamp: 3 },
    { role: 'system', content, timestamp: 4 }];
  const original = structuredClone(input);
  const output = await runner.emitContext(input);
  assert.deepEqual(input, original);
  assert.doesNotMatch(output.filter(m => m.role === 'system').map(m => JSON.stringify(m)).join('\n'), /Do not invoke subagents unless|For operator-requested delegation|Direct parent execution is the default/);
  assert.equal(output[2].content, input[2].content); // Never rewrite user or child reports.
  assert.equal(output[0].sections.untouched, 'Keep permissions');
  assert.equal(output[0].sections.removed, order ? undefined : null); // notesoup consumes section deletion patches.
  assert.deepEqual(output[3].toolsRemoved, ['obsolete']);
  assert.deepEqual(await runner.emitContext(output), output);
});

test('SDK child tool_result adapts only dispatch receipts and retains structured payload, images and errors', async t => {
  const { runner } = await fixture(t);
  const event = { type: 'tool_result', toolCallId: 'call', toolName: 'subagent', input: {}, isError: false,
    content: [{ type: 'text', text: formatAsyncStartedMessage('Async workflow [test-run]', false) }, { type: 'image', data: 'fixture', mimeType: 'image/png' }],
    details: { asyncId: 'test-run', results: [] }, structuredContent: { untouched: true },
  };
  const output = await runner.emitToolResult(event);
  assert.match(output.content[0].text, /silent locally/);
  assert.doesNotMatch(output.content[0].text, /Use bg_wait only/);
  assert.equal(output.structuredContent, event.structuredContent);
  assert.equal(output.details, event.details);
  assert.equal(output.content[1], event.content[1]);
  assert.equal(output.isError, false);
  for (const changed of [{ isError: true }, { toolName: 'read' }, { details: { asyncId: 'test-run', results: [{ output: 'report' }] } }]) {
    assert.equal(await runner.emitToolResult({ ...event, ...changed }), undefined);
  }
});
