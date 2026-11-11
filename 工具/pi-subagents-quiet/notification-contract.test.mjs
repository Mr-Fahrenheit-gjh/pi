import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptToolContract, adaptAsyncReceipt } from './notification-contract.mjs';
import { quietSubagentAPI } from './quiet-api.ts';
import { configureHostSdk } from './host-sdk.mjs';
import { createRequire } from 'node:module';
import { resolveHostPeerAliases } from '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js';
const host = configureHostSdk();
const { createJiti } = createRequire(`${host}/package.json`)('jiti');
const { buildSystemPrompt } = await import(`${host}/dist/core/system-prompt.js`);
const aliases = resolveHostPeerAliases(host);
assert.deepEqual(aliases.missing, []);
// Use the real host's peer aliases, as the SDK/child loader does. No npm links or installs.
const load = createJiti(import.meta.url, { alias: aliases.aliases, moduleCache: false });
const source = '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src';
const { DEFAULT_SUBAGENT_TOOL_DESCRIPTION, buildSubagentToolPromptMetadata } = await load.import(`${source}/extension/tool-description.js`);
const { SubagentParams } = await load.import(`${source}/extension/schemas.js`);
const { registerWaitTool } = await load.import(`${source}/runs/background/wait-tool.js`);
const { formatAsyncStartedMessage } = await load.import(`${source}/runs/background/async-execution.js`);
const receipt = interactive => ({ content: [{ type: 'text', text: formatAsyncStartedMessage('Async workflow [test-run]', interactive) }], details: { asyncId: 'test-run', asyncDir: '/tmp/test-run', mode: 'workflow', results: [] } });

function omitDescriptions(value) {
  if (Array.isArray(value)) return value.map(omitDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, omitDescriptions(item)]));
}

test('subagent contract removes the opt-in gate and preserves execution boundaries', () => {
  const tool = { name: 'subagent', description: DEFAULT_SUBAGENT_TOOL_DESCRIPTION, parameters: {}, ...buildSubagentToolPromptMetadata() };
  const changed = adaptToolContract(tool);
  assert.match(changed.description, /completion is recorded silently/);
  assert.doesNotMatch(changed.description, /Native async completion wakes/);
  assert.doesNotMatch(changed.description, /Direct parent execution is the default|delegation is authorized by the operator/);
  assert.deepEqual(changed.promptGuidelines, []);
  assert.match(changed.promptSnippet, /^For delegation, use subagents;/);
  assert.match(changed.promptSnippet, /one bounded child uses \{agent,task,async:true\}/);
  assert.match(changed.promptSnippet, /one file-backed workflow call/);
  assert.equal(adaptToolContract(changed), changed);
  assert.match(tool.promptGuidelines[0], /Do not invoke subagents unless/);
  const prompt = buildSystemPrompt({ cwd: process.cwd(), selectedTools: ['subagent'], toolSnippets: { subagent: changed.promptSnippet }, toolGuidelines: { subagent: changed.promptGuidelines } });
  assert.doesNotMatch(prompt, /Do not invoke subagents unless|For operator-requested delegation/);
  for (const text of ['infrastructure blocker', 'one writer', 'workflow call with async:true', 'outputReference']) {
    assert.ok(changed.description.includes(text), text);
  }
  assert.equal(changed.parameters, tool.parameters);
  assert.ok(tool.description.includes('Native async completion wakes'));
});

test('subagent prefers direct children and file-backed workflows without changing execution or schema semantics', () => {
  const tool = { name: 'subagent', description: DEFAULT_SUBAGENT_TOOL_DESCRIPTION, parameters: SubagentParams, execute() {}, ...buildSubagentToolPromptMetadata() };
  const originalDescription = tool.parameters.properties.workflow.description;
  const changed = adaptToolContract(tool);
  assert.match(changed.description, /For one bounded child, prefer direct \{agent,task,async:true\}/);
  assert.match(changed.description, /first write.*unique file/);
  assert.match(changed.description, /workflow:'\/absolute\/path\/workflow.js'/);
  assert.match(changed.description, /same assistant message/);
  assert.match(changed.description, /found 0.*file path.*instead of repeating workflow:true/);
  assert.doesNotMatch(changed.description, /Workflow script: write it as one/);
  assert.match(changed.parameters.properties.workflow.description, /Prefer a script file path/);
  assert.match(changed.parameters.properties.workflow.description, /true remains valid/);
  assert.deepEqual(omitDescriptions(changed.parameters), omitDescriptions(tool.parameters));
  assert.equal(changed.execute, tool.execute);
  assert.equal(tool.parameters.properties.workflow.description, originalDescription);
  for (const [key, schema] of Object.entries(tool.parameters.properties)) {
    if (key !== 'workflow') assert.equal(changed.parameters.properties[key], schema);
  }
  for (const symbol of Object.getOwnPropertySymbols(tool.parameters.properties.workflow)) assert.equal(changed.parameters.properties.workflow[symbol], tool.parameters.properties.workflow[symbol]);
  assert.equal(adaptToolContract(changed), changed);
});

