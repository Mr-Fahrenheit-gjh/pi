import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadModules } from '../test/load-modules.js';
const { LspClient, file_path_to_uri } = await loadModules();
const root=resolve('.');
const client=new LspClient({command:'tsc',args:['--lsp','--stdio'],root_uri:file_path_to_uri(root),language_id_for_uri:()=> 'javascript',request_timeout_ms:15000});
let errors=0, warnings=0;
try {
 await client.start();
 for(const dir of ['src','test','scripts']) for(const name of readdirSync(dir).filter(x=>x.endsWith('.js'))) {
  const file=resolve(dir,name),uri=file_path_to_uri(file);
  await client.ensure_document_open(uri,readFileSync(file,'utf8'));
  const diagnostics=await client.wait_for_diagnostics(uri,3000);
  errors+=diagnostics.filter(d=>d.severity===1).length;
  warnings+=diagnostics.filter(d=>d.severity===2).length;
  console.log(`${dir}/${name}: ${JSON.stringify(diagnostics)}`);
 }
 console.log(JSON.stringify({diagnostic_error_count:errors,warning_count:warnings}));
 process.exitCode=errors ? 1:0;
} finally { await client.stop(); }
