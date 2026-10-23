import type { Agent } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface InlineVisualPreference { enabled?: boolean; activeUserRun?: boolean }

const ENABLED = [
  "Pi Web inline diagrams are enabled, but optional. Use one only when it materially clarifies the answer (e.g. a function, geometry, or a parameter relationship); otherwise use ordinary prose.",
  "Speed and order: stream a useful short explanation FIRST, then a compact diagram at its intended position, then continue the explanation. Close each diagram fence promptly; do not wait for the whole answer. Never move diagrams to the end or reorder prose to finish diagrams. Do not call image-generation tools or write HTML/files solely to display these diagrams.",
  "Use a fenced pi-visual block containing JSON, not HTML/JS/SVG source. The built-in renderer draws SVG and computes interactions locally. Keep it small (usually <1500 characters; hard limit 6000), normally one diagram, at most two. Check formulas, units and key points before giving the data.",
  'Example: {"version":1,"title":"Tangent","x":[-3,3],"y":[-1,5],"parameters":[{"name":"a","min":-1.8,"max":1.8,"value":1,"step":0.01}],"curves":[{"expr":"x^2","label":"y=x²"},{"expr":"2*a*x-a^2","label":"tangent"}],"shapes":[{"type":"point","at":["a","a^2"],"drag":"a","label":"P"}],"readouts":[{"label":"slope","expr":"2*a"}]}',
  "version/title/x/y are required; x and y are axis [min,max]. Other arrays are optional: up to 4 parameters, 4 curves, 24 shapes, 6 readouts. Positions are [xExpr,yExpr]. Shapes: point(at, optional drag: parameter name equal to its xExpr); segment(from,to, optional arrow:true); circle(center,radius); polygon(points). Curves/shapes may have label and color (blue/orange/green/purple/red).",
  "Expressions are numbers or strings: explicit + - * / ^, parentheses, pi/e, sin cos tan asin acos atan sqrt abs exp log log10 floor ceil (one argument). x exists only in curves; parameter names elsewhere. ^ means exponentiation, log means natural log, angles are radians. No implicit multiplication, comparisons, code, URLs or external resources. Equal coordinate units are preserved. Use text instead of inventing an unsupported diagram.",
].join("\n");
const DISABLED = "Pi Web inline diagrams are switched off for this request. Do not emit pi-visual blocks or automatically create replacement image/HTML files. Answer in normal text and math.";

export function inlineVisualInstructions(enabled: boolean): string {
  return `<pi_web_inline_visuals>\n${enabled ? ENABLED : DISABLED}\n</pi_web_inline_visuals>`;
}
export function updateInlineVisualPreference(preference: InlineVisualPreference | undefined, type: string, enabled: unknown): void {
  if (preference && ["prompt", "steer", "follow_up"].includes(type) && typeof enabled === "boolean") preference.enabled = enabled;
}
export function createInlineVisualExtension(preference: InlineVisualPreference): InlineExtension {
  return {
    name: "pi-web-inline-visuals",
    hidden: true,
    factory: pi => {
      pi.on("before_agent_start", event => { preference.activeUserRun = event.messageType === "user"; });
      // A user can also queue input into a run that began with a custom message.
      pi.on("input", () => { preference.activeUserRun = true; });
    },
  };
}

/** Install after AgentSession's own transform, including Chat-only forced-prompt projection. */
export function bindInlineVisualPrompt(agent: Pick<Agent, "transformContext">, preference: InlineVisualPreference): void {
  const previous = agent.transformContext?.bind(agent);
  agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous(messages, signal) : messages;
    if (!preference.activeUserRun || preference.enabled === undefined) return transformed;
    // Queue continuations don't fire before_agent_start again. Read the latest
    // submitted preference per provider request without changing saved messages.
    const sections = { "pi-web-inline-visuals": inlineVisualInstructions(preference.enabled) };
    const [first, ...rest] = transformed;
    return first?.role === "system"
      ? [{ ...first, sections: { ...first.sections, ...sections } }, ...rest]
      : [{ role: "system", content: "", sections, timestamp: 0 }, ...transformed];
  };
}
