// No model requests and no delegation: verify the new child extension/tool loadout in a fresh process.
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {configureHostSdk} from './host-sdk.mjs';
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--output')) throw new Error('Usage: node check-child-tools.mjs [--output /path/result.json]');
const output=args[1] ? path.resolve(args[1]) : null;
const root=configureHostSdk();
const pi=await import(pathToFileURL(`${root}/dist/index.js`));
pi.initTheme('light/dark',false);
const here=path.dirname(fileURLToPath(import.meta.url));
const loader=new pi.DefaultResourceLoader({cwd:process.cwd(),agentDir:pi.getAgentDir(),additionalExtensionPaths:[path.join(here,'child-shared-tools.ts')],extensionFactories:[{name:'codemode',factory:pi.createCodemodeExtension(),replaceable:true}]});
await loader.reload();
const errors=[...loader.getExtensions().errors];
let session;
try {
 ({session}=await pi.createAgentSession({resourceLoader:loader,sessionManager:pi.SessionManager.inMemory()}));
 await session.bindExtensions({mode:'json',onError:e=>errors.push({extensionPath:e.extensionPath,event:e.event,error:String(e.error)})});
 const wanted=['bash','read','edit','write','task_start','task_wait','todo','lsp_diagnostics','web_enable','memory_read','codemode','tool_search','subagent','bg_wait','empty_brain','get_context_remaining','notes_write','history_list','subagent_supervisor'];
 const active=session.getActiveToolNames();
 const ctx=session.extensionRunner.createToolContext('child-loadout-check',undefined);
 const code=session.extensionRunner.getToolDefinition('codemode');
 const discovered=await code.execute('child-loadout-check',{code:'const names=ALL_TOOLS.map(t=>t.name ?? t); text(JSON.stringify({registered:names.length, github:names.some(n=>/github/i.test(n)), playwright:names.some(n=>/playwright/i.test(n))}));'},undefined,undefined,ctx);
 if(discovered.isError) throw new Error('Tool discovery failed');
 const blocks=discovered.content.filter(c=>c.type==='text').map(c=>c.text);
 if(!blocks[0]?.startsWith('Script completed\n')) throw new Error('Unexpected codemode result envelope');
 const discovery=JSON.parse(blocks.slice(1).join('\n'));
 const contracts={
  subagent:/completion is recorded silently/.test(session.extensionRunner.getToolDefinition('subagent').description),
  bg_wait:/Routine subagent completion is silent/.test(session.extensionRunner.getToolDefinition('bg_wait').description),
 };
 const result={scope:'fresh SDK in-memory session with child-shared-tools; no spawned child/model request',sdkRoot:root,sdkVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,errors,tools:Object.fromEntries(wanted.map(n=>[n,active.includes(n)])),contracts,discovery};
 if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
 console.log(JSON.stringify(result,null,2));
 if(errors.length || wanted.some(n=>!active.includes(n)) || Object.values(contracts).some(v=>!v) || !discovery.github || !discovery.playwright)process.exitCode=1;
} finally {
 if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});session.dispose();}
}
