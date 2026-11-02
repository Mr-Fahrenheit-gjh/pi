import { Type } from "typebox";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { approvePeerSend, preparePeerSend, requestPeer } from "./runtime-peer";

export function createRuntimePeerExtension(): InlineExtension {
  return {
    name: "pi-web-runtime-peer", hidden: true,
    factory(api) {
      api.registerCommand("peer-agent", {
        description: "查看另一智能体入口；不启动模型或派发任务",
        async handler(_args, ctx) {
          const data = await requestPeer({ runtime: "pi", sessionId: ctx.sessionManager.getSessionId() }, { action: "locate" });
          ctx.ui.notify(JSON.stringify(data), "info");
        },
      });
      api.registerTool({
        name: "peer_agent", label: "另一智能体",
        description: "与独立 Feynman 协作：locate 定位安装入口；list 搜索对话；read 分页读历史；artifacts 列成果或按 path 读文本；status 查进度。仅当用户明确要求指导/委派时才 send；必须给目标 sessionId，或给 cwd 创建新对话。先读目标上下文，不能自行多轮互聊。接收成功不是完成，之后按需核对历史和成果。不修改或删除对方历史，不读取凭据。",
        parameters: Type.Object({
          action: Type.Union(["locate", "list", "read", "artifacts", "send", "status"].map((value) => Type.Literal(value))),
          sessionId: Type.Optional(Type.String()), query: Type.Optional(Type.String()), before: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
          path: Type.Optional(Type.String()), message: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
          mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")])),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const source = { runtime: "pi" as const, sessionId: ctx.sessionManager.getSessionId() };
          let approvalId: string | undefined;
          if (params.action === "send") {
            const approval = await preparePeerSend(source, params);
            if (!await ctx.ui.confirm(approval.title, approval.message, { signal: _signal, timeout: 5 * 60_000 })) throw new Error("用户取消，未发送协作任务");
            await approvePeerSend(source, approval.approvalId);
            approvalId = approval.approvalId;
          }
          const result = await requestPeer(source, { ...params, approvalId });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
        },
      });
    },
  };
}
