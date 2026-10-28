import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './load-modules.js';
const { register_lsp_tools, create_lsp_extension, append_lsp_system_prompt, should_inject_lsp_prompt } = await loadModules();
const diagnostic = severity => ({ severity, message: 'synthetic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
async function run(files) {
 const tools = new Map(); let released = 0;
 const manager = {
  async resolve_file_state(file) {
   if (file === 'failure') return { ok: false, error: { file, kind: 'unsupported_language', message: 'synthetic failure' } };
   return { ok: true, result: { abs: file, uri: file, state: { client: { async wait_for_diagnostics() {
    if (file === 'throw') throw new Error('synthetic request failure');
    return file === 'clean' ? [] : [diagnostic(Number(file))];
   } } } } };
  }, async release_file_state() { released++; }
 };
 register_lsp_tools({ registerTool(t) { tools.set(t.name,t); } }, manager);
 const result = await tools.get('lsp_diagnostics_many').execute('test', { files }, undefined, undefined, { hasUI: false });
 assert.equal(released, files.filter(x => x !== 'failure').length);
 return result;
}
for (const [name,files,expected] of [
 ['tool failure',['failure'],[1,0,0,false,false]],
 ['request failure',['throw'],[1,0,0,false,false]],
 ['error diagnostic',['1'],[0,1,0,true,false]],
 ['warning only',['2'],[0,0,1,true,false]],
 ['clean',['clean'],[0,0,0,true,true]],
 ['mixed',['failure','throw','1','2','clean'],[2,1,1,false,false]],
 ['hint',['4'],[0,0,0,true,false]],
]) test(name, async () => {
 const {details:d,content} = await run(files);
 assert.deepEqual([d.tool_error_count,d.diagnostic_error_count,d.warning_count,d.execution_ok,d.code_clean],expected);
 assert.equal(d.ok,d.execution_ok); assert.equal(d.error_count,d.tool_error_count);
 for(const key of ['tool_error_count','diagnostic_error_count','warning_count','execution_ok','code_clean']) assert.ok(content[0].text.includes(`${key}=${d[key]}`));
 assert.match(content[0].text,/not code errors/);
});
test('registration preserves allowlists and exposes only the six slim tools', async () => {
 const tools=[]; const handlers={};
 await create_lsp_extension()({registerTool(t){tools.push(t.name);},on(e,h){handlers[e]=h;},registerCommand(){},setActiveTools(){throw Error('must not override allowlist');}});
 assert.deepEqual(tools.sort(), ['lsp_diagnostics_many','lsp_hover','lsp_definition','lsp_references','lsp_find_symbol','lsp_document_symbols'].sort());
 assert.ok(!tools.includes('lsp_diagnostics'));
 await handlers.session_shutdown();
});
test('prompt gating and deduplication', () => {
 assert.equal(should_inject_lsp_prompt({systemPromptOptions:{selectedTools:['read']}}),false);
 assert.equal(should_inject_lsp_prompt({systemPromptOptions:{selectedTools:['lsp_hover']}}),true);
 const p=append_lsp_system_prompt('base'); assert.equal(append_lsp_system_prompt(p),p);
 assert.match(p,/Before completion or commit/); assert.match(p,/warning_count/);
});
