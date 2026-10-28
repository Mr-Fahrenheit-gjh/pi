import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Adapter behavior boundary; exact upstream/host pins live in compat.ts.
 * Only the agent_browser public input/prompt surface changes. The original factory,
 * executor, renderers, hooks, config/trust/credential resolution and cleanup survive.
 * Never filter execute(), tool_call or tool_result safety logic. Upstream upgrades
 * require a new schema/guideline audit and offline host tests before changing pins.
 */
export const BASIC_KEYS = ["args", "stdin", "outputPath", "timeoutMs", "sessionMode"] as const;
const MODE_RULE = "Use agent_browser with one input mode: script, args, semanticAction, job, qa, sourceLookup/networkSourceLookup, or electron. stdin: batch/eval/auth/wrapper batch only; electron rejects it; never pass --json.";
const BASIC_RULE = "agent_browser basic accepts args, stdin, outputPath, timeoutMs, sessionMode. Use raw args for reading and writing pages; stdin only for batch, eval --stdin or auth save --password-stdin; never pass --json. Ask the user to run /browser-mode full for advanced top-level inputs, then retry unchanged; never bypass permissions via bash.";
const ROUTE_RULE = "For public webpage introductions and fact lookup, prefer the existing brave-search skill. For a known public URL, prefer that skill's content command; agent_browser read <url> is an alternative. Stop when the text is sufficient. Use agent_browser open only when browser rendering or DOM inspection is needed.";
const OLD_ROUTE = "For agent_browser, use open → snapshot -i → @refs; re-snapshot after changes.";
const OLD_ARGS_ROUTE = "Start with open → snapshot -i → act on current @refs; re-snapshot after page changes.";
const INTERACTION_RULE = "For agent_browser click/fill interactions, use snapshot -i and current @refs; re-snapshot after page changes.";
const ROUTE_PREFIXES = ["Use agent_browser for real browser or live web content.", "Prefer agent_browser_web_search for facts; agent_browser for pages."];
function replaceExact(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error("Upstream browser prompt changed; re-audit adapter.");
  return text.replace(from, to);
}
const RECOVERY = "agent_browser basic supports only args, stdin, outputPath, timeoutMs, sessionMode. Run /browser-mode full, then retry the original input (or use ordinary args). No browser action was executed.";

function checkBasicInput(input: unknown): void {
  if (input && typeof input === "object" && Object.keys(input).some(key => !(BASIC_KEYS as readonly string[]).includes(key))) {
    // Do not echo unknown names or values: they may contain credentials.
    throw new Error(RECOVERY);
  }
}

export async function installAdapter(pi: ExtensionAPI, upstream: ExtensionFactory): Promise<void> {
  let original: ToolDefinition | undefined;
  let basic: ToolDefinition | undefined;
  let full: ToolDefinition | undefined;
  let mode: "basic" | "full" = "basic";
  const proxy = new Proxy(pi, {
    get(target, key, receiver) {
      if (key !== "registerTool") return Reflect.get(target, key, receiver);
      return (tool: ToolDefinition) => {
        if (tool.name !== "agent_browser") return target.registerTool(tool);
        if (original) throw new Error("Unsupported upstream agent_browser re-registration; re-audit adapter.");
        const schema = tool.parameters as unknown as { properties: Record<string, unknown> };
        if (!schema.properties || BASIC_KEYS.some(key => !schema.properties[key]) || !tool.promptGuidelines?.includes(MODE_RULE)) {
          throw new Error("Upstream browser contract changed; adapter refused to load. Use original package.");
        }
        original = tool;
        const argsSchema = schema.properties.args as { description: string };
        const args = { ...argsSchema, description: replaceExact(argsSchema.description, OLD_ARGS_ROUTE, INTERACTION_RULE) };
        if (tool.promptGuidelines.filter(line => ROUTE_PREFIXES.includes(line)).length !== 1 ||
            tool.promptGuidelines.filter(line => line.includes(OLD_ROUTE)).length !== 1) {
          throw new Error("Upstream browser routing changed; re-audit adapter.");
        }
        // Copy only prompt surfaces; never mutate the captured upstream object.
        // Preserve the authorization sentences after OLD_ROUTE on the same line.
        full = {
          ...tool,
          description: replaceExact(tool.description, "default `args` for open → snapshot -i → click/fill @refs", "`args` for lightweight read <url>, or browser rendering/DOM and click/fill interactions"),
          parameters: { ...tool.parameters, properties: { ...schema.properties, args } } as ToolDefinition["parameters"],
          promptGuidelines: tool.promptGuidelines.map(line => ROUTE_PREFIXES.includes(line) ? ROUTE_RULE : line.includes(OLD_ROUTE) ? replaceExact(line, OLD_ROUTE, INTERACTION_RULE) : line),
        };
        basic = {
          ...full,
          description: "Browse, read and write web pages using agent-browser: open, snapshot, click, fill, get, eval, batch, screenshots. Basic inputs only; /browser-mode full restores advanced input modes.",
          parameters: {
            type: "object",
            properties: Object.fromEntries(BASIC_KEYS.map(key => [key, key === "args" ? args : schema.properties[key]])),
            required: ["args"],
            additionalProperties: false,
          } as ToolDefinition["parameters"],
          // Mode chooser differs; read-only/interaction routing is shared with full.
          promptGuidelines: full.promptGuidelines!.map(line => line === MODE_RULE ? BASIC_RULE : line),
          prepareArguments(input) {
            checkBasicInput(input);
            return tool.prepareArguments ? tool.prepareArguments(input) : input;
          },
          execute(id, input, signal, update, ctx) {
            checkBasicInput(input); // also protect direct callers and post-validation hooks
            return tool.execute(id, input, signal, update, ctx);
          },
        };
        target.registerTool(basic);
      };
    },
  });
  await upstream(proxy);
  if (!original || !basic) throw new Error("Upstream did not register agent_browser.");
  pi.registerCommand("browser-mode", {
    description: "Switch browser schema: /browser-mode basic|full (does not grant tool access)",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested !== "basic" && requested !== "full") {
        ctx.ui.notify(`Browser mode: ${mode}. Usage: /browser-mode basic|full`, "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Browser mode unchanged: wait for the current run to finish, then retry.", "warning");
        return;
      }
      if (requested !== mode) {
        const active = pi.getActiveTools();
        pi.registerTool(requested === "full" ? full! : basic!);
        // Host refresh can re-enable manually disabled allowlisted tools. Restore
        // the exact previous set, never add browser or any companion/tool name.
        if (JSON.stringify(pi.getActiveTools()) !== JSON.stringify(active)) pi.setActiveTools(active);
        mode = requested;
      }
      ctx.ui.notify(`Browser mode: ${mode}; tool access unchanged.`, "info");
    },
  });
}
