import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const packageRoot = process.env.PI_WEB_CHAT_PACKAGE_ROOT || source;
const root = await mkdtemp(join(tmpdir(), 'pi-native-child-chat-'));
const home = join(root, 'home'), agent = join(home, '.pi/agent'), cwd = join(home, 'workspace');
let web, browser, page;
const log = createWriteStream(join(root, 'web.log'));
const runId = 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa';
try {
  await mkdir(join(agent, 'extensions'), { recursive: true }); await mkdir(join(agent, 'agents'), { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [], defaultProvider:'fixture', defaultModel:'one' }));
  await writeFile(join(agent, 'agents/settings.json'), JSON.stringify({ builtInEnabled:false }));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers:{fixture:{baseUrl:'http://127.0.0.1:1',apiKey:'fixture',api:'openai-completions',models:[{id:'one',name:'Fixture One',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]}} }));
  process.env.PI_CODING_AGENT_DIR = agent;
  const { SessionManager } = await import(pathToFileURL(join(packageRoot,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const manager = SessionManager.create(cwd); manager.appendMessage({role:'user',content:'主代理原始对话',timestamp:Date.now()});
  const sessionId = manager.getSessionId();
  const childFile = join(agent,'sessions','fixture-child.jsonl');
  const entry = (text) => JSON.stringify({type:'message',id:Math.random().toString(16).slice(2),message:{role:'assistant',content:[{type:'text',text}],model:'one',provider:'fixture',timestamp:Date.now()}})+'\n';
  await writeFile(childFile, entry('正在调查网页'));
  const snapshot = { fleet:{entries:[],totalActive:0},asyncSnapshot:{runs:[{id:runId,kind:'single',label:'测试子代理',state:'running',children:[{id:'step:0',kind:'step',label:'scout',state:'running'}]}]} };
  const transcript = `Run: ${runId}\nState: running\nArtifacts:\n  Session: ${childFile}\n\nTranscript tail`;
  // An isolated faux RPC provider: real Web API/reader, no real model calls or user settings.
  await writeFile(join(agent,'extensions/fixture.ts'), `export default function(pi) { pi.events.on('subagents:rpc:v1:request', request => { const data = request.params?.view === 'transcript' ? {text:${JSON.stringify(transcript)},...${JSON.stringify(snapshot)}} : ${JSON.stringify(snapshot)}; pi.events.emit('subagents:rpc:v1:reply:'+request.requestId,{version:1,requestId:request.requestId,success:true,data}); }); }`);
  const probe=createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const base=`http://127.0.0.1:${port}`;
  web=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],{cwd:packageRoot,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:agent,PI_WEB_HOSTNAME:'127.0.0.1',PI_WEB_PASSWORD:'',PI_WEB_DISABLE_MCP:'1',PI_OFFLINE:'1',NODE_ENV:'production'}});
  web.stdout.pipe(log); web.stderr.pipe(log);
  const deadline=Date.now()+30000;
  while(true) {try {if((await fetch(base)).status===200) break;}catch{} assert.ok(Date.now()<deadline&&web.exitCode===null,'Server unavailable'); await new Promise(r=>setTimeout(r,200));}
  const response=await fetch(`${base}/api/agent/${sessionId}/subagents?id=${runId}&view=chat`);
  const data=await response.json(); assert.equal(response.status,200,JSON.stringify(data)); assert.equal(data.messages[0].content[0].text,'正在调查网页');
  const denied=await fetch(`${base}/api/agent/${sessionId}/subagents?id=foreign-run&view=chat`); assert.equal(denied.status,403);
  const unsafeStop = await fetch(`${base}/api/agent/${sessionId}/subagents`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'stop',params:{id:runId,index:0}})});
  assert.equal(unsafeStop.status,400);
  browser=await chromium.launch({headless:true,channel:'chrome'});
  for (const width of (process.env.PI_WEB_TEST_MOBILE === '1' ? [1280,390] : [1280])) {
    await writeFile(childFile,entry('正在调查网页'));
    const context=await browser.newContext({viewport:{width,height:900},locale:'zh-CN'}); await context.addInitScript(()=>{
      localStorage.setItem('pi-locale','zh-CN');
      localStorage.setItem("pi-ui-language-version", "english-interface-v1"); // Explicit test locale after migration.
      window.__sources=[]; const Original=window.EventSource;
      window.EventSource=class extends Original { constructor(...args) { super(...args); window.__sources.push(this); } };
    });
    page=await context.newPage(); page.setDefaultTimeout(15000); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/models?**',route=>route.fulfill({json:{models:{},modelList:[{provider:'fixture',id:'one',name:'Fixture One'}],defaultModel:null,thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}}}));
    await page.goto(`${base}/?session=${sessionId}`);
    const openSwitcher = async () => {
      await page.locator('.chat-content').waitFor();
      if (width < 600 && !await page.getByRole('button',{name:'代理切换',exact:true}).isVisible()) await page.locator('[data-mobile-toolbar-more]').click();
      await page.getByRole('button',{name:'代理切换',exact:true}).click();
    };
    await openSwitcher();
    await page.getByRole('option').filter({hasText:'测试子代理'}).click();
    await page.getByText('正在调查网页',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'返回主代理',exact:true}).count(),0);
    assert.equal(await page.getByText(/输入仍发给主代理/).count(),0);
    await appendFile(childFile,entry('调查已完成'));
    await page.getByText('调查已完成',{exact:true}).waitFor();
    await page.screenshot({path:join(root,`child-${width}.png`)});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1); assert.equal(overflow,false,'Horizontal overflow');
    await page.evaluate(()=>window.__sources.forEach(source=>source.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'extension_ui_request',id:'child-view-confirm',method:'confirm',title:'权限确认',message:'查看子代理时权限提示仍然可见'})}))));
    await page.getByText('查看子代理时权限提示仍然可见',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await openSwitcher();
    await page.getByRole('option').filter({has:page.getByText('主 Agent',{exact:true})}).click();
    await page.locator('.chat-content').getByText('主代理原始对话',{exact:true}).waitFor();
    await openSwitcher();
    assert.equal(await page.getByRole('button',{name:'任务管理',exact:true}).count(),0);
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]); await context.close();
  }
  const result={passed:true,packageRoot,buildId:(await readFile(join(packageRoot,'.next/BUILD_ID'),'utf8')).trim(),artifacts:root,realModelRequests:0,checks:['owned chat API','foreign run denied',process.env.PI_WEB_TEST_MOBILE === '1' ? 'native switcher desktop/mobile' : 'native switcher desktop','task management entry hidden','native message cards','automatic updates','return to main','no horizontal overflow','parent permission dialog visible while viewing child']};
  await writeFile(join(source,'../native-agent-switcher/smoke-result.json'),JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result,null,2));
} catch(error) {console.error('Artifacts:',root); if(page&&!page.isClosed()) await page.screenshot({path:join(root,'failure.png')}).catch(()=>{}); throw error;}
finally {await browser?.close(); if(web&&web.exitCode===null){web.kill('SIGTERM');await once(web,'exit');}log.end();}
