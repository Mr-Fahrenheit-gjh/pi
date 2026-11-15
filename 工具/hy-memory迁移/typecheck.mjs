// Check against the currently installed Pi SDK, without installing dependencies.
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const sdk=process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent';
const modules=path.dirname(path.dirname(sdk));
const temp=mkdtempSync(path.join(tmpdir(),'pi-hy-memory-types-'));
try {
 const config=path.join(temp,'tsconfig.json');
 writeFileSync(config,JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext',target:'ES2022',strict:true,skipLibCheck:true,noEmit:true,types:['node'],typeRoots:[path.join(modules,'@types')],paths:{'@earendil-works/pi-ai':[path.join(path.dirname(sdk),'pi-ai/dist/index.d.ts')],'@earendil-works/pi-coding-agent':[path.join(sdk,'dist/index.d.ts')]}},files:[path.join(root,'index.ts')]}));
 const result=spawnSync(process.execPath,[path.join(modules,'typescript/bin/tsc'),'-p',config],{stdio:'inherit'});
 if(result.error) throw result.error;
 process.exitCode=result.status===0 ? 0 : (result.status || 1);
} finally {rmSync(temp,{recursive:true,force:true});}
