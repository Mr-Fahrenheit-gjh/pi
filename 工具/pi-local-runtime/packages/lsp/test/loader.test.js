import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliHost, webHost, loadModules } from './load-modules.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const entry = fileURLToPath(new URL(`../${manifest.pi.extensions[0]}`, import.meta.url));
const unrelated = fileURLToPath(new URL('./fixtures/unrelated.js', import.meta.url));
const names = ['lsp_diagnostics_many','lsp_find_symbol','lsp_hover','lsp_definition','lsp_references','lsp_document_symbols'].sort();
for (const [name, host] of [['CLI',cliHost],['Web',webHost]]) test(`${name}: real loader, reload, peer identity and isolation`, async () => {
 const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(`${host}/dist/core/extensions/loader.js`));
 const hostApi = await import(pathToFileURL(`${host}/dist/index.js`));
 const original = module.registerHooks;
 let hooks = 0;
 module.registerHooks = () => { hooks++; throw Error('LSP must not register process hooks'); };
 module.syncBuiltinESMExports();
 try {
  const before = await loadExtensions([unrelated], root);
  assert.equal(before.extensions.length,0);
  assert.match(JSON.stringify(before.errors), /pi-child-env/);
  for (let i=0;i<10;i++) {
   clearExtensionCache();
   const result = await loadExtensions([entry],root);
   assert.deepEqual(result.errors,[]);
   assert.equal(result.extensions.length,1);
   const extension = result.extensions[0];
   assert.deepEqual([...extension.tools.keys()].sort(),names);
   assert.deepEqual([...extension.commands.keys()],['lsp']);
   assert.equal(extension.handlers.get('before_agent_start').length,1);
   for(const handler of extension.handlers.get('session_shutdown')) await handler({reason:'reload'}, {hasUI:false});
   result.runtime.invalidate();
  }
  const modules = await loadModules(host);
  assert.equal(modules.defineTool,hostApi.defineTool, 'must use selected host, not Web fallback');
  assert.throws(()=>modules.resolve_helper('@spences10/pi-settings'), /Not an LSP helper/);
  assert.throws(()=>modules.resolve_helper('unrelated-extension'), /Not an LSP helper/);
  for(const helper of ['pi-child-env','pi-project-trust','pi-tui-modal']) assert.match(modules.resolve_helper(`@spences10/${helper}`),new RegExp(helper));
  const after = await loadExtensions([unrelated],root);
  assert.equal(after.extensions.length,0);
  assert.match(JSON.stringify(after.errors),/pi-child-env/);
  await assert.rejects(import('@spences10/pi-child-env'),{code:'ERR_MODULE_NOT_FOUND'});
  assert.equal(hooks,0,'zero hooks after ten reloads');
 } finally { module.registerHooks=original; module.syncBuiltinESMExports(); }
});
