import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, translateMessages, encodeEmbedding } from './bridge.mjs';

test('OpenAI base64 embeddings use little-endian float32 without changing float mode', () => {
  const vector=[0.25,-0.5,1];
  assert.equal(encodeEmbedding(vector),vector);
  const bytes=Buffer.from(encodeEmbedding(vector,'base64'),'base64');
  assert.equal(bytes.length,12);
  assert.equal(bytes.readFloatLE(0),0.25);
  assert.equal(bytes.readFloatLE(4),-0.5);
  assert.throws(()=>encodeEmbedding(vector,'wrong'),/unsupported/);
});

test('message conversion preserves instructions and roles without loading Pi extensions', () => {
  const c = translateMessages([{role:'system',content:'JSON only'}, {role:'user',content:'x'}, {role:'assistant',content:'y'}], {api:'a',provider:'p',id:'m'});
  assert.equal(c.systemPrompt,'JSON only'); assert.equal(c.messages[0].role,'user'); assert.equal(c.messages[1].content[0].text,'y');
  assert.throws(() => translateMessages([{role:'tool',content:'x'}],{}),/unsupported/);
  assert.throws(() => translateMessages([{role:'user',content:[]}],{}),/text_messages_only/);
});

test('loopback protocol rejects unauthenticated requests and unsupported models/features', async () => {
  let calls=0;
  const server=createServer({chat:async()=>{calls++;return {ok:true};},embed:async()=>({data:[]})},'t'.repeat(48));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+'t'.repeat(48),'Content-Type':'application/json'};
  try {
    assert.equal((await fetch(url+'/health')).status,401);
    assert.equal((await fetch(url+'/health',{headers})).status,200);
    assert.equal((await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:'no json'})).status,400);
    for(const b of [{model:'other'},{model:'gpt-6.1-sol',stream:true},{model:'gpt-6.1-sol',tools:[{}]},{model:'gpt-6.1-sol',response_format:{type:'json_schema'}}]) {
      assert.equal((await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(b)})).status,400);
    }
    const r=await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'gpt-6.1-sol',messages:[{role:'user',content:'test'}]})});
    assert.equal(r.status,200); assert.equal(calls,1);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
