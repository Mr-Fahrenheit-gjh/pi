import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { configureHostSdk, HOST_ROOT_ENV } from './host-sdk.mjs';
import { patch, oldBlock, newBlock, legacyBlock, previousBlock, core14Block } from './apply-runner-1.2-compat.mjs';
const plugin=process.env.PI_SUBAGENTS_PACKAGE_ROOT || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm/node_modules/pi-subagents');
const src=fs.readFileSync(path.join(plugin,'src/runs/background/runner-aliases.js'),'utf8');
const host=process.env[HOST_ROOT_ENV];
if (!host) throw new Error(`Integration test requires explicit ${HOST_ROOT_ENV}`);
const { resolveHostPeerAliases } = await import(pathToFileURL(path.join(plugin,'src/runs/background/runner-aliases.js')));
test('replay is idempotent and unknown source rejected',()=>{
 assert.equal(patch(src),src);assert.equal(patch(src.replace(newBlock,oldBlock)),src);
 assert.equal(patch(src.replace(newBlock,legacyBlock)),src);
 assert.equal(patch(src.replace(newBlock,previousBlock)),src);
 assert.equal(patch(src.replace(newBlock,core14Block)),src);
 assert.throws(()=>patch('unknown'),/Unrecognized/);
});
const asyncSource = fs.readFileSync(path.join(plugin, 'src/runs/background/async-execution.js'), 'utf8');
const resolver = asyncSource.match(/^function resolveAsyncPiPackageRoot\(env = process.env\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(resolver, 'Upstream resolver changed: review the real host-discovery contract');
function resolveActual({ argv, env = {}, installed }) {
 let installedCalls = 0;
 const context = { process: { env }, PI_CODING_AGENT_PACKAGE_ROOT_ENV: HOST_ROOT_ENV,
  resolvePiPackageRoot: () => argv,
  resolveInstalledPiPackageRoot: () => { installedCalls++; return installed; } };
 const value = vm.runInNewContext(`${resolver}\nresolveAsyncPiPackageRoot()`, context);
 return { value, installedCalls };
}
test('actual async resolver accepts a validated explicit host with a missing npm peer', () => {
 const env = { [HOST_ROOT_ENV]: host }; const verifiedHost = configureHostSdk(env);
 assert.equal(verifiedHost, fs.realpathSync(host));
 assert.deepEqual(resolveActual({ env, installed: undefined }), { value: verifiedHost, installedCalls: 0 });
 assert.deepEqual(resolveActual({ env: { [HOST_ROOT_ENV]: `  ${verifiedHost}  ` } }), { value: verifiedHost, installedCalls: 0 });
});
test('actual async resolver preserves argv precedence and optional installed fallback', () => {
 assert.deepEqual(resolveActual({ argv: '/argv-host', env: { [HOST_ROOT_ENV]: '/explicit' }, installed: '/peer' }), { value: '/argv-host', installedCalls: 0 });
 assert.deepEqual(resolveActual({ env: { [HOST_ROOT_ENV]: '   ' }, installed: '/peer' }), { value: '/peer', installedCalls: 1 });
 assert.deepEqual(resolveActual({}), { value: undefined, installedCalls: 1 });
});
test('compatibility replay validates host first and does not mutate npm links', () => {
 const replay = fs.readFileSync(new URL('./apply-runner-1.2-compat.mjs', import.meta.url), 'utf8');
 assert.ok(replay.indexOf('const host = configureHostSdk()') < replay.indexOf('fs.writeFileSync(target'));
 assert.doesNotMatch(replay, /fs\.(symlinkSync|unlinkSync|rmSync|mkdirSync)\(/);
});
test('real host dependencies resolve without obsolete chord',()=>{
 const r=resolveHostPeerAliases(host);assert.deepEqual(r.missing,[]);
 assert.ok(r.aliases['@earendil-works/pi-coding-agent']);
 assert.equal(r.aliases['@earendil-works/chord'],undefined);
});
for(const [version,declared,shouldFail] of [['1.5.0',false,false],['1.5.0',true,true],['1.5.1',false,true],['1.5.0-rc.1',false,true],['1.4.0',false,false],['1.4.0',true,true],['1.4.1',false,true],['1.4.0-rc.1',false,true],['1.2.0',false,false],['1.3.0',false,false],['1.3.0',true,true],['1.3.1',false,true],['1.3.0-beta.1',false,true],['1.2.0',true,true],['1.2.1',false,true],['1.2.0-beta.1',false,true],['0.84.4',false,false]]) {
 test(`host ${version}, declares chord=${declared}: strict policy`,()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-runner-alias-'));
  try {
   const manifest=JSON.parse(fs.readFileSync(path.join(host,'package.json'),'utf8'));
   manifest.version=version;
   if(declared) manifest.dependencies['@earendil-works/chord']='*';
   fs.writeFileSync(path.join(tmp,'package.json'),JSON.stringify(manifest));
   fs.symlinkSync(path.join(host,'dist'),path.join(tmp,'dist'));
   fs.mkdirSync(path.join(tmp,'node_modules'));
   // Resolve the real dependency package roots instead of installing any copies.
   const aliases=resolveHostPeerAliases(host).aliases;
   for(const [specifier,file] of Object.entries(aliases)) {
    const pkg=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
    if(pkg==='@earendil-works/pi-coding-agent')continue;
    let dir=path.dirname(file);
    while(!fs.existsSync(path.join(dir,'package.json')))dir=path.dirname(dir);
    const dest=path.join(tmp,'node_modules',pkg);
    if(!fs.existsSync(dest)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.symlinkSync(dir,dest);}
   }
   const missing=resolveHostPeerAliases(tmp).missing;
   assert.equal(missing.includes('@earendil-works/chord'),shouldFail);
   assert.equal(missing.includes('@earendil-works/chord/context'),shouldFail);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 });
}
