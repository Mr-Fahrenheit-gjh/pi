import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function prepareFixture(agentDir) {
  const project = join(agentDir, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "sessions", "test"), { recursive: true });
  const adapter = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const provider = join(agentDir, "test-provider.ts");
  writeFileSync(provider, `import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  let generation = 0;
  pi.registerCommand("fixture-suggestion", {description:"Synthetic UI suggestion fixture", handler: async (args,ctx) => {
    ctx.ui.setWidget("next-prompt-suggestion", args === "clear" ? undefined : [JSON.stringify({version:1,id:"fixture-"+(++generation),sessionId:args === "wrong-session" ? "another-session" : ctx.sessionManager.getSessionId(),text:args === "long" ? "把输入框里两行建议的高度测一遍，确认第二行完整显示，不要遮住下面的工具栏和发送按钮，同时检查窄窗口下也不会出现滚动条或裁切" : "帮我运行相关测试",acceptTab:args !== "no-tab"})], {placement:"belowEditor"});
  }});
  pi.registerProvider("suggestions-test", {
    baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "synthetic-test-only", api: "openai-completions",
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        const text = JSON.stringify(context.messages).includes("SUGGESTION MODE") ? "帮我运行相关测试" : "候选主回复完成";
        const message = { role: "assistant", content: [{type:"text",text}], api:model.api, provider:model.provider, model:model.id,
          stopReason:"stop", timestamp:Date.now(), usage:{ input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} } };
        stream.push({type:"start",partial:message});
        stream.push({type:"done",reason:"stop",message});
        stream.end(message);
      });
      return stream;
    },
    models:[{id:"fixture",name:"Suggestions fixture",reasoning:false,input:["text"],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]
  });
}`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: [provider, adapter], skills: [],
    defaultProvider: "suggestions-test", defaultModel: "fixture", defaultThinkingLevel: "off", defaultTools: [],
  }));
  writeFileSync(join(agentDir, "extensions", "prompt-suggestions.json"), JSON.stringify({ webEnabled: true }));
  for (const letter of ["a", "b"]) {
    const timestamp = new Date().toISOString();
    const entries = [
      { type: "session", version: 3, id: `suggestions-${letter}`, timestamp, cwd: project },
      { type: "session_info", id: "title", timestamp, name: `建议测试 ${letter.toUpperCase()}` },
      { type: "model_change", id: "model", parentId: "title", timestamp, provider: "suggestions-test", modelId: "fixture" },
      { type: "message", id: "user", parentId: "model", timestamp, message: { role: "user", content: "测试历史", timestamp: Date.now() } },
      { type: "message", id: "answer", parentId: "user", timestamp, message: {
        role: "assistant", content: [{ type: "text", text: `已完成的测试历史 ${letter}` }], api: "openai-completions", provider: "suggestions-test", model: "fixture", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } },
    ];
    writeFileSync(join(agentDir, "sessions", "test", `suggestions-${letter}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  }
  return { agentDir: resolve(agentDir), project };
}
