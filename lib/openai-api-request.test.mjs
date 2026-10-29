import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {streamSimple} from '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
const jiti=createJiti(import.meta.url);
const {applyWorkbenchPatch}=await jiti.import('./openai-api-workbench.ts');
const extensionPath=fileURLToPath(new URL('../../../pi-codex-speed/index.ts',import.meta.url));
async function patchedModel(t) {
 const root=mkdtempSync(join(tmpdir(),'api-payload-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'models.json');
 const config={providers:{openai:{api:'openai-responses',baseUrl:'https://api.openai.com/v1',models:[{id:'gpt-6.1-sol',samplingParams:{max_output_tokens:8192,temperature:0.5},samplingParamsByThinkingLevel:{high:{max_output_tokens:8192,top_p:0.8}}}]}}};
 writeFileSync(path,JSON.stringify(config));
 const runtime=await ModelRuntime.create({modelsPath:path,authPath:join(root,'auth.json'),modelsStorePath:join(root,'store.json'),allowModelNetwork:false,refreshOnCreate:false});
 const initial=runtime.getModel('openai','gpt-6.1-sol');assert.ok(initial);
 const next=applyWorkbenchPatch(config,initial,{options:{tier:'flex',cache:'12h',verbosity:'low',contextWindow:8192,maxTokens:8192},repair:true,clearThinkingOverrides:true});
 writeFileSync(path,JSON.stringify(next));await runtime.refresh({allowNetwork:false});
 return runtime.getModel('openai','gpt-6.1-sol');
}
async function capture(model) {
 let payload,fetches=0;
 const result=await streamSimple(model,{messages:[]},{apiKey:'sk-fixture-not-real',reasoning:'high',fetch:async()=>{fetches++;throw new Error('Network prohibited');},onPayload:value=>{payload=value;throw new Error('Stop before network');}}).result();
 assert.equal(result.stopReason,'error');assert.equal(fetches,0);assert.ok(payload);
 return payload;
}
test('native SDK payload retains dynamic output clamp after workbench save',async t=>{
 const model=await patchedModel(t);
 assert.equal(model.samplingParams.max_output_tokens,undefined);
 assert.equal(model.samplingParamsByThinkingLevel.high.max_output_tokens,undefined);
 const payload=await capture(model);
 assert.equal(payload.max_output_tokens,4096);
 assert.equal(payload.service_tier,'flex');assert.deepEqual(payload.prompt_cache_options,{mode:'auto',ttl:'12h'});
 assert.equal(payload.temperature,0.5);assert.equal(payload.top_p,0.8);
});
test('native workbench payload reaches the speed extension ledger with correct 12h pricing',{skip:!existsSync(extensionPath)},async t=>{
 const model=await patchedModel(t),payload=await capture(model);
 const extension=(await jiti.import(extensionPath)).default;
 const handlers=new Map(),entries=[];
 const ctx={model,hasUI:false,sessionManager:{getBranch:()=>[]}};
 extension({on:(event,handler)=>handlers.set(event,handler),registerCommand:()=>{},appendEntry:(customType,data)=>entries.push({customType,data})});
 handlers.get('session_start')({},ctx);
 const forwarded=handlers.get('before_provider_request')({payload},ctx);assert.equal(forwarded.service_tier,'flex');
 handlers.get('provider_stream_event')({provider:'openai',api:'openai-responses',model:model.id,data:{type:'response.completed',response:{id:'resp_fixture',service_tier:'flex'}}},ctx);
 handlers.get('message_end')({message:{role:'assistant',provider:'openai',api:'openai-responses',model:model.id,timestamp:1,responseId:'resp_fixture',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:1000,totalTokens:1000}}},ctx);
 assert.equal(entries.length,1);assert.equal(entries[0].data.cacheTtl,'12h');assert.equal(entries[0].data.costStatus,'estimated');assert.equal(entries[0].data.estimatedCostUsd,0.0025);
});
