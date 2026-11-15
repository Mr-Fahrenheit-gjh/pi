// Offline checks only. Run via run-checks.sh with a scrubbed environment.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const host = process.env.BROWSER_TEST_HOST;
assert(host && process.env.PI_OFFLINE === '1');
const requireHost = createRequire(`${host}/package.json`);
const { createJiti } = requireHost('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false });
const { installAdapter, BASIC_KEYS } = await jiti.import(`${root}/adapter.ts`);
const { COMPATIBILITY, assertRuntimeCompatibility, resolveUpstreamRoot } = await jiti.import(`${root}/compat.ts`);
const { createEventBus, createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } = await import(`${host}/dist/index.js`);
const { loadExtensions } = await import(`${host}/dist/core/extensions/loader.js`);
const upstreamRoot = resolveUpstreamRoot();
const compatibility = assertRuntimeCompatibility(upstreamRoot, host);
assert.deepEqual(compatibility, { host: COMPATIBILITY.hostVersion, upstream: COMPATIBILITY.upstreamVersion });
const incompatibleHost = resolve('incompatible-host');
mkdirSync(incompatibleHost, { recursive: true });
writeFileSync(`${incompatibleHost}/package.json`, JSON.stringify({ name: COMPATIBILITY.hostPackage, version: '0.0.0-test' }));
assert.throws(() => assertRuntimeCompatibility(upstreamRoot, incompatibleHost), error =>
  error instanceof Error && error.message.includes(`expected ${COMPATIBILITY.hostVersion}, found 0.0.0-test`) && error.message.includes(incompatibleHost));
assert.throws(() => resolveUpstreamRoot({ home: resolve('missing-home'), piAgentDir: resolve('missing-agent') }), error =>
  error instanceof Error && error.message.includes(`requires ${COMPATIBILITY.upstreamPackage} ${COMPATIBILITY.upstreamVersion}`) && error.message.includes('no cwd search or network'));
const upstream = `${upstreamRoot}/dist/extensions/agent-browser/index.js`;
const captured = await loadExtensions([upstream], process.cwd(), createEventBus());
assert.deepEqual(captured.errors, []);
const original = captured.extensions[0].tools.get('agent_browser').definition;
// Cross-extension duplicates differ from same-extension replacement: first wins.
const { ExtensionRunner } = await import(`${host}/dist/core/extensions/runner.js`);
const competing = { ...original, description: 'second registration' };
const duplicateExtensions = [captured.extensions[0], { tools: new Map([['agent_browser', { definition: competing }]]) }];
assert.equal(ExtensionRunner.prototype.getAllRegisteredTools.call({ extensions: duplicateExtensions }).find(t => t.definition.name === 'agent_browser').definition, original);
console.log('PASS real host cross-extension duplicate: first registration wins (do not co-load upstream)');
const modes = ['script','args','semanticAction','job','qa','sourceLookup','networkSourceLookup','electron'];
const aiRoot = requireHost.resolve.paths('@earendil-works/pi-ai').map(path => `${path}/@earendil-works/pi-ai`).find(path => existsSync(`${path}/package.json`));
assert(aiRoot);
const { validateToolArguments } = await import(`${aiRoot}/dist/index.js`);
const modeInputs = [
  { script: 'emit(1)' }, { args: ['get','title'] },
  { semanticAction: { action: 'click', selector: '#synthetic' } },
  { job: { steps: [{ action: 'snapshot' }] } }, { qa: { attached: true } },
  { sourceLookup: { componentName: 'Synthetic' } },
  { networkSourceLookup: { requestId: 'synthetic' } }, { electron: { action: 'list' } },
];
assert(modes.every(key => original.parameters.properties[key]));

// Synthetic factory: no original execute() invocation, no subprocess/browser.
const tools = new Map(), commands = new Map(), hooks = [];
let active = ['read', 'agent_browser'];
let call;
const sentinel = { content: [{ type: 'text', text: 'synthetic result' }], details: { sentinel: true } };
const execute = (...args) => { call = args; return Promise.resolve(sentinel); };
const originalSnapshot = JSON.stringify(original);
const mockOriginal = Object.freeze({ ...original, execute });
const hook = () => ({ block: true, reason: 'synthetic safety boundary' });
await installAdapter({
  registerTool: t => tools.set(t.name, t),
  registerCommand: (n,c) => commands.set(n,c),
  on: (n,h) => hooks.push([n,h]),
  getActiveTools: () => [...active],
  setActiveTools: names => { active = [...names]; },
}, pi => { pi.on('tool_call', hook); pi.registerTool(mockOriginal); });
const oldRoute = 'For agent_browser, use open → snapshot -i → @refs; re-snapshot after changes.';
const oldArgsRoute = 'Start with open → snapshot -i → act on current @refs; re-snapshot after page changes.';
const route = 'For public webpage introductions and fact lookup, prefer the existing brave-search skill. For a known public URL, prefer that skill\'s content command; agent_browser read <url> is an alternative. Stop when the text is sufficient. Use agent_browser open only when browser rendering or DOM inspection is needed.';
const interaction = 'For agent_browser click/fill interactions, use snapshot -i and current @refs; re-snapshot after page changes.';
function assertRouting(tool, guidelines = tool.promptGuidelines) {
  assert(guidelines.includes(route), 'shared read-only routing must prefer brave-search content for known public URLs and stop after sufficient text');
  const text = [tool.description, tool.parameters.properties.args.description, ...guidelines].join('\n');
  assert(!text.includes(oldRoute));
  assert(!text.includes(oldArgsRoute));
  assert(!text.includes('default `args` for open → snapshot'));
  assert(!guidelines.includes('Use agent_browser for real browser or live web content.'));
  assert(!guidelines.includes('Prefer agent_browser_web_search for facts; agent_browser for pages.'));
  for (const line of original.promptGuidelines) {
    if (line.startsWith(oldRoute)) assert(guidelines.includes(line.replace(oldRoute, interaction)), 'same-line authorization safety must survive exactly');
    else if (!['Use agent_browser for real browser or live web content.', 'Prefer agent_browser_web_search for facts; agent_browser for pages.'].includes(line) && !line.startsWith('Use agent_browser with one input mode:')) assert(guidelines.includes(line), 'all other safety/docs rules preserved');
  }
  assert.deepEqual(tool.parameters.properties.args, { ...original.parameters.properties.args, description: original.parameters.properties.args.description.replace(oldArgsRoute, interaction) });
  assert.equal(JSON.stringify(original), originalSnapshot, 'upstream must not be mutated');
}
const basic = tools.get('agent_browser');
assertRouting(basic);
assert.deepEqual(Object.keys(basic.parameters.properties), BASIC_KEYS);
assert.equal(hooks[0][1], hook);
assert.equal(basic.renderCall, original.renderCall);
assert.equal(basic.renderResult, original.renderResult);
assert.equal(basic.promptGuidelines.length, original.promptGuidelines.length);
const signal = new AbortController().signal, update = () => {}, context = {};
for (const args of [['get','title'], ['snapshot','-i'], ['fill','#field','hello'], ['click','#button'], ['eval','--stdin'], ['batch','--bail']]) {
  const input = { args, ...(args[0] === 'eval' ? { stdin: 'document.title' } : {}) };
  assert.equal(await basic.execute('id', input, signal, update, context), sentinel);
  assert.deepEqual(call, ['id', input, signal, update, context]);
  assert.equal(call[1], input);
}
for (const input of [{ script: 'return 1' }, { args: ['get','title'], unknown: 'DO_NOT_ECHO' }, { electron: null }]) {
  assert.throws(() => basic.prepareArguments(input), /\/browser-mode full/);
  assert.throws(() => basic.execute('id', input), /\/browser-mode full/);
}
const notices = [];
const ctx = { isIdle: () => true, ui: { notify: text => notices.push(text) } };
await commands.get('browser-mode').handler('full', ctx);
assert.notEqual(tools.get('agent_browser'), mockOriginal);
assertRouting(tools.get('agent_browser'));
assert.equal(mockOriginal.description, original.description);
assert.equal(mockOriginal.parameters, original.parameters);
assert.equal(mockOriginal.promptGuidelines, original.promptGuidelines);
assert.equal(tools.get('agent_browser').execute, execute);
assert(modes.every(key => tools.get('agent_browser').parameters.properties[key]));
await commands.get('browser-mode').handler('basic', ctx);
await commands.get('browser-mode').handler('full', { ...ctx, isIdle: () => false });
assert.equal(tools.get('agent_browser'), basic);
assert.deepEqual(active, ['read','agent_browser']);
console.log('PASS synthetic delegation, recoverable rejection, full 8 modes, hooks/renderers preserved, idle guard');
// Both upstream prefix variants must share routing without enabling a companion.
const companionPrefix = 'Prefer agent_browser_web_search for facts; agent_browser for pages.';
let variantTool;
const variantCommands = new Map();
await installAdapter({ registerTool: t => { variantTool = t; }, registerCommand: (n,c) => variantCommands.set(n,c), getActiveTools: () => [], setActiveTools: () => assert.fail('must not activate tools') }, pi => pi.registerTool({ ...mockOriginal, promptGuidelines: original.promptGuidelines.map(line => line === 'Use agent_browser for real browser or live web content.' ? companionPrefix : line) }));
assertRouting(variantTool);
await variantCommands.get('browser-mode').handler('full', ctx);
assertRouting(variantTool);
console.log('PASS exact routing/safety contracts in basic/full, both prefix variants, upstream immutability');

const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: resolve('absent-auth.json'), modelsStorePath: resolve('absent-store.json'), refreshOnCreate: false, allowModelNetwork: false });
// No prompt to an LLM: only registered slash commands run below.
modelRuntime.stream = modelRuntime.streamSimple = () => { throw new Error('LLM forbidden'); };
for (const allowlist of [undefined, ['read'], ['read','agent_browser']]) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: resolve('agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [`${root}/index.ts`],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: resolve('agent'), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()), modelRuntime, ...(allowlist ? { tools: allowlist } : {}) });
  await session.bindExtensions({});
  const visible = () => session.agent.state.tools.find(t => t.name === 'agent_browser');
  const before = session.getActiveToolNames();
  const enabled = !allowlist || allowlist.includes('agent_browser');
  assert.equal(!!visible(), enabled);
  if (enabled) {
    assert.deepEqual(Object.keys(visible().parameters.properties), BASIC_KEYS);
    assert.throws(() => visible().prepareArguments({ script: 'return 1' }), /\/browser-mode full/);
    await assert.rejects(visible().execute('unsupported', { args: ['get','title'], unknown: 'synthetic' }), /\/browser-mode full/);
    assertRouting(visible(), session.getAllTools().find(t => t.name === 'agent_browser').promptGuidelines);
    assert(session.systemPrompt.includes(route));
    for (const key of BASIC_KEYS.filter(key => key !== 'args')) assert.deepEqual(visible().parameters.properties[key], original.parameters.properties[key]);
  }
  await session.prompt('/browser-mode full');
  assert.deepEqual(session.getActiveToolNames(), before);
  if (enabled) {
    assert.deepEqual(visible().parameters, { ...original.parameters, properties: { ...original.parameters.properties, args: basic.parameters.properties.args } });
    for (const input of modeInputs) {
      assert.deepEqual(validateToolArguments(visible(), { type: 'toolCall', id: 'schema-only', name: 'agent_browser', arguments: input }), input);
    }
    const metadata = session.getAllTools().find(t => t.name === 'agent_browser');
    assertRouting(visible(), metadata.promptGuidelines);
    assert(session.systemPrompt.includes(route));
    assert(!session.systemPrompt.includes(oldRoute));
    assert(session.systemPrompt.includes(original.promptGuidelines.find(line => line.includes('one input mode'))));
  }
  await session.prompt('/browser-mode basic');
  assert.deepEqual(session.getActiveToolNames(), before);
  if (enabled) {
    assert.deepEqual(Object.keys(visible().parameters.properties), BASIC_KEYS);
    assert(!session.systemPrompt.includes('one input mode: script'));
    assert(session.systemPrompt.includes('/browser-mode full'));
    assertRouting(visible(), session.getAllTools().find(t => t.name === 'agent_browser').promptGuidelines);
    assert(session.systemPrompt.includes(route));
    // Preserve manual deactivation even with a host allowlist.
    session.setActiveToolsByName(['read']);
    await session.prompt('/browser-mode full');
    assert.deepEqual(session.getActiveToolNames(), ['read']);
  }
  session.dispose();
  console.log(`PASS real host ${host}: allowlist=${JSON.stringify(allowlist ?? 'default')}, same-name live schema/prompt replacement`);
}
const fullSchemaBytes = Buffer.byteLength(JSON.stringify(original.parameters));
const basicSchemaBytes = Buffer.byteLength(JSON.stringify(basic.parameters));
const reductionPercent = ((1 - basicSchemaBytes / fullSchemaBytes) * 100).toFixed(1);
const readme = readFileSync(`${root}/README.md`, 'utf8');
const documented = /JSON schema UTF-8 序列化大小：\*\*(\d+) → (\d+) bytes（约减少 ([\d.]+)%）\*\*/.exec(readme);
assert(documented, 'README must contain the checked schema-size statement');
assert.deepEqual(documented.slice(1), [String(fullSchemaBytes), String(basicSchemaBytes), reductionPercent], 'README schema sizes/ratio drifted; update them after auditing the schema change');
console.log(`PASS compatibility ${compatibility.host}/${compatibility.upstream}; dependency=${upstreamRoot}; README schema metrics verified`);
console.log(JSON.stringify({ ...compatibility, fullSchemaBytes, basicSchemaBytes, reductionPercent: Number(reductionPercent) }));
