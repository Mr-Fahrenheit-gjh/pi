import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

export function prepareQuietFixture(agentDir) {
  const timestamp = new Date().toISOString(), project = join(agentDir,"project");
  const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const assistant = content => ({role:"assistant",content,api:"openai-completions",provider:"test",model:"test",usage,stopReason:"stop",timestamp:Date.now()});
  const messages = [
    {role:"user",content:"工具折叠候选检查",timestamp:Date.now()},
    assistant([{type:"text",text:"过程说明始终可见"},{type:"thinking",thinking:"QUIET_THINKING"},{type:"toolCall",id:"call1",name:"read",arguments:{path:"QUIET_PATH"}}]),
    {role:"toolResult",toolCallId:"call1",toolName:"read",content:[{type:"text",text:"QUIET_FAILURE_DETAIL"}],isError:true,timestamp:Date.now()},
    assistant([{type:"text",text:"工具折叠候选正式回答"}]),
  ];
  const entries=[{type:"session",version:3,id:"suggestions-quiet",timestamp,cwd:project}];
  for(const [index,message] of messages.entries()) entries.push({type:"message",id:`quiet-${index}`,parentId:index?`quiet-${index-1}`:null,timestamp,message});
  mkdirSync(join(agentDir,"sessions/test"),{recursive:true});
  writeFileSync(join(agentDir,"sessions/test/suggestions-quiet.jsonl"),entries.map(entry=>JSON.stringify(entry)).join("\n")+"\n");
}

export async function runQuietChecks(page, options) {
  const checks=[];
  const assert=(condition,message)=>{if(!condition) throw new Error(message);checks.push(message);};
  await page.setViewportSize({width:1280,height:900});
  await page.addInitScript(()=>{
    localStorage.setItem("pi-locale","zh-CN");
    window.__quietSources=[];
    window.EventSource=class {
      static CONNECTING=0;static OPEN=1;static CLOSED=2;
      readyState=1;onmessage=null;onerror=null;
      constructor(){window.__quietSources.push(this);setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:"connected",isStreaming:false})}),0);}
      close(){this.readyState=2;}
    };
    window.__quietFeed=event=>window.__quietSources.filter(source=>source.readyState===1).forEach(source=>source.onmessage?.({data:JSON.stringify(event)}));
  });
  const state={running:false,state:{isStreaming:false,isPromptRunning:false,messages:[],thinkingLevel:"off",extensionStatuses:[],extensionWidgets:[]}};
  await page.route("**/api/agent/*/subagents**",route=>route.fulfill({json:{available:false}}));
  await page.route("**/api/sessions/suggestions-quiet/state",route=>route.fulfill({json:state}));
  await page.route("**/api/agent/suggestions-quiet",route=>route.fulfill({json:state}));
  await page.goto(`${options.baseURL}/?session=suggestions-quiet`,{waitUntil:"domcontentloaded"});
  await page.getByText("工具折叠候选正式回答",{exact:true}).waitFor();
  await page.getByText("过程说明始终可见",{exact:true}).waitFor();
  assert(await page.locator("[data-process-details]").count()===0,"Completed history has no permanent process disclosure");
  assert(await page.getByText("QUIET_FAILURE_DETAIL",{exact:true}).count()===0,"Completed tool results stay hidden");
  state.running=true;state.state.isStreaming=true;state.state.isPromptRunning=true;
  await page.evaluate(()=>window.__quietFeed({type:"agent_start"}));
  const active=page.locator("[data-process-details][data-running]");
  const toggle=active.locator(":scope > button");
  await active.getByText("Pi is working",{exact:true}).waitFor();
  assert(await toggle.getAttribute("aria-expanded")==="false","Running process starts folded");
  for(let i=0;i<3;i++) {
    await toggle.click();
    if(i===0) await page.getByRole("button",{name:/read.*QUIET_PATH/}).click();
    await page.getByText("QUIET_FAILURE_DETAIL",{exact:true}).waitFor();
    await toggle.click();
    assert(await page.getByText("QUIET_FAILURE_DETAIL",{exact:true}).count()===0,`Running process can expand and collapse (${i+1})`);
  }
  const message={role:"assistant",content:[{type:"text",text:"流式说明可见"},{type:"thinking",thinking:"QUIET_STREAM_THINKING"}],api:"openai-completions",provider:"test",model:"test",timestamp:Date.now()};
  await page.evaluate(message=>window.__quietFeed({type:"message_start",message}),message);
  await page.getByText("流式说明可见",{exact:true}).waitFor();
  assert(await toggle.getAttribute("aria-expanded")==="false","New streamed output does not force open the process");
  assert(await page.getByText("QUIET_STREAM_THINKING",{exact:true}).count()===0,"Thinking stays folded while prose is visible");
  assert(await active.locator(':scope > [role="status"]').filter({hasText:"工具执行失败"}).count()===0,"No failure summary outside the process");
  await page.screenshot({path:`${options.outputDir}/quiet-tools.png`,fullPage:true});
  return {passed:true,checks,quietToolsCollapsed:true,completedProcessHidden:true,runningToggleVerified:true,mocked:true,realModelRequests:0};
}
