import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, translateMessages, encodeEmbedding, resolveBackendPaths, createBackends } from './bridge.mjs';

function backendFixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'hy bridge space-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = path.join(home, 'custom agent');
  const sdk = path.join(agent, 'npm/node_modules/@earendil-works/pi-coding-agent');
  const qmd = path.join(agent, 'npm/node_modules/@tobilu/qmd');
  for (const root of [sdk, qmd]) mkdirSync(path.join(root, 'dist/core'), { recursive: true });
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0' }));
  writeFileSync(path.join(qmd, 'package.json'), JSON.stringify({ name: '@tobilu/qmd', version: '2.8.3' }));
  for (const file of [path.join(sdk, 'dist/index.js'), path.join(sdk, 'dist/core/http-dispatcher.js'), path.join(qmd, 'dist/llm.js')]) writeFileSync(file, 'throw new Error("must not load during path validation")');
  const model = path.join(home, 'existing model.gguf'); writeFileSync(model, 'fixture');
  return { home, agent, sdk, qmd, model };
}

test('macOS launcher supplies deployed package roots without overriding explicit configuration', () => {
  const source = readFileSync(new URL('./models.sh', import.meta.url), 'utf8');
  assert.ok(source.includes('export HY_BRIDGE_PI_SDK_ROOT="${HY_BRIDGE_PI_SDK_ROOT:-/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent}"'));
  assert.ok(source.includes('export HY_BRIDGE_QMD_ROOT="${HY_BRIDGE_QMD_ROOT:-/opt/homebrew/lib/node_modules/@tobilu/qmd}"'));
});

test('backend paths use current agent or explicit existing package roots and model file', t => {
  const { home, agent, sdk, qmd, model } = backendFixture(t);
  const expected = { sdk: path.join(sdk, 'dist/index.js'), dispatcher: path.join(sdk, 'dist/core/http-dispatcher.js'), qmd: path.join(qmd, 'dist/llm.js'), embedFile: model };
  assert.deepEqual(resolveBackendPaths({ PI_CODING_AGENT_DIR: agent, HY_BRIDGE_EMBED_FILE: model }, home), expected);
  assert.deepEqual(resolveBackendPaths({ HY_BRIDGE_PI_SDK_ROOT: sdk, HY_BRIDGE_QMD_ROOT: qmd, HY_BRIDGE_EMBED_FILE: model }, home), expected);
  assert.throws(() => resolveBackendPaths({ PI_CODING_AGENT_DIR: agent, HY_BRIDGE_PI_SDK_ROOT: path.join(home, 'missing'), HY_BRIDGE_EMBED_FILE: model }, home), /ENOENT/);
});

test('qmd version, SDK identity and existing model guards fail before imports or downloads', async t => {
  const { sdk, qmd, model, home } = backendFixture(t);
  const env = { HY_BRIDGE_PI_SDK_ROOT: sdk, HY_BRIDGE_QMD_ROOT: qmd, HY_BRIDGE_EMBED_FILE: model };
  writeFileSync(path.join(qmd, 'package.json'), JSON.stringify({ name: '@tobilu/qmd', version: '2.9.0' }));
  await assert.rejects(createBackends(env), /qmd_version_changed/);
  writeFileSync(path.join(qmd, 'package.json'), JSON.stringify({ name: '@tobilu/qmd', version: '2.8.3' }));
  for (const missing of [path.join(home, 'missing.gguf'), home]) await assert.rejects(createBackends({ ...env, HY_BRIDGE_EMBED_FILE: missing }), /no_download_attempted/);
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'other' }));
  await assert.rejects(createBackends(env), /invalid_pi_sdk_package/);
});

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
