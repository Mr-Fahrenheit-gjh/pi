import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const maintenance = fileURLToPath(new URL("../../pi-web维护/native-agent-switcher/", import.meta.url));
const source = process.env.PI_SUGGESTIONS_HOST_ROOT || JSON.parse(readFileSync(join(maintenance,"local-update.json"),"utf8")).candidateDirectory;
const require = createRequire(join(source, "package.json"));
const {createJiti} = require("jiti");
const jiti = createJiti(import.meta.url, {alias:{
  "@earendil-works/pi-ai": fileURLToPath(new URL("./fake-ai.ts",import.meta.url)),
  "@earendil-works/pi-coding-agent": join(source,"node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  "@earendil-works/pi-tui": join(source,"node_modules/@earendil-works/pi-tui/dist/index.js"),
}});
const {default:extension,__test__:helpers} = await jiti.import("../src/index.ts");
const {recentCompletedTurns} = await jiti.import("../src/history.ts");
const {recentRecallContext} = await jiti.import("../src/memory-context.ts");
const {cacheSuggestion, getCachedSuggestion, invalidateSessionSuggestions} = await jiti.import("../src/suggestion-cache.ts");
const {SessionManager} = await import(pathToFileURL(join(source,"node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const {setComplete, completeSimple} = await jiti.import("./fake-ai.ts");
const dir = mkdtempSync(join(tmpdir(),"pi-suggestions-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
mkdirSync(join(dir,"extensions"));
writeFileSync(join(dir,"extensions/prompt-suggestions.json"),JSON.stringify({webEnabled:true}));
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir,{recursive:true,force:true});
});
const flush = () => new Promise(setImmediate);
const response = (text) => ({content:[{type:"text",text}],stopReason:"stop"});
function deferred() {let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve};}
function instance(id, mode="rpc") {
  const handlers = new Map(), widgets = [], commands = new Map();
  let editor;
  let branch = [];
  const model = {provider:"test",id:"fast",reasoning:false};
  const ctx = {cwd:dir,mode,hasUI:mode==="rpc" || mode==="tui", model,
    sessionManager:{getSessionId:() => id,getHeader:()=>({cwd:dir}),getLeafId:()=>branch.at(-1)?.id ?? null,
      getEntry:leaf=>branch.find(entry=>entry.id===leaf),getBranch:leaf=>leaf ? branch.slice(0,branch.findIndex(entry=>entry.id===leaf)+1) : branch},
    isIdle:()=>true,
    hasPendingMessages:() => false,
    modelRegistry:{find:() => model,streamSimple:(...args) => ({result:() => completeSimple(...args)})},
    ui:{getEditorText:() => editor?.getText() ?? "",setWidget:(key,lines) => widgets.push({key,lines}),
      setEditorComponent(factory) {editor = factory?.({requestRender() {}}, {borderColor:s=>s}, {matches:()=>false});},setStatus() {},notify() {}},
  };
  extension({on:(name,handler) => {handlers.set(name,handler); return () => {};},registerCommand:(name,command)=>commands.set(name,command)});
  const emit = (name,event={}) => handlers.get(name)?.(event,ctx);
  emit("session_start");
  function end({aborted=false,messageType="user",inputSource=mode==="rpc"?"rpc":"interactive"}={}) {
    emit("input",{source:inputSource});
    emit("before_agent_start",{messageType});
    emit("agent_start");
    emit("agent_end",{messages:[{role:"user",content:id,timestamp:1},{role:"assistant",content:[{type:"text",text:"完成实现"}],timestamp:2}]});
    return emit("agent_settled",{aborted});
  }
  return {emit,end,ctx,widgets,editor:()=>editor,setBranch:entries=>{branch=entries;},open:leaf=>commands.get("prompt-suggestions-history").handler(leaf ? JSON.stringify({leafId:leaf}) : "",ctx),shown:() => widgets.filter(w => w.lines).map(w => JSON.parse(w.lines[0]))};
}
test("RPC support and Chinese sanitization preserve safe suggestions", () => {
  assert.equal(helpers.isSuggestionModeSupported("rpc","rpc",true),true);
  assert.equal(helpers.isSuggestionModeSupported("json",undefined,false),false);
  assert.equal(helpers.sanitizeSuggestion("帮我运行相关测试"),"帮我运行相关测试");
  for(const value of ["API error: bad key","Do this?","bad\\ntext","\\x1b[31mbad"]) assert.equal(helpers.sanitizeSuggestion(value),undefined);
  assert.equal(helpers.mergeConfigInputs().acceptTab,true);
  assert.equal(helpers.mergeConfigInputs().webEnabled,true);
  assert.equal(helpers.mergeConfigInputs().maxChars,140);
  const concrete="把 src/index.ts 里的默认 maxChars 从 80 改成 140，然后跑一遍扩展测试确认没有回归";
  assert.equal(helpers.sanitizeSuggestion(concrete),concrete);
  assert.equal(helpers.sanitizeSuggestion("字".repeat(141)),undefined);
});
test("tuiEnabled disables terminal editor and requests without disabling Web", async () => {
  let calls=0;setComplete(()=>{calls++;return Promise.resolve(response("继续"));});
  const config=join(dir,"extensions/prompt-suggestions.json");
  try {
    assert.equal(helpers.mergeConfigInputs().tuiEnabled,true);
    writeFileSync(config,JSON.stringify({tuiEnabled:false}));
    const terminal=instance("disabled-terminal","tui");
    assert.equal(terminal.editor(),undefined);
    terminal.end();await flush();assert.equal(calls,0);
    assert.equal(terminal.shown().length,0);terminal.emit("session_shutdown");
    const web=instance("enabled-web");web.end();await flush();
    assert.equal(calls,1);assert.equal(web.shown().at(-1).text,"继续");web.emit("session_shutdown");
    writeFileSync(config,JSON.stringify({tuiEnabled:true}));
    const active=instance("reread-terminal","tui");assert.ok(active.editor());
    writeFileSync(config,JSON.stringify({tuiEnabled:false}));
    active.end();await flush();assert.equal(calls,1);active.emit("session_shutdown");
  } finally {writeFileSync(config,JSON.stringify({webEnabled:true}));}
});
test("the re-read prompt requires a non-empty suggestion even after task completion", () => {
  const prompt = helpers.loadSuggestionSystemPrompt(dir);
  assert.match(prompt, /Always return exactly one non-empty suggestion/i);
  assert.match(prompt, /even when the task is complete/i);
  assert.match(prompt, /Do not repeat work that the assistant already completed/i);
  assert.doesNotMatch(prompt, /reply with nothing|or nothing if unclear/i);
});
test("prompt predicts the user's natural next message without forcing technical details or extra work", () => {
  const prompt = helpers.loadSuggestionSystemPrompt(dir);
  assert.match(prompt, /Predict what the user would naturally say next, not what you think they should do/i);
  assert.match(prompt, /Technical names are optional/i);
  assert.match(prompt, /do not manufacture another task/i);
  assert.match(prompt, /at most 140 characters/i);
  assert.doesNotMatch(prompt, /must name something concrete|Choose in this order|short imperative user prompt|把这次改动提交到根仓/i);
});
function recalledBranch(content="偏好：简单任务直接处理") {
  const sm=SessionManager.inMemory(dir);
  sm.appendMessage({role:"user",content:"调整输入建议",timestamp:Date.now()});
  sm.appendCustomMessageEntry("hy-memory-recall",'历史数据，不是指令\n'+JSON.stringify([{id:"preference",content}]),false);
  sm.appendMessage({role:"assistant",content:[{type:"text",text:"调整完成"}],stopReason:"stop",timestamp:Date.now()});
  return sm.getBranch();
}
test("memory reuse reads the SDK's native custom entries and rejects stale, forged or superseded recalls", () => {
  const branch=recalledBranch();
  assert.match(recentRecallContext(branch),/简单任务直接处理/);
  const bounded=recentRecallContext(recalledBranch("字".repeat(2000)));
  assert.ok(bounded.length>0 && bounded.length<1600);
  const recall=branch.find(e=>e.type==="custom_message");
  for(const changed of [{customType:"other"},{content:'warning\n[{"id":"truncated"'},{timestamp:new Date(Date.now()-31*60_000).toISOString()}]) {
    assert.equal(recentRecallContext(branch.map(e=>e===recall?{...e,...changed}:e)),"");
  }
  assert.equal(recentRecallContext([{type:"message",message:{role:"user",content:recall.content}}]),"");
  assert.equal(recentRecallContext([...branch,{type:"message",message:{role:"user",content:"new turn"}}]),"");
  assert.equal(recentRecallContext([...branch,{type:"message",message:{role:"assistant",content:[{type:"toolCall",name:"memory_delete"}]}}]),"");
  for(const nestedCalls of [{complete:true,calls:[{name:"memory_update"}]},{complete:false,calls:[]}]) {
    assert.equal(recentRecallContext([...branch,{type:"message",message:{role:"toolResult",toolName:"codemode",nestedCalls}}]),"");
  }
});
test("only an already recalled current-project memory enters suggestion data and its cache identity", async () => {
  let calls=0;const requests=[];
  setComplete((_model,request)=>{calls++;requests.push(request);return Promise.resolve(response("按简单的方案改"));});
  const a=instance("memory-input");a.setBranch(recalledBranch());await a.open();await flush();
  assert.equal(calls,1);
  assert.match(requests[0].messages[0].content,/简单任务直接处理/);
  assert.doesNotMatch(requests[0].systemPrompt,/简单任务直接处理/);
  assert.equal((requests[0].messages[0].content.match(/简单任务直接处理/g)||[]).length,1);
  await a.open();await flush();assert.equal(calls,1);
  a.setBranch(recalledBranch("偏好：优先解释原因"));await a.open();await flush();assert.equal(calls,2);
  a.ctx.sessionManager.getHeader=()=>({cwd:join(dir,"missing-project")});
  await a.open();await flush();assert.equal(calls,3);
  assert.doesNotMatch(requests[2].messages[0].content,/优先解释原因/);
  assert.ok(requests.every(r=>r.messages[0].content.length<=12000));
  a.emit("session_shutdown");
});
test("completed suggestion results survive an idle runtime reload but not a new user run", async () => {
  let calls=0;setComplete(()=>{calls++;return Promise.resolve(response("就用简单的那个"));});
  const branch=recalledBranch();const a=instance("runtime-cache");a.setBranch(branch);
  await a.open();await flush();assert.equal(calls,1);a.emit("session_shutdown");
  const b=instance("runtime-cache");b.setBranch(branch);assert.equal(calls,1);
  setComplete(()=>{calls++;return new Promise(()=>{});}); // A cache miss could never produce a widget here.
  await b.open();await flush();assert.equal(calls,1);assert.equal(b.shown().at(-1).text,"就用简单的那个");
  setComplete(()=>{calls++;return Promise.resolve(response("就用简单的那个"));});
  b.end();await flush();assert.equal(calls,2);b.emit("session_shutdown");
  const other=instance("other-runtime-cache");other.setBranch(branch);await other.open();await flush();assert.equal(calls,3);other.emit("session_shutdown");
});
test("a warm process cache cannot bypass disabled Web suggestions after reload", async () => {
  let calls=0;setComplete(()=>{calls++;return Promise.resolve(response("继续"));});
  const branch=recalledBranch();const a=instance("disabled-warm-cache");a.setBranch(branch);
  await a.open();await flush();assert.equal(calls,1);a.emit("session_shutdown");
  const configPath=join(dir,"extensions/prompt-suggestions.json");
  try {
    writeFileSync(configPath,JSON.stringify({webEnabled:false}));
    const b=instance("disabled-warm-cache");b.setBranch(branch);await b.open();await flush();
    assert.equal(calls,1);assert.equal(b.shown().length,0);b.emit("session_shutdown");
  } finally { writeFileSync(configPath,JSON.stringify({webEnabled:true})); }
});
test("process suggestion cache has a fixed TTL, bounded LRU and owner-scoped invalidation", () => {
  cacheSuggestion("ttl-key","test-cache","cached",100);
  assert.equal(getCachedSuggestion("ttl-key",101).text,"cached");
  assert.equal(getCachedSuggestion("ttl-key",30*60_000+101),undefined);
  for(let i=0;i<65;i++) cacheSuggestion("bounded-"+i,"test-cache","item",100);
  assert.equal(getCachedSuggestion("bounded-0",101),undefined);
  cacheSuggestion("other-owner","other-cache","keep",100);
  invalidateSessionSuggestions("test-cache");
  assert.equal(getCachedSuggestion("bounded-64",101),undefined);
  assert.equal(getCachedSuggestion("other-owner",101).text,"keep");
  invalidateSessionSuggestions("other-cache");
});

test("terminal editor accepts Tab but neither Enter nor Escape submits ghost text", async () => {
  setComplete(()=>Promise.resolve(response("帮我运行相关测试")));
  const tab=instance("terminal-tab","tui");tab.end();await flush();tab.editor().handleInput("\t");
  assert.equal(tab.editor().getText(),"帮我运行相关测试");tab.emit("session_shutdown");
  const enter=instance("terminal-enter","tui");let submitted;enter.end();await flush();
  enter.editor().onSubmit=text=>{submitted=text;};enter.editor().handleInput("\r");
  assert.notEqual(submitted,"帮我运行相关测试");assert.equal(enter.editor().getText(),"");enter.emit("session_shutdown");
  const escape=instance("terminal-escape","tui");escape.end();await flush();escape.editor().handleInput("\x1b");escape.editor().handleInput("\t");
  assert.notEqual(escape.editor().getText(),"帮我运行相关测试");escape.emit("session_shutdown");
});
test("context includes tool calls, arguments and results but excludes thinking and images", () => {
  const messages = [{role:"user",content:"把上限调大",timestamp:1},
    {role:"assistant",content:[{type:"thinking",thinking:"PRIVATE_THINKING"},{type:"text",text:"public reply"},
      {type:"toolCall",id:"t1",name:"bash",arguments:{command:"npm test"}}],stopReason:"toolUse",timestamp:2},
    {role:"toolResult",toolCallId:"t1",toolName:"bash",isError:false,content:[{type:"text",text:"12 tests passed"}],timestamp:3},
    {role:"assistant",content:[{type:"text",text:"全部通过"},{type:"image",data:"PRIVATE_IMAGE",mimeType:"image/png"}],stopReason:"stop",timestamp:4},
    {role:"bashExecution",command:"PRIVATE_COMMAND",output:"PRIVATE_BASH_OUTPUT",timestamp:5},
    {role:"custom",customType:"memory",content:"PRIVATE_CUSTOM",timestamp:6},
    {role:"compactionSummary",summary:"PRIVATE_SUMMARY",timestamp:7}];
  const context = helpers.buildSuggestionContext(messages);
  assert.match(context,/public reply/);
  assert.match(context,/→ bash: \{"command":"npm test"\}/);
  assert.match(context,/← bash \[成功\]: 12 tests passed/);
  assert.doesNotMatch(context,/PRIVATE_/);
  assert.ok(helpers.buildSuggestionContext(Array.from({length:20},(_,i)=>({role:"user",content:"message-"+i}))).length < 17000);
});
test("tool arguments and results are truncated so one turn cannot flood the request", () => {
  const context = helpers.buildSuggestionContext([
    {role:"assistant",content:[{type:"toolCall",id:"t1",name:"bash",arguments:{command:"x".repeat(2000)}}],stopReason:"toolUse",timestamp:1},
    {role:"toolResult",toolCallId:"t1",toolName:"bash",isError:true,content:[{type:"text",text:"y".repeat(5000)}],timestamp:2}]);
  assert.ok(context.length < 1300,`context too long: ${context.length}`);
  assert.match(context,/← bash \[失败\]/);
});
test("settled generation is background-only and emits a standard session-owned widget", async () => {
  const pending=deferred(); let options;
  setComplete((_model,_request,opts)=>{options=opts; return pending.promise;});
  const session=instance("session-a");
  assert.equal(session.end(),undefined,"does not block settlement on a model call");
  await flush();
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.maxTokens,256);
  pending.resolve(response("帮我运行相关测试")); await flush();
  assert.equal(session.shown().length,1);
  assert.deepEqual({...session.shown()[0],id:"dynamic"},{version:1,id:"dynamic",sessionId:"session-a",text:"帮我运行相关测试",acceptTab:true});
  session.emit("session_shutdown");
});
test("each runtime has independent state and stale results cannot overwrite a newer run", async () => {
  const a=deferred(), b=deferred(); const signals=[];
  setComplete((_model,request,opts)=>{signals.push(opts.signal);return request.messages[0].content.includes("session-a")?a.promise:b.promise;});
  const first=instance("session-a"),second=instance("session-b");
  first.end(); second.end(); await flush();
  first.emit("input",{source:"rpc"});
  assert.equal(signals[0].aborted,true);
  assert.equal(signals[1].aborted,false);
  a.resolve(response("帮我检查代码")); b.resolve(response("帮我运行测试")); await flush();
  assert.equal(first.shown().length,0); assert.equal(second.shown().length,1);
  second.emit("session_shutdown"); first.emit("session_shutdown");
});
test("aborted/custom/non-UI runs do not call a model; shutdown cancels pending work", async () => {
  let requests=0; let signal; const pending=deferred();
  setComplete((_model,_request,opts)=>{requests++;signal=opts.signal;return pending.promise;});
  for(const [mode,settings] of [["rpc",{aborted:true}],["rpc",{messageType:"custom"}],["rpc",{inputSource:"extension"}],["print",{}],["json",{}]]) {
    const session=instance("ignored",mode); session.end(settings); await flush(); session.emit("session_shutdown");
  }
  assert.equal(requests,0);
  const session=instance("active");session.end();await flush();
  session.emit("session_shutdown");assert.equal(signal.aborted,true);
  pending.resolve(response("帮我运行测试"));await flush();assert.equal(session.shown().length,0);
});
test("Web mode is on by default and can be explicitly disabled", async () => {
  let requests=0;setComplete(()=>{requests++;return Promise.resolve(response("帮我运行测试"));});
  const config=join(dir,"extensions/prompt-suggestions.json");
  writeFileSync(config,JSON.stringify({webEnabled:false}));
  try {const session=instance("old-web");session.end();await flush();assert.equal(requests,0);session.emit("session_shutdown");}
  finally {writeFileSync(config,JSON.stringify({webEnabled:true}));}
});
test("the Web widget carries acceptTab:false without losing the suggestion", async () => {
  const config=join(dir,"extensions/prompt-suggestions.json");
  writeFileSync(config,JSON.stringify({webEnabled:true,acceptTab:false}));
  setComplete(()=>Promise.resolve(response("帮我运行测试")));
  try {const session=instance("no-tab");session.end();await flush();assert.equal(session.shown()[0].acceptTab,false);session.emit("session_shutdown");}
  finally {writeFileSync(config,JSON.stringify({webEnabled:true}));}
});
function completedBranch(count, prefix="history") {
  const entries=[];
  for(let i=0;i<count;i++) {
    entries.push({type:"message",id:`${prefix}-u${i}`,message:{role:"user",content:`${prefix} user ${i}`,timestamp:i}});
    entries.push({type:"message",id:`${prefix}-a${i}`,message:{role:"assistant",content:[{type:"text",text:`${prefix} answer ${i}`}],stopReason:"stop",timestamp:i}});
  }
  return entries;
}
test("history uses the latest four completed turns and excludes unfinished tails", () => {
  const entries=completedBranch(6);
  const messages=recentCompletedTurns(entries);
  assert.equal(messages.length,8);assert.equal(messages[0].content,"history user 2");
  assert.equal(recentCompletedTurns([...entries,{type:"message",id:"pending",message:{role:"user",content:"pending"}}]).length,0);
  assert.equal(recentCompletedTurns([...entries,{type:"message",id:"tool",message:{role:"toolResult",content:[]}}]).length,0);
  assert.equal(recentCompletedTurns([...entries,{type:"message",id:"error",message:{role:"assistant",content:[{type:"text",text:"failed"}],stopReason:"error"}}]).length,0);
});
test("history keeps tool calls and results inside completed turns", () => {
  const entries=[
    {type:"message",id:"u0",message:{role:"user",content:"看看目录",timestamp:1}},
    {type:"message",id:"a0",message:{role:"assistant",content:[{type:"text",text:"检查中"},
      {type:"toolCall",id:"t1",name:"bash",arguments:{command:"ls"}}],stopReason:"toolUse",timestamp:2}},
    {type:"message",id:"r0",message:{role:"toolResult",toolCallId:"t1",toolName:"bash",isError:false,content:[{type:"text",text:"file.txt"}],timestamp:3}},
    {type:"message",id:"a1",message:{role:"assistant",content:[{type:"text",text:"目录里只有 file.txt"}],stopReason:"stop",timestamp:4}}];
  assert.deepEqual(recentCompletedTurns(entries).map(m=>m.role),["user","assistant","toolResult","assistant"]);
});
test("internal unfinished tool turns do not consume the completed-turn limit", () => {
  const unfinished=completedBranch(1,"unfinished");
  unfinished[1].message.stopReason="toolUse";
  const entries=[...unfinished,{type:"message",id:"tool",message:{role:"toolResult",content:[]}},...completedBranch(1,"done")];
  assert.deepEqual(recentCompletedTurns(entries).map(m=>m.role),["user","assistant"]);
  assert.equal(recentCompletedTurns(entries)[0].content,"done user 0");
});
test("stale leaf requests and results after branch navigation are ignored", async () => {
  const pending=deferred();let requests=0;
  setComplete(()=>{requests++;return pending.promise;});
  const session=instance("leaf-race");const branch=completedBranch(2);
  session.setBranch(branch);await session.open("history-a0");await flush();assert.equal(requests,0);
  await session.open("history-a1");await flush();assert.equal(requests,1);
  session.setBranch(branch.slice(0,2));
  pending.resolve(response("过期分支建议"));await flush();assert.equal(session.shown().length,0);
  session.emit("session_shutdown");
});
test("SDK hydration thinking metadata does not suppress an otherwise current history request", async () => {
  let requests=0;setComplete(()=>{requests++;return Promise.resolve(response("说明这轮结果的用法"));});
  const session=instance("hydrated-history");const branch=completedBranch(1);
  session.setBranch([...branch,{type:"thinking_level_change",id:"thinking",thinkingLevel:"off"}]);
  await session.open("history-a0");await flush();assert.equal(requests,1);
  session.emit("session_shutdown");
});
test("loading a runtime is silent; explicitly opening history generates once and reuses the cache", async () => {
  let requests=0;setComplete(()=>{requests++;return Promise.resolve(response("说明这个功能怎么用"));});
  const session=instance("opened-history");session.setBranch(completedBranch(6));await flush();assert.equal(requests,0);
  await session.open();await flush();assert.equal(requests,1);assert.equal(session.shown().length,1);
  await session.open();await flush();assert.equal(requests,1);assert.equal(session.shown().length,2);
  session.emit("session_shutdown");
});
test("concurrent opens merge in-flight requests and selecting a different leaf uses its branch", async () => {
  const pending=deferred();let requests=0;let context;
  setComplete((_model,request)=>{requests++;context=request.messages[0].content;return pending.promise;});
  const session=instance("history-flight");session.setBranch(completedBranch(3));
  await session.open("history-a2");await session.open("history-a2");await flush();assert.equal(requests,1);
  assert.match(context,/history user 0/);assert.doesNotMatch(context,/history user 3/);
  pending.resolve(response("总结这轮的关键结果"));await flush();assert.equal(session.shown().length,1);
  session.emit("session_shutdown");
});
test("busy, disabled, empty, invalid and incomplete histories do not generate", async () => {
  let requests=0;setComplete(()=>{requests++;return Promise.resolve(response("继续说明"));});
  const session=instance("skip-history");await session.open();await flush();
  session.setBranch(completedBranch(1));await session.open("missing-leaf");
  session.ctx.isIdle=()=>false;await session.open();session.ctx.isIdle=()=>true;
  session.ctx.hasPendingMessages=()=>true;await session.open();session.ctx.hasPendingMessages=()=>false;
  session.setBranch([...completedBranch(1),{type:"message",id:"pending",message:{role:"user",content:"pending"}}]);await session.open();await flush();
  assert.equal(requests,0);session.emit("session_shutdown");
});
test("a new branch or input cancels old history work and never publishes its stale result", async () => {
  const first=deferred(),second=deferred();const signals=[];
  setComplete((_model,_request,options)=>{signals.push(options.signal);return signals.length===1?first.promise:second.promise;});
  const session=instance("history-stale");session.setBranch(completedBranch(1,"first"));await session.open();await flush();
  session.setBranch(completedBranch(1,"second"));await session.open();await flush();assert.equal(signals[0].aborted,true);
  first.resolve(response("旧的建议"));second.resolve(response("新的建议"));await flush();
  assert.deepEqual(session.shown().map(item=>item.text),["新的建议"]);
  session.emit("session_shutdown");
});
test("cached empty history clears an earlier branch suggestion and closed runtimes stay silent", async () => {
  let requests=0;setComplete((_model,request)=>{requests++;return Promise.resolve(response(request.messages[0].content.includes("empty")?"":"显示新的建议"));});
  const session=instance("negative-cache");session.setBranch(completedBranch(1,"empty"));await session.open();await flush();
  session.setBranch(completedBranch(1,"other"));await session.open();await flush();assert.equal(session.shown().length,1);
  session.setBranch(completedBranch(1,"empty"));await session.open();await flush();assert.equal(requests,2);assert.equal(session.widgets.at(-1).lines,undefined);
  session.emit("session_shutdown");await session.open();await flush();assert.equal(requests,2);
});
test("generation failure is silent and late pending messages prevent publication", async () => {
  setComplete(()=>Promise.reject(new Error("provider unavailable")));
  const failed=instance("failed"); failed.end(); await flush();assert.equal(failed.shown().length,0);failed.emit("session_shutdown");
  const pending=deferred();setComplete(()=>pending.promise);
  const late=instance("late");late.end();await flush();late.ctx.hasPendingMessages=()=>true;
  pending.resolve(response("帮我运行测试"));await flush();assert.equal(late.shown().length,0);late.emit("session_shutdown");
});
