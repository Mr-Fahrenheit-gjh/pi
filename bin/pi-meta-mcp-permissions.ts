import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep GitHub deletion and merge behind interactive approval, including children. */
export function requiresGithubApproval(name: string): boolean {
  return /^mcp__github__(?:delete_|merge_)/.test(name) || /^github_(?:delete_|merge_)/.test(name);
}

export default function piMetaMcpPermissions(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!requiresGithubApproval(event.toolName)) return;
    if (!ctx.hasUI || !await ctx.ui.confirm("确认 GitHub 高风险操作", event.toolName)) {
      return { block: true, reason: "GitHub delete/merge requires explicit interactive approval." };
    }
  });
}
