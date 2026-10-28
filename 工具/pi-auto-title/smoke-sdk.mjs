// Isolated real SDK lifecycle smoke. Only the three title requests use a real model.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_WEB_PACKAGE_ROOT ?? '/opt/homebrew/lib/node_modules/@agegr/pi-web';
const core = `${root}/node_modules/@earendil-works/pi-coding-agent`;
// SDK embedding does not run CLI bootstrap; use the host's normal HTTP dispatcher.
const { configureHttpDispatcher } = await import(pathToFileURL(`${core}/dist/core/http-dispatcher.js`));
configureHttpDispatcher();
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } = await import(pathToFileURL(`${core}/dist/index.js`));
const { AssistantMessageEventStream } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`));
const dir = mkdtempSync(join(tmpdir(), 'pi-auto-title-sdk-'));
let session;
try {
  const runtime = await ModelRuntime.create({ authPath: join(homedir(), '.pi/agent/auth.json'), modelsPath: join(homedir(), '.pi/agent/models.json'), allowModelNetwork: false });
  const model = runtime.getModel('openai-codex', 'gpt-6-luna');
  assert.ok(model);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: 'never' });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    additionalExtensionPaths: [resolve('工具/pi-auto-title/index.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, modelRuntime: runtime, model, thinkingLevel: 'off', tools: [], noTools: true });
  session = result.session;
  await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
  const calls = [];
  const realStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    calls.push({ model: `${model.provider}/${model.id}`, maxTokens: options.maxTokens, tools: context.tools?.length ?? 0 });
    return realStream(model, context, options);
  };
  session.agent.streamFunction = () => {
    const stream = new AssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: '这是一段隔离测试回复，不调用主对话模型。' }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  };
  const prompts = [
    '我想学习量化面试绿皮书里的随机过程，请讲解鞅和赌徒破产问题。',
    '先解释公平游戏为什么可以用鞅描述。', '给出赌徒破产的边界条件。', '请解释停时与可选停止定理。',
    '把鞅与赌徒破产的求解方法整理成一份复习提纲。',
    '接下来学习布朗运动。', '解释布朗运动的二次变差。', '用例子说明伊藤引理。', '说明几何布朗运动如何推导。',
    '最后把鞅、赌徒破产和伊藤引理串起来，形成随机过程面试复习笔记。', '再给一道练习题。', '把答案讲清楚。',
  ];
  const names = [];
  for (let i = 0; i < prompts.length; i++) {
    await session.prompt(prompts[i]);
    if ([1, 5, 10].includes(i + 1)) {
      const deadline = Date.now() + 100_000;
      while (!manager.getEntries().some(e => e.type === 'custom' && e.customType === 'local.pi.auto-title.v1' && e.data.kind === 'applied' && e.data.count === i + 1)) {
        const error = manager.getEntries().find(e => e.type === 'custom' && e.customType === 'local.pi.auto-title.v1' && e.data.kind === 'error');
        if (error) throw new Error(JSON.stringify(error.data));
        if (Date.now() > deadline) throw new Error('Timed out waiting for persisted title');
        await new Promise(r => setTimeout(r, 100));
      }
      names.push({ count: i + 1, title: manager.getSessionName() });
    }
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.model === 'openai-codex/gpt-6-luna' && call.maxTokens === 256 && call.tools === 0));
  assert.equal(manager.getSessionName(), names.at(-1).title);
  session.setSessionName('手动指定的复习标题');
  await session.prompt('第十三条消息');
  assert.equal(manager.getSessionName(), '手动指定的复习标题');
  const disk = readFileSync(manager.getSessionFile(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(disk.filter(e => e.type === 'custom' && e.customType === 'local.pi.auto-title.v1' && e.data.kind === 'attempt').length, 3);
  assert.ok(disk.some(e => e.type === 'custom' && e.customType === 'local.pi.auto-title.v1' && e.data.kind === 'manual'));
  console.log(JSON.stringify({ ok: true, titleRequests: calls, mainModelRequests: 0, names, manualProtection: true, persisted: true }, null, 2));
} finally {
  session?.dispose();
  rmSync(dir, { recursive: true, force: true });
}
