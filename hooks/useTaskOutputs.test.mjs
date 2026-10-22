import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as paths from '../lib/task-outputs.ts';
const source=readFileSync(new URL('./useTaskOutputs.ts',import.meta.url),'utf8');
const script=new Script(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText);

function fixture({blocked=false,prefix=''}={}) {
 const stored=new Map(),cells=[],effects=[];let cursor=0;
 const exports={};
 script.runInNewContext({exports,localStorage:{getItem(key){if(blocked)throw Error('blocked');return stored.get(key)??null;},setItem(key,value){if(blocked)throw Error('blocked');stored.set(key,value);}},require(id){
  if(id==='@/lib/task-outputs')return paths;
  if(id==='@/lib/runtime-client.mjs')return{runtimeStorageKey:key=>prefix+key};
  if(id==='react')return{
   useState(initial){const i=cursor++;if(!(i in cells))cells[i]=initial;return[cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;}];},
   useRef(initial){const i=cursor++;if(!(i in cells))cells[i]={current:initial};return cells[i];},
   useEffect(fn,deps){const i=cursor++;if(!cells[i]||deps.some((d,j)=>d!==cells[i][j]))effects.push(fn);cells[i]=deps;}
  };throw Error(id);
 }});
 return{stored,render(session='a',cwd='/project'){cursor=0;return exports.useTaskOutputs(session,cwd);},flush(){for(const fn of effects.splice(0))fn();}};
}

test('hydration preserves saved data; session switches never expose the old list',()=>{
 const f=fixture();const key=paths.taskOutputKey('a','/project');f.stored.set(key,JSON.stringify(['saved.md']));
 assert.equal(f.render().ready,false);assert.equal(f.stored.get(key),'["saved.md"]');f.flush();
 let r=f.render();assert.deepEqual(Array.from(r.paths),['saved.md']);r.pin('new.pdf');
 assert.deepEqual(Array.from(f.render().paths),['saved.md','new.pdf']);
 assert.deepEqual(Array.from(f.render('b').paths),[]);f.flush();r=f.render('b');r.pin('b.md');
 assert.deepEqual(Array.from(f.render('a').paths),[]);f.flush();assert.deepEqual(Array.from(f.render('a').paths),['saved.md','new.pdf']);
});

test('invalid paths and cross-workspace references cannot be persisted',()=>{
 const f=fixture();f.render();f.flush();let r=f.render();r.pin('../secret');r.pin('/other/a.md');assert.equal(f.stored.size,0);
 r.pin('safe.md');f.render('a','/other');f.flush();assert.deepEqual(Array.from(f.render('a','/other').paths),[]);
});

test('blocked storage degrades to per-scope memory without crossing sessions',()=>{
 const f=fixture({blocked:true});f.render();f.flush();let r=f.render();assert.equal(r.persisted,false);r.pin('a.md');
 f.render('b');f.flush();r=f.render('b');r.pin('b.md');f.render('a');f.flush();r=f.render('a');
 assert.deepEqual(Array.from(r.paths),['a.md']);assert.equal(r.persisted,false);r.remove('a.md');assert.deepEqual(Array.from(f.render('a').paths),[]);
});

test('runtime identity prefixes persistent keys and empty sessions cannot pin',()=>{
 const f=fixture({prefix:'feynman:'});f.render();f.flush();f.render().pin('a.md');assert(f.stored.has('feynman:'+paths.taskOutputKey('a','/project')));
 f.render(null);f.flush();const r=f.render(null);assert.equal(r.ready,false);r.pin('x.md');assert.equal(f.stored.size,1);
});
