import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Explicitly loaded only by the isolated PTY test. No model call is made.
export default async function (pi: ExtensionAPI) {
  const packagePath = process.env.PI_TEST_ASK_PACKAGE!;
  const { registerAskUserQuestionTool } = await import(pathToFileURL(`${packagePath}/ask-user-question.ts`).href);
  let questionTool: any;
  const capture = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "registerTool") return (tool: any) => { questionTool = tool; target.registerTool(tool); };
      return Reflect.get(target, key, receiver);
    },
  });
  registerAskUserQuestionTool(capture);
  pi.on("session_start", (_event, ctx) => {
    setTimeout(async () => {
      try {
        const result = await questionTool.execute("real-cli-test", { questions: [
          { question: "请选择测试答案？", header: "测试", options: [
            { label: "选项 A", description: "原始说明 A" },
            { label: "选项 B", description: "原始说明 B" },
          ] },
          { question: "请选择测试组合？", header: "多选", multiSelect: true, options: [
            { label: "甲", description: "说明甲" }, { label: "乙", description: "说明乙" },
          ] },
        ] }, undefined, undefined, ctx);
        fs.writeFileSync(process.env.PI_MENUBAR_TEST_RESULT!, JSON.stringify(result));
      } catch (error) {
        fs.writeFileSync(process.env.PI_MENUBAR_TEST_RESULT!, JSON.stringify({ error: String(error) }));
      } finally { ctx.shutdown(); }
    }, 500);
  });
}
