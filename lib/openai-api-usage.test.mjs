import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {scanMonthlyUsage,currentUsageMonth}=await jiti.import('./openai-api-usage.ts');
const time=Date.parse('2026-10-01T00:00:00+08:00');
const usage={input:100,output:20,cacheRead:300,cacheWrite:50,cost:{total:0.1}};
const message=(id,extra={})=>({type:'message',id,message:{role:'assistant',provider:'openai',model:'gpt-6.1-sol',timestamp:time,usage,...extra}});
const ledger=(extra={})=>({type:'custom',customType:'openai-api-usage',data:{version:1,model:'gpt-6.1-sol',messageTimestamp:time,actualTier:'flex',estimatedCostUsd:0.03,costStatus:'estimated',usage,...extra}});
const write=(root,name,lines)=>writeFileSync(join(root,name+'.jsonl'),lines.map(JSON.stringify).join('\n')+'\n');
test('month uses Beijing boundaries and ledger wins; fork copies are not charged twice',async()=>{
 const root=mkdtempSync(join(tmpdir(),'api-usage-'));
 try {
  write(root,'one',[message('a'),ledger(),message('before',{timestamp:time-1}),message('codex',{provider:'openai-codex'})]);
  write(root,'fork',[message('a'),ledger()]);
  const result=await scanMonthlyUsage('2026-10',root);
  assert.equal(result.partial,false);assert.equal(result.totals.requests,1);
  assert.equal(result.totals.estimatedCostUsd,0.03);assert.equal(result.totals.estimatedRequests,1);
  assert.equal(result.totals.input,100);assert.equal(result.totals.cacheRead,300);assert.equal(result.byModel.length,1);
  assert.equal(currentUsageMonth(time-1),'2026-09');assert.equal(currentUsageMonth(time),'2026-10');
  assert.equal(JSON.stringify(result).includes(root),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('missing actual tier stays unknown, old cost is labelled legacy, zero catalog cost is unknown',async()=>{
 const root=mkdtempSync(join(tmpdir(),'api-usage-'));
 try {
  write(root,'one',[message('a'),ledger({actualTier:null,estimatedCostUsd:null,costStatus:'unknown'}),message('b',{timestamp:time+1}),message('c',{timestamp:time+2,usage:{...usage,cost:{total:0}}})]);
  const {totals}=await scanMonthlyUsage('2026-10',root);
  assert.equal(totals.requests,3);assert.equal(totals.unknownRequests,2);assert.equal(totals.legacyRequests,1);assert.equal(totals.estimatedCostUsd,0.1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('v1 entries and reserialized response IDs dedupe without silent omissions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'api-usage-'));
 try {
  const legacy=message(undefined,{timestamp:time+1});
  write(root,'one',[message('a',{responseId:'resp_paid'}),ledger({responseId:'resp_paid'}),legacy]);
  write(root,'reserialized',[message('changed-id',{responseId:'resp_paid'}),legacy]);
  write(root,'copy-without-ledger',[message('copied-id')]);
  const result=await scanMonthlyUsage('2026-10',root);
  assert.equal(result.partial,false);assert.equal(result.totals.requests,2);
  assert.equal(result.totals.estimatedRequests,1);assert.equal(result.totals.legacyRequests,1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('a zero-price ledger cannot certify paid-model usage as free',async()=>{
 const root=mkdtempSync(join(tmpdir(),'api-usage-'));
 try {write(root,'one',[message('a'),ledger({estimatedCostUsd:0})]);const {totals}=await scanMonthlyUsage('2026-10',root);assert.equal(totals.unknownRequests,1);assert.equal(totals.estimatedRequests,0);}
 finally {rmSync(root,{recursive:true,force:true});}
});
test('truncated logs and scan limits explicitly mark partial; invalid months fail',async()=>{
 const root=mkdtempSync(join(tmpdir(),'api-usage-'));
 try {
  write(root,'one',[message('a')]);writeFileSync(join(root,'broken.jsonl'),'{');
  assert.equal((await scanMonthlyUsage('2026-10',root)).partial,true);
  assert.equal((await scanMonthlyUsage('2026-10',root,{files:0,bytes:1e6,ms:1000,records:100})).partial,true);
  await assert.rejects(()=>scanMonthlyUsage('2026-13',root),/invalid-month/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
