// Load the actual extension in a real Pi SDK runtime, without starting a model/agent turn.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

const root=path.dirname(fileURLToPath(import.meta.url));
process.env.PI_HY_MEMORY_CONFIG=process.env.PI_HY_MEMORY_CONFIG || path.join(root,'data/pi-test-config.json');
const cwd='/tmp/pi-hy-sdk-extension-test';
const settings=SettingsManager.inMemory({packages:[],compaction:{enabled:false}});
const loader=new DefaultResourceLoader({cwd,agentDir:path.join(root,'data/pi-sdk-test'),settingsManager:settings,
  noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  additionalExtensionPaths:[path.join(root,'index.ts')]});
await loader.reload();
const loaded=loader.getExtensions();
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const modelRuntime=await ModelRuntime.create({allowModelNetwork:false});
const {session}=await createAgentSession({cwd,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6.1-sol'),
  resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(cwd),noTools:true});
try {
  await session.bindExtensions({});
  const names=['memory_write','memory_search','memory_read','memory_update','memory_delete','memory_status'];
  for (const name of names) if (!session.getToolDefinition(name)) throw new Error('missing_tool:'+name);
  const ctx=session.extensionRunner.createContext();
  const run=async(name,args,id) => {
    const result=await session.getToolDefinition(name).execute(id,args,undefined,undefined,ctx);
    return JSON.parse(result.content.find(item=>item.type==='text').text);
  };
  const health=await run('memory_status',{},'health');
  if (health.status!=='ok') throw new Error('service_not_healthy');
  const saved=await run('memory_write',{content:'Pi扩展验收松鼠最喜欢的颜色是橙色。',scope:'project'},'save');
  if (saved.state!=='completed' || !saved.result.verified_ids.length) throw new Error('write_failed');
  const found=await run('memory_search',{query:'松鼠最喜欢的颜色？',scope:'project'},'find');
  if (!found.memories.some(item=>item.content.includes('橙'))) throw new Error('recall_failed');
  for(const memory_id of saved.result.verified_ids) await run('memory_delete',{memory_id,scope:'project'},'delete-'+memory_id);
  const report={real_pi_sdk:true,loaded_tools:names,actual_write_recall_delete:true,main_agent_model_calls:0,
    original_pi_settings_changed:false};
  writeFileSync(path.join(root,'data/pi-extension-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  session.dispose();
}
