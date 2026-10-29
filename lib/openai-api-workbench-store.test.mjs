import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {readWorkbenchConfig,saveWorkbenchConfig}=await jiti.import('./openai-api-workbench-store.ts');
const {readModelsConfigSnapshot,writeModelsConfig}=await jiti.import('./models-config-store.ts');
const model={id:'gpt-6.1-sol',provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',contextWindow:272000,maxTokens:128000,reasoning:true,input:['text','image'],cost:{}};
const options={tier:'flex',cache:'30m',verbosity:'medium',contextWindow:272000,maxTokens:64000};
test('atomic revisioned save preserves unrelated configuration, refuses stale writes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'api-workbench-')); const path=join(dir,'models.json');
 try {
  writeFileSync(path,'\uFEFF{ // comment\n"providers":{"openai":{"apiKey":"SECRET","models":[{"id":"gpt-6.1-sol"}],},"third":{"apiKey":"keep"}}}');
  const before=readWorkbenchConfig(path);
  const modelsDraft=readModelsConfigSnapshot(path);
  const result=saveWorkbenchConfig({expectedRevision:before.revision,options,repair:true},model,path);
  assert.equal(result.revision,readWorkbenchConfig(path).revision);
  assert.notEqual(result.revision,before.revision);
  assert.equal(statSync(path).mode&0o777,0o600);
  assert.equal(readWorkbenchConfig(path).config.providers.openai.apiKey,'SECRET');
  assert.throws(()=>saveWorkbenchConfig({expectedRevision:before.revision,options},model,path),/stale-config/);
  assert.equal(readWorkbenchConfig(path).config.providers.third.apiKey,'keep');
  assert.throws(()=>writeModelsConfig(modelsDraft.config,path,modelsDraft.revision),/stale-config/);
  const fresh=readModelsConfigSnapshot(path);
  writeModelsConfig(fresh.config,path,fresh.revision);
  assert.throws(()=>saveWorkbenchConfig({expectedRevision:result.revision,options},model,path),/stale-config/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('malformed or nonregular configuration is never overwritten or quoted in errors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'api-workbench-')); const path=join(dir,'models.json');
 try {
  for (const raw of ['{"apiKey":"SECRET"', '[]','{"providers":[]}','{"providers":{"openai":false}}']) {
   writeFileSync(path,raw);
   assert.throws(()=>readWorkbenchConfig(path),e=>e.message==='invalid-config');
   assert.equal(readFileSync(path,'utf8'),raw);
  }
  const link=join(dir,'link.json');symlinkSync(path,link);
  assert.throws(()=>readWorkbenchConfig(link),/invalid-config/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
