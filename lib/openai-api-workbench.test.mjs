import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { classifyOpenAIModel, isChatModel, projectWorkbenchModel, applyWorkbenchPatch } = await jiti.import('./openai-api-workbench.ts');
const model = { id: 'gpt-6.1-sol', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0} };
const config = () => ({ providers: { openai: { apiKey: 'DO-NOT-EXPOSE', models: [{id:model.id}], headers:{private:'keep'}, modelOverrides: { [model.id]: { samplingParams: {temperature:0.8}, samplingParamsByThinkingLevel: {high:{service_tier:'default', top_p:0.9}} } } }, other:{apiKey:'keep'} } });
const options = {tier:'priority',cache:'12h',verbosity:'low',contextWindow:272000,maxTokens:128000};
test('specialized OpenAI models are not chat; compatible gateways remain untouched', () => {
  for (const id of ['gpt-image-1','gpt-flare','text-embedding-3-small','tts-1','whisper-1','gpt-4o-mini-transcribe','gpt-4o-realtime-preview','gpt-live-1','gpt-luna-decisions','gpt-6-luna-decisions','omni-moderation-latest','sora-2']) assert.notEqual(classifyOpenAIModel(id),'chat', id);
  assert.equal(isChatModel({...model,id:'gpt-image-1'}),false);
  assert.equal(isChatModel({...model,id:'gpt-image-1',provider:'gateway'}),true);
  assert.equal(isChatModel({...model,id:'gpt-image-1',baseUrl:'https://gateway.test/v1'}),true);
  assert.equal(classifyOpenAIModel('gpt-6.1-sol'),'chat');
});
test('projection is secret-free and offers explicit repair for id-only imports', () => {
  const projected=projectWorkbenchModel(model,config());
  assert.equal(projected.editable,true);
  assert.equal(projected.needsRepair,true);
  assert.equal(projected.thinkingOverrides,true);
  assert.equal(JSON.stringify(projected).includes('DO-NOT-EXPOSE'),false);
  assert.equal(projectWorkbenchModel({...model,baseUrl:'https://gateway.test/v1'},config()).editable,false);
  assert.equal(projectWorkbenchModel({...model,id:'gpt-6.1-sol-2099'},config()).editable,false);
});
test('minimal patch preserves secrets and unrelated fields; repair only fills missing metadata', () => {
  const original=config();
  const patched=applyWorkbenchPatch(original,model,{options,repair:true,clearThinkingOverrides:true});
  assert.equal(original.providers.openai.modelOverrides[model.id].samplingParams.service_tier,undefined);
  const p=patched.providers.openai, o=p.modelOverrides[model.id];
  assert.equal(p.apiKey,'DO-NOT-EXPOSE'); assert.deepEqual(p.headers,{private:'keep'});
  assert.equal(patched.providers.other.apiKey,'keep');
  assert.equal(o.reasoning,true); assert.deepEqual(o.input,['text','image']);
  assert.equal(o.cost.cacheRead,0.1); assert.equal(o.cost.tiers[0].inputTokensAbove,272000);
  assert.equal(o.samplingParams.temperature,0.8); assert.equal(o.samplingParams.service_tier,'priority');
  assert.deepEqual(o.samplingParams.prompt_cache_options,{mode:'auto',ttl:'12h'});
  assert.deepEqual(o.samplingParamsByThinkingLevel.high,{service_tier:'priority',top_p:0.9});
  original.providers.openai.models[0].cost={input:99,output:99,cacheRead:99,cacheWrite:99};
  assert.equal(applyWorkbenchPatch(original,model,{options,repair:true,clearThinkingOverrides:true}).providers.openai.modelOverrides[model.id].cost,undefined);
});
test('refuses misleading thinking-level overrides, unsupported tiers and invalid sizes', () => {
  assert.throws(()=>applyWorkbenchPatch(config(),model,{options,repair:false,clearThinkingOverrides:false}),/thinking-overrides/);
  assert.throws(()=>applyWorkbenchPatch({}, {...model,id:'gpt-6-luna'}, {options:{...options,tier:'ultrafast'}}),/unsupported-tier/);
  for (const change of [{contextWindow:1050001},{maxTokens:128001},{maxTokens:0},{maxTokens:1},{maxTokens:15},{contextWindow:NaN},{cache:'forever'}]) assert.throws(()=>applyWorkbenchPatch({},model,{options:{...options,...change}}));
});
test('inherit leaves existing request fields intact, including advanced cache and text options', () => {
  const source=config(); const p=source.providers.openai.modelOverrides[model.id];
  p.samplingParams.prompt_cache_options={mode:'explicit',breakpoints:[1]};
  p.samplingParams.text={verbosity:'medium',format:{type:'json_object'}};
  const result=applyWorkbenchPatch(source,model,{options:{...options,tier:'inherit',cache:'inherit',verbosity:'inherit'},clearThinkingOverrides:false});
  assert.deepEqual(result.providers.openai.modelOverrides[model.id].samplingParams,p.samplingParams);
  assert.deepEqual(result.providers.openai.modelOverrides[model.id].samplingParamsByThinkingLevel,p.samplingParamsByThinkingLevel);
});
