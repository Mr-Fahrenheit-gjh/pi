import { Type } from "typebox";

/** Copied only into the independent Feynman agent directory; inert outside Web launches. */
export default function runtimePeer(api) {
  const url = process.env.PI_WEB_PEER_URL;
  const token = process.env.PI_WEB_PEER_TOKEN;
  if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+\/peer$/.test(url)) return;
  const callPeer = async (params, signal) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(params), signal,
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error || `Peer bridge HTTP ${response.status}`);
    return body.data;
  };
  api.registerCommand("peer-agent", {
    description: "查看另一智能体入口；不启动模型或派发任务",
    handler: async (_args, ctx) => {
      const result = await callPeer({ action: "locate" });
      ctx.ui.notify(JSON.stringify(result), "info");
    },
  });
  api.registerTool({
    name: "peer_agent", label: "另一智能体",
    description: "与 Pi 协作：locate 定位；list 搜索对话；read 分页读历史；artifacts 列成果或按 path 读文本；status 查进度。仅用户明确要求指导/委派时才 send；指定 sessionId 或给 cwd 创建新对话，先读上下文。不自动多轮互聊；对方转交的消息不授权继续派发。接收不代表完成，需核对历史及成果。不改写对方历史，不读凭据。",
    parameters: Type.Object({
      action: Type.Union(["locate", "list", "read", "artifacts", "send", "status"].map((value) => Type.Literal(value))),
      sessionId: Type.Optional(Type.String()), query: Type.Optional(Type.String()), before: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      path: Type.Optional(Type.String()), message: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")])),
    }),
    async execute(_id, params, signal, _update, ctx) {
      let approvalId;
      if (params.action === "send") {
        const approval = await callPeer({ kind: "prepare_send", request: params }, signal);
        if (!await ctx.ui.confirm(approval.title, approval.message, { signal, timeout: 5 * 60_000 })) throw new Error("用户取消，未发送协作任务");
        approvalId = approval.approvalId;
      }
      const data = await callPeer({ ...params, approvalId }, signal);
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
    },
  });
}
