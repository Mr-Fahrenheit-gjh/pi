// Isolated fake-provider process for SIGKILL tests. Never calls a model API.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
const [root, temporary, extension] = process.argv.slice(2);
const sdk = await import(join(root, 'dist/index.js'));
const require = createRequire(join(root, 'package.json'));
const aiRoot = existsSync(join(root, 'node_modules/@earendil-works/pi-ai')) ? join(root, 'node_modules/@earendil-works/pi-ai') : join(dirname(root), 'pi-ai');
const ai = await import(join(aiRoot, 'dist/index.js'));
const compat = await import(join(aiRoot, 'dist/compat.js'));
const { createJiti } = require('jiti');
const recovery = await createJiti(import.meta.url).import(extension, { default: true });
const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
const runtime = await sdk.ModelRuntime.create({ authPath: join(temporary, 'auth.json'), modelsPath: join(temporary, 'models.json') });
await runtime.setRuntimeApiKey('openai', 'test-only-no-network');
const loader = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir: temporary, settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [recovery] });
await loader.reload();
const manager = sdk.SessionManager.create(temporary, temporary);
const { session } = await sdk.createAgentSession({ cwd: temporary, agentDir: temporary, model: compat.getModel('openai', 'gpt-4o'),
  modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: true });
session.agent.streamFunction = () => {
  process.send({ phase: 'request-started', sessionFile: manager.getSessionFile() });
  const stream = ai.createAssistantMessageEventStream();
  setInterval(() => {}, 1000); // Keep the fake request live until the test kills this process.
  return stream;
};
await session.bindExtensions({ mode: 'print' });
await session.prompt('Continue this isolated test after a simulated process crash.');
