// Minimal real-host regression: general -> browser schema refresh -> full.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import profiles from '../index.ts';

process.env.PI_OFFLINE = '1';
const hosts = ['/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent', '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent'];
let failures = 0;
for (const host of hosts) {
  const sdk = await import(`${host}/dist/index.js`);
  const dir = await mkdtemp(join(tmpdir(), 'pi-profile-refresh-'));
  let session;
  try {
    let api;
    const settingsManager = sdk.SettingsManager.inMemory();
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve(import.meta.dirname, '../../browser/index.ts')],
      extensionFactories: [pi => { api = pi; profiles(pi); }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'store.json'), allowModelNetwork: false });
    modelRuntime.stream = modelRuntime.streamSimple = () => { throw Error('LLM forbidden'); };
    const names = ['chatgpt_computer_use', 'credential_login'];
    ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader: loader, modelRuntime,
      sessionManager: sdk.SessionManager.inMemory(dir),
      customTools: names.map(name => ({ name, label: name, description: `Inert ${name}`, parameters: { type: 'object', properties: {} }, execute: () => { throw Error('Tool execution forbidden'); } })),
    }));
    session.agent.prompt = () => { throw Error('Agent prompt forbidden'); };
    await session.bindExtensions({});
    const initial = api.getActiveTools();
    for (const name of names) assert(initial.includes(name));
    await session.prompt('/tool-profile general');
    const hiddenActive = api.getActiveTools();
    for (const name of names) assert(!hiddenActive.includes(name));
    const before = new Map(api.getAllTools().map(t => [t.name, t]));
    if (!process.argv.includes('--control')) await session.prompt('/browser-mode full');
    for (const name of names) {
      const previous = before.get(name);
      const current = api.getAllTools().find(t => t.name === name);
      assert(current && previous);
      assert.deepEqual(current.sourceInfo, previous.sourceInfo);
      assert.deepEqual(current.parameters, previous.parameters);
      assert.equal(current.description, previous.description);
      assert(['path', 'source', 'scope', 'origin'].every(k => Boolean(current.sourceInfo[k])));
    }
    assert.deepEqual(api.getActiveTools(), hiddenActive, 'browser must preserve the active set');
    await session.prompt('/tool-profile full');
    assert.deepEqual(new Set(api.getActiveTools()), new Set(initial), 'full must restore unchanged CU/HTTP after browser refresh');
    assert.equal(session.messages.length, 0);
    console.log(`PASS ${host}: CU/HTTP restored after ${process.argv.includes('--control') ? 'no refresh (control)' : 'one browser refresh'}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${host}: ${error.stack}`);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}
if (failures) process.exitCode = 1;
