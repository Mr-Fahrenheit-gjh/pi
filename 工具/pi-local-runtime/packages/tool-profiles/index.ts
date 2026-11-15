import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export const LSP_NAMES = [
  "lsp_diagnostics_many", "lsp_find_symbol", "lsp_hover",
  "lsp_definition", "lsp_references", "lsp_document_symbols",
] as const;
const lsp = new Set<string>(LSP_NAMES);
const direct = new Set(["chatgpt_computer_use", "credential_login"]);

// Compare the JSON-visible definition, not host allocation identity. SDK provenance
// objects are recreated when an unrelated extension re-registers its tool.
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Unsupported metadata");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(v => canonical(v, ancestors)).join(",")}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Unsupported metadata object");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter(k => record[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical(record[k], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function identity(tool: ToolInfo): string | undefined {
  const s = tool.sourceInfo;
  if (!s || !s.path || !s.source || !s.scope || !s.origin || !tool.parameters) return;
  try {
    return canonical({ sourceInfo: s, parameters: tool.parameters,
      description: tool.description, promptGuidelines: tool.promptGuidelines });
  } catch {
    // Missing/non-JSON/cyclic metadata cannot establish a restoration claim.
    return undefined;
  }
}

/** Explicit, session-local presentation only. Never infer agent identity. */
export default function toolProfiles(pi: ExtensionAPI) {
  const hidden = new Map<string, string>();
  let profile = "full";
  const choices = ["general", "coding", "full", "status"];
  pi.registerCommand("tool-profile", {
    description: "general: hide LSP/direct CU/HTTP; coding: restore LSP; full: restore profile-hidden tools; status: list",
    getArgumentCompletions(prefix) {
      return choices.filter(x => x.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const requested = args.trim() || "status";
      if (!choices.includes(requested)) {
        ctx.ui.notify("Usage: /tool-profile general|coding|full|status", "warning");
        return;
      }
      if (requested !== "status") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Tool profile unchanged: wait until idle.", "warning");
          return;
        }
        const active = pi.getActiveTools();
        const all = new Map(pi.getAllTools().map(t => [t.name, t]));
        const shouldHide = (name: string) => requested !== "full" &&
          (direct.has(name) || (requested === "general" && lsp.has(name)));
        // Forget obsolete restoration claims; never restore a same-name replacement.
        for (const [name, saved] of hidden) {
          const current = all.get(name);
          if (!current || identity(current) !== saved) {
            hidden.delete(name);
          }
        }
        const next = new Set(active);
        for (const name of active) {
          if (!shouldHide(name)) continue;
          const tool = all.get(name);
          const marker = tool && identity(tool);
          if (marker) hidden.set(name, marker);
          next.delete(name);
        }
        for (const name of hidden.keys()) {
          if (!shouldHide(name)) {
            next.add(name);
            hidden.delete(name);
          }
        }
        // Preserve unrelated external additions/removals, including browser/memory/Agent.
        pi.setActiveTools([...next]);
        profile = requested;
      }
      ctx.ui.notify(`Tool profile: ${profile} (session-local; explicit commands only)\nActive: ${pi.getActiveTools().join(", ")}\nProfile-hidden: ${[...hidden.keys()].join(", ") || "none"}`, "info");
    },
  });
}
