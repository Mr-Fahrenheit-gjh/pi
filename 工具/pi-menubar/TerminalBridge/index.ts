import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startTerminalBridge } from "./terminal-bridge.mjs";

// A terminal session owns its bridge. RPC/Web sessions already have their own transport.
export default function (pi: ExtensionAPI) {
  let bridge: Awaited<ReturnType<typeof startTerminalBridge>> | undefined;
  pi.events.on("rpiv:ask-user:prompt", (event) => bridge?.prompt(event));
  pi.events.on("rpiv:ask-user:blocked", (event) => bridge?.blocked(event));
  pi.events.on("rpiv:ask-user:answer-result", (event) => bridge?.verdict(event));

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      bridge = await startTerminalBridge(pi, ctx);
    } catch {
      ctx.ui.notify("Pi 菜单栏终端桥接不可用；请在终端处理问答", "warning");
    }
  });
  pi.on("session_shutdown", async () => {
    const previous = bridge;
    bridge = undefined;
    await previous?.close();
  });
}
