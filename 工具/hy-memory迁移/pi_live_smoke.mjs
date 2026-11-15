// Verify the real installed package/settings; no synthetic session history or model turn.
import assert from 'node:assert/strict';
import path from 'node:path';
import {homedir} from 'node:os';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const root=path.dirname(fileURLToPath(import.meta.url));
// This read-only SDK probe is not the interactive Web session being restarted.
delete process.env.PI_SESSION_ID;
delete process.env.PI_SESSION_FILE;
const cwd='/Users/guojiahang/Documents/pi';
const agentDir=path.join(homedir(),'.pi/agent');
const settings=SettingsManager.create(cwd,agentDir);
const packages=settings.getPackages();
assert.ok(packages.includes(path.join(agentDir,'hy-memory/runtime/plugin')));
assert.ok(!packages.some(p=>typeof p==='string'&&p.endsWith('/packages/pi-memory-local')));
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
await loader.reload();
const loaded=loader.getExtensions();
assert.equal(loaded.errors.length,0,'installed extension load errors');
const isFrom=(extension,directory)=>[extension.path,extension.resolvedPath].some(value=>value===directory || value?.startsWith(directory+'/'));
assert.ok(loaded.extensions.some(e=>isFrom(e,path.join(agentDir,'hy-memory/runtime/plugin'))),'new memory plugin not loaded');
assert.ok(!loaded.extensions.some(e=>isFrom(e,path.join(cwd,'项目/规则优化/agent-eval-20261002/packages/pi-memory-local'))),'old memory plugin still loaded');
const modelRuntime=await ModelRuntime.create({allowModelNetwork:false});
const {session}=await createAgentSession({cwd,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6.1-sol'),resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(cwd),noTools:true});
try {
 await session.bindExtensions({});
 const context=session.extensionRunner.createContext();
 const run=async(name,args)=>{
  const result=await session.getToolDefinition(name).execute('installed-smoke-'+name,args,undefined,undefined,context);
  return JSON.parse(result.content.find(item=>item.type==='text').text);
 };
 const status=await run('memory_status',{});assert.equal(status.status,'ok');
 const found=await run('memory_search',{query:'Pi Web更新时是否需要保留我的本地定制和主题？',scope:'global',limit:8});
 assert.ok(found.memories.some(m=>/定制|主题|覆盖/.test(m.content)),'real preference not recalled');
 const archive=await run('memory_read',{source:'daily/2026-08-17.md',scope:'archive',offset:0});
 assert.ok(archive.content?.length,'original dated journal unreadable');
 const report={installed_settings_loaded:true,new_plugin_loaded:true,old_plugin_absent:true,all_extensions_loaded_without_errors:true,
  actual_memory_tools_healthy:true,real_preference_recalled:true,dated_original_readable:true,main_agent_model_calls:0};
 writeFileSync(path.join(root,'data/pi-installed-smoke.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report));
} finally {session.dispose();}