test('root and child wait tools have matching descriptions without changing schema semantics', () => {
  for (const child of [undefined, { nestedRootRunId: 'owned' }]) {
    let original;
    registerWaitTool({ registerTool: tool => { original = tool; }, events: {} }, {}, true, undefined, undefined, child);
    const changed = adaptToolContract(original);
    assert.match(changed.description, /Routine subagent completion is silent/);
    assert.doesNotMatch(changed.description, /already notify this session natively/);
    assert.match(changed.description, /Provider extensions must be explicitly loaded/);
    assert.match(changed.description, /nonBlocking: true/);
    assert.deepEqual(omitDescriptions(changed.parameters), omitDescriptions(original.parameters));
    for (const schema of Object.values(changed.parameters.properties)) assert.doesNotMatch(schema.description, /already notify this session natively/);
    assert.equal(changed.execute, original.execute);
    assert.notEqual(changed.parameters.properties.id, original.parameters.properties.id);
    for (const symbol of Object.getOwnPropertySymbols(original.parameters.properties.id)) assert.equal(changed.parameters.properties.id[symbol], original.parameters.properties.id[symbol]);
  }
});

test('disabled wait notice and unrelated tools are preserved', () => {
  let original;
  registerWaitTool({ registerTool: tool => { original = tool; }, events: {} }, {}, false);
  assert.match(adaptToolContract(original).description, /bg_wait is disabled/);
  const other = { name: 'some-tool', description: 'Native async completion wakes', parameters: {} };
  assert.equal(adaptToolContract(other), other);
});

test('actual interactive/headless dispatch receipts preserve run data and stop promising native wakes', () => {
  for (const interactive of [true, false]) {
    const original = receipt(interactive);
    original.structuredContent = { untouched: true };
    original.content.push({ type: 'image', data: 'fixture', mimeType: 'image/png' });
    original.content[0].text += '\nMission: unchanged';
    const changed = adaptAsyncReceipt(original);
    assert.match(changed.content[0].text, /silent/);
    assert.match(changed.content[0].text, /blocking bg_wait/);
    assert.doesNotMatch(changed.content[0].text, /Pi will wake you|do not need a wait call|Use bg_wait only/);
    assert.ok(changed.content[0].text.startsWith('Async workflow [test-run]'));
    assert.ok(changed.content[0].text.endsWith('Mission: unchanged'));
    assert.equal(changed.details, original.details);
    assert.equal(changed.structuredContent, original.structuredContent);
    assert.equal(changed.content[1], original.content[1]);
    assert.equal(adaptAsyncReceipt(changed), changed);
  }
});

test('status, child reports, errors and results without dispatch identity remain untouched', () => {
  const source = receipt(true);
  for (const result of [{ ...source, details: undefined }, { ...source, isError: true }, { ...source, details: { ...source.details, results: [{ output: 'report' }] } }]) assert.equal(adaptAsyncReceipt(result), result);
});

test('registration wrapper preserves metadata, arguments, updates, errors and unrelated tools', async () => {
  const tools = [];
  const pi = { registerTool: tool => tools.push(tool) };
  const api = quietSubagentAPI(pi);
  const input = { action: 'resume' }, controller = new AbortController(), context = {};
  let seen;
  const original = { name: 'subagent', label: 'Subagent', description: DEFAULT_SUBAGENT_TOOL_DESCRIPTION, parameters: {}, exposure: 'model-only', renderResult: () => 'render',
    async execute(...args) { seen = args; assert.equal(this, original); args[3]?.(receipt(true)); return receipt(true); } };
  api.registerTool(original);
  const tool = tools[0], updates = [];
  const result = await tool.execute('call-id', input, controller.signal, update => updates.push(update), context);
  assert.deepEqual(seen.slice(0, 3), ['call-id', input, controller.signal]);
  assert.equal(seen[4], context);
  assert.equal(tool.exposure, 'model-only');
  assert.equal(tool.renderResult, original.renderResult);
  assert.match(updates[0].content[0].text, /recorded silently/);
  assert.match(result.content[0].text, /recorded silently/);
  const failure = new Error('preserve upstream failure');
  api.registerTool({ ...original, execute() { throw failure; } });
  await assert.rejects(tools[1].execute(), error => error === failure);
  const other = { name: 'read', description: 'unchanged' };
  api.registerTool(other);
  assert.equal(tools[2], other);
});
