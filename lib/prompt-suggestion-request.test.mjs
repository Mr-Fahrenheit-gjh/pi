import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {dispatchHistoryPromptSuggestion,requestOpenedPromptSuggestion}=await jiti.import('./prompt-suggestion-request.ts');
const sourceInfo={path:'/workspace/pi-prompt-suggestions/src/index.ts'};
test('missing or unrelated extension is a safe no-op, never a model prompt',async()=>{
  assert.deepEqual(await dispatchHistoryPromptSuggestion({},false,'leaf'),{available:false});
  let called=0;
  const runner={getCommand:()=>({sourceInfo:{path:'/other/plugin.ts'},handler:()=>{called++;}}),createCommandContext:()=>({})};
  assert.deepEqual(await dispatchHistoryPromptSuggestion(runner,false,'leaf'),{available:false});
  assert.equal(called,0);
});
test('dispatch invokes the registered handler with standard command context only when idle',async()=>{
  const calls=[],ctx={};const runner={getCommand:name=>{calls.push(['lookup',name]);return {sourceInfo,handler:(args,context)=>calls.push(['handler',JSON.parse(args),context])};},createCommandContext:()=>ctx};
  assert.deepEqual(await dispatchHistoryPromptSuggestion(runner,true,'leaf'),{available:false});assert.equal(calls.length,0);
  assert.deepEqual(await dispatchHistoryPromptSuggestion(runner,false,'leaf'),{available:true});
  assert.deepEqual(calls,[['lookup','prompt-suggestions-history'],['handler',{leafId:'leaf'},ctx]]);
});
test('opening waits for SSE and rechecks selection and draft before sending the dedicated request',async()=>{
  const calls=[];let current=true,draft=false;
  const opts={sessionId:'a',leafId:'leaf',isCurrent:()=>current,hasDraft:()=>draft,ensureConnected:async sid=>calls.push(['connect',sid]),send:async(sid,command)=>calls.push(['send',sid,command])};
  await requestOpenedPromptSuggestion(opts);
  assert.deepEqual(calls,[['connect','a'],['send','a',{type:'request_prompt_suggestion',leafId:'leaf'}]]);
  calls.length=0;await requestOpenedPromptSuggestion({...opts,ensureConnected:async()=>{current=false;}});assert.equal(calls.length,0);
  current=true;await requestOpenedPromptSuggestion({...opts,ensureConnected:async()=>{draft=true;}});assert.equal(calls.length,0);
});
test('branch changes while connecting suppress the stale leaf request',async()=>{
  let leaf='a',sent=0;
  await requestOpenedPromptSuggestion({sessionId:'session',leafId:'a',isCurrent:()=>leaf==='a',hasDraft:()=>false,
    ensureConnected:async()=>{leaf='b';},send:async()=>{sent++;}});
  assert.equal(sent,0);
});
test('failed connection and existing drafts never send a request',async()=>{
  let calls=0;const opts={sessionId:'a',leafId:null,isCurrent:()=>true,hasDraft:()=>true,ensureConnected:async()=>{calls++;},send:async()=>{calls++;}};
  await requestOpenedPromptSuggestion(opts);assert.equal(calls,0);
  await requestOpenedPromptSuggestion({...opts,hasDraft:()=>false,ensureConnected:async()=>{throw Error('offline');}});assert.equal(calls,0);
});
