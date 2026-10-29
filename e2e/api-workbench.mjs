// Standalone isolated preview: no real config, credentials, inference calls or service restart.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,createWriteStream} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(!existsSync(join(root,'.next/dev/lock')),'Use a source tree without an active dev server');
const agentDir=mkdtempSync(join(tmpdir(),'pi-api-workbench-'));
const artifacts=join(root,'test-results/api-workbench');mkdirSync(artifacts,{recursive:true});
const config={providers:{openai:{api:'openai-responses',baseUrl:'https://api.openai.com/v1',apiKey:'FIXTURE-NOT-A-REAL-KEY',models:[{id:'gpt-6.1-sol',samplingParamsByThinkingLevel:{high:{service_tier:'default',top_p:0.8}}},{id:'gpt-6-luna'},{id:'gpt-image-1'}]},unrelated:{apiKey:'KEEP-FIXTURE'}}};
writeFileSync(join(agentDir,'models.json'),JSON.stringify(config));writeFileSync(join(agentDir,'settings.json'),'{}');
mkdirSync(join(agentDir,'sessions','fixture'),{recursive:true});
const time=Date.parse('2026-10-10T10:00:00+08:00');
const usage={input:100,output:50,cacheRead:200,cacheWrite:40,cost:{total:0.2}};
const lines=[{type:'session',version:3,id:'api-workbench-fixture',timestamp:new Date(time).toISOString(),cwd:agentDir},
 {type:'message',id:'paid',message:{role:'assistant',provider:'openai',model:'gpt-6.1-sol',timestamp:time,content:[{type:'text',text:'PRIVATE-FIXTURE-CONTENT'}],usage}},
 {type:'custom',customType:'openai-api-usage',data:{version:1,model:'gpt-6.1-sol',messageTimestamp:time,usage,actualTier:'flex',costStatus:'estimated',estimatedCostUsd:0.03}}];
