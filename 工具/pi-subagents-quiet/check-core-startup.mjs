// No model requests: load installed extensions and exercise startup event contracts.
import { pathToFileURL } from 'node:url';
const root = process.argv[2] || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const { DefaultResourceLoader, createAgentSession, SessionManager, getAgentDir, initTheme } = await import(pathToFileURL(`${root}/dist/index.js`));
const { buildSystemPrompt } = await import(pathToFileURL(`${root}/dist/core/system-prompt.js`));
// Match CLI startup: theme must be initialized even for non-interactive extensions.
initTheme('light/dark', false);
const loader = new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir()});
await loader.reload();
const loaded = loader.getExtensions();
const errors = [...loaded.errors];
let session;
try {
  ({session} = await createAgentSession({resourceLoader:loader,sessionManager:SessionManager.inMemory()}));
  await session.bindExtensions({mode:'json',onError:error=>errors.push(error)});
  const options = {cwd:process.cwd(),selectedTools:session.getActiveToolNames()};
  const modern = session.extensionRunner.emitBeforeAgentStart.length === 2;
  const triggers = modern ? [{messageType:'user',prompt:'Startup compatibility check'},{messageType:'custom',message:{customType:'compatibility-check',content:'Internal continuation',display:false}}] : ['Startup compatibility check'];
  const checks = [];
  for (const trigger of triggers) {
    const result = modern ? await session.extensionRunner.emitBeforeAgentStart(trigger,options) : await session.extensionRunner.emitBeforeAgentStart(trigger,undefined,options);
    const prompt = buildSystemPrompt(result.systemPromptOptions);
    checks.push({type:modern?trigger.messageType:'legacy-user',memory:prompt.includes('## Memory'),quietPolicy:prompt.includes('<local_subagent_completion_policy>'),lsp:prompt.includes('LSP integration:')});
  }
  console.log(JSON.stringify({root,extensionCount:loaded.extensions.length,errors,checks},null,2));
  if (errors.length || checks.some(check=>!check.memory || !check.quietPolicy || !check.lsp)) process.exitCode=1;
} finally {
  if (session) {
    await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
    session.dispose();
  }
}
