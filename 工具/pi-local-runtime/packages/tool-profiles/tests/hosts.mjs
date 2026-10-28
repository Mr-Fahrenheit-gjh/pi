import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import profiles, { LSP_NAMES } from '../index.ts';

const hosts = process.argv.slice(2);
if (!hosts.length) hosts.push('/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent', '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent');
process.env.PI_OFFLINE = '1';
for (const host of hosts) {
  const sdk = await import(`${host}/dist/index.js`);
  const dir = await mkdtemp(join(tmpdir(), 'pi-profiles-'));
  const sessions = [];
  try {
    async function create(options = {}) {
      let api;
      const settingsManager = sdk.SettingsManager.inMemory();
      const loader = new sdk.DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => { api = pi; profiles(pi); }],
      });
      await loader.reload();
      const customTools = ['computer_use_status', 'chatgpt_computer_use', 'subagent', 'credential_login', 'agent_browser', 'memory', 'todo', 'lsp_future', ...LSP_NAMES].map(name => ({
        name, label: name, description: `Mock ${name}`, parameters: { type: 'object', properties: {} },
        execute: async () => { throw Error('No tool should execute'); },
      }));
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'store.json'), allowModelNetwork: false });
      const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: sdk.SessionManager.inMemory(dir), customTools, ...options });
      sessions.push(session);
      await session.bindExtensions({});
      return { session, api };
    }
    const main = await create();
    const initial = main.api.getActiveTools();
    assert(initial.includes('chatgpt_computer_use')); // default deliberately conservative
    assert(initial.includes('edit'));
    const child = await create({ tools: ['read', 'computer_use_status', 'chatgpt_computer_use'] });
    const childInitial = child.api.getActiveTools();
    for (const p of ['general', 'status', 'coding', 'general', 'full', 'coding', 'full', 'invalid']) {
      await main.session.prompt(`/tool-profile ${p}`);
      assert.deepEqual(child.api.getActiveTools(), childInitial);
      const active = main.api.getActiveTools();
      for (const name of ['read', 'edit', 'write', 'bash', 'computer_use_status', 'agent_browser', 'memory', 'todo', 'lsp_future', 'subagent']) assert(active.includes(name));
      if (p === 'general' || p === 'coding') {
        for (const name of LSP_NAMES) assert.equal(active.includes(name), p === 'coding');
        assert(!active.includes('chatgpt_computer_use'));
        assert(!active.includes('credential_login'));
      }
      if (p === 'full') assert.deepEqual(new Set(active), new Set(initial));
    }
    assert.deepEqual(new Set(main.api.getActiveTools()), new Set(initial));
    for (const p of ['general', 'coding', 'full']) await child.session.prompt(`/tool-profile ${p}`);
    assert.deepEqual(new Set(child.api.getActiveTools()), new Set(childInitial));
    // External owners may change active state; do not restore unrelated removals.
    await main.session.prompt('/tool-profile general');
    main.api.setActiveTools([...main.api.getActiveTools().filter(n => n !== 'agent_browser'), 'chatgpt_computer_use']);
    await main.session.prompt('/tool-profile coding');
    assert(!main.api.getActiveTools().includes('agent_browser'));
    assert(!main.api.getActiveTools().includes('chatgpt_computer_use'));
    await main.session.prompt('/tool-profile full');
    assert(main.api.getActiveTools().includes('chatgpt_computer_use'));
    assert(!main.api.getActiveTools().includes('agent_browser'));
    assert.deepEqual(new Set(child.api.getActiveTools()), new Set(childInitial));
    const limited = await create({ tools: ['read', 'edit', 'computer_use_status', 'lsp_hover', 'credential_login'], excludeTools: ['edit', 'lsp_hover', 'credential_login'] });
    for (const p of ['general', 'coding', 'full', 'status']) {
      await limited.session.prompt(`/tool-profile ${p}`);
      assert.deepEqual(new Set(limited.api.getActiveTools()), new Set(['read', 'computer_use_status']));
    }
    // Adversarial request proves host registry itself enforces the ceiling.
    limited.api.setActiveTools(['read', 'edit', 'write', 'credential_login']);
    assert.deepEqual(limited.api.getActiveTools(), ['read']);
    const explicitMain = await create({ excludeTools: ['chatgpt_computer_use', 'credential_login'] });
    for (const p of ['general', 'coding', 'full']) {
      await explicitMain.session.prompt(`/tool-profile ${p}`);
      assert(!explicitMain.api.getActiveTools().includes('chatgpt_computer_use'));
      assert(!explicitMain.api.getActiveTools().includes('credential_login'));
      assert(explicitMain.api.getActiveTools().includes('subagent'));
    }
    // Registered but inactive LSP is not a restoration entitlement.
    const dormant = await create();
    dormant.api.setActiveTools(dormant.api.getActiveTools().filter(n => n !== 'lsp_hover'));
    for (const p of ['general', 'coding', 'full']) {
      await dormant.session.prompt(`/tool-profile ${p}`);
      assert(!dormant.api.getActiveTools().includes('lsp_hover'));
    }
    const empty = await create({ noTools: 'all' });
    for (const p of ['general', 'coding', 'full']) {
      await empty.session.prompt(`/tool-profile ${p}`);
      assert.deepEqual(empty.api.getActiveTools(), []);
    }
    for (const s of sessions) assert.equal(s.messages.length, 0);
    console.log(`PASS ${host}: default, discovery, commands, child isolation, allowlist/exclude, explicit main; no LLM`);
  } finally {
    for (const s of sessions) s.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}