writeFileSync(join(agentDir,'sessions','fixture','usage.jsonl'),lines.map(JSON.stringify).join('\n')+'\n');
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const base=`http://127.0.0.1:${port}`;
const log=createWriteStream(join(artifacts,'server.log'));
let browser,page;
const server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'dev','-H','127.0.0.1','-p',String(port)],{cwd:root,detached:true,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_WEB_PASSWORD:'',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
server.stdout.pipe(log);server.stderr.pipe(log);
const exited=once(server,'exit');
const stop=()=>{try{process.kill(-server.pid,'SIGTERM');}catch{}};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try {
 const deadline=Date.now()+90000;let before;
 while(Date.now()<deadline){
  try{const response=await fetch(base+'/api/openai-workbench',{signal:AbortSignal.timeout(5000)});if(response.ok){before=await response.json();break;}}catch{}
  if(server.exitCode!==null)throw new Error('Preview server exited');await delay(300);
 }
 assert.ok(before,'Preview did not become ready');
 assert.ok(!JSON.stringify(before).includes('FIXTURE-NOT-A-REAL-KEY'));
 browser=await chromium.launch({headless:true,...(process.env.E2E_BROWSER_CHANNEL ? {channel:process.env.E2E_BROWSER_CHANNEL} : {})});
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:'en-US'});
 page=await context.newPage();page.setDefaultTimeout(20000);
 await page.route('**/*',route=>new URL(route.request().url()).origin===base ? route.continue() : route.abort());
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const panel=page.getByRole('dialog',{name:'Settings',exact:true});
 const loadedModels=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/models-config');
 await panel.getByRole('button',{name:'Models',exact:true}).click();await loadedModels;
 await panel.getByRole('button',{name:'API workbench',exact:true}).click();
 await panel.getByRole('combobox',{name:'Model',exact:true}).selectOption('gpt-6.1-sol');
 await panel.getByRole('combobox',{name:'Service tier'}).selectOption('flex');
 await panel.getByRole('combobox',{name:'Prompt caching'}).selectOption('12h');
 await panel.getByText('Context and advanced options',{exact:true}).click();
 await panel.getByRole('spinbutton',{name:'Context window (tokens)'}).fill('272000');
 await panel.getByRole('spinbutton',{name:'Maximum output (tokens)'}).fill('64000');
 await panel.getByRole('checkbox',{name:/Repair missing capabilities/}).check();
 await panel.getByRole('button',{name:'Save',exact:true}).click();
 await panel.getByRole('alert').filter({hasText:/Per-thinking-level settings/}).waitFor();
 await panel.getByRole('checkbox',{name:/Apply these choices/}).check();
 await panel.getByRole('button',{name:'Save',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'Saved. New session or /reload required.'}).waitFor();
 const disk=JSON.parse(readFileSync(join(agentDir,'models.json'),'utf8'));
 const override=disk.providers.openai.modelOverrides['gpt-6.1-sol'];
 assert.equal(override.samplingParams.service_tier,'flex');assert.equal(override.samplingParams.prompt_cache_options.ttl,'12h');assert.equal(override.maxTokens,64000);
 assert.equal(disk.providers.unrelated.apiKey,'KEEP-FIXTURE');assert.equal(disk.providers.openai.apiKey,'FIXTURE-NOT-A-REAL-KEY');
 const fresh=await (await fetch(base+'/api/openai-workbench')).json();
 const sol=fresh.models.find(model=>model.id==='gpt-6.1-sol');
 assert.equal(sol.reasoning,true);assert.equal(sol.imageInput,true);assert.equal(sol.options.tier,'flex');assert.equal(sol.options.cache,'12h');assert.equal(sol.needsRepair,false);
 assert.equal(override.samplingParamsByThinkingLevel.high.service_tier,'flex');assert.equal(override.samplingParamsByThinkingLevel.high.top_p,0.8);
 // Optimistic concurrency is enforced by the actual HTTP writer.
 const stale=await fetch(base+'/api/openai-workbench',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:before.revision,modelId:sol.id,options:sol.options})});assert.equal(stale.status,409);
 // A mounted Models draft must not erase a later workbench save.
 await panel.getByRole('button',{name:'Models',exact:true}).click();
 await panel.getByRole('button',{name:'Save',exact:true}).click();
 await panel.getByText('Configuration changed elsewhere. Close and reopen this panel before saving again; nothing was overwritten.',{exact:true}).waitFor();
 assert.equal(JSON.parse(readFileSync(join(agentDir,'models.json'),'utf8')).providers.openai.modelOverrides['gpt-6.1-sol'].samplingParams.service_tier,'flex');
 await panel.getByRole('button',{name:'API workbench',exact:true}).click();
 await panel.locator('.api-workbench').evaluate(element=>element.parentElement.scrollTo(0,0));
 await page.screenshot({path:join(artifacts,'controls.png')});
 await panel.getByLabel('Month (Beijing time)',{exact:true}).fill('2026-10');
 await panel.getByRole('row').filter({hasText:'gpt-6.1-sol'}).waitFor();
 const monthly=await (await fetch(base+'/api/openai-workbench/usage?month=2026-10')).json();assert.equal(monthly.totals.requests,1);assert.equal(monthly.totals.estimatedCostUsd,0.03);assert.ok(!JSON.stringify(monthly).includes('PRIVATE-FIXTURE-CONTENT'));
 await page.screenshot({path:join(artifacts,'desktop.png')});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await panel.getByRole('combobox',{name:'Settings',exact:true}).isVisible());
 assert.equal(await panel.evaluate(element=>element.scrollWidth>element.clientWidth+1),false,'Panel should not overflow on a phone');
 await page.screenshot({path:join(artifacts,'mobile.png')});
 console.log('PASS: isolated API workbench save, SDK capability refresh, conflict rejection, private monthly totals and responsive navigation');
 writeFileSync(join(artifacts,'result.json'),JSON.stringify({ok:true,scope:'isolated-dev-preview',inferenceCalls:0,productionUntouched:true},null,2)+'\n');
} catch(error) {
 if(page)await page.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});throw error;
} finally {
 await browser?.close();stop();await Promise.race([exited,delay(5000)]);
 if(server.exitCode===null){try{process.kill(-server.pid,'SIGKILL');}catch{}await exited;}
 log.end();rmSync(agentDir,{recursive:true,force:true});
}
