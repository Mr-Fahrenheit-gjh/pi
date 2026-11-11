/** Presentation only: callers must still submit the untouched RPC option string. */
export function presentQuestionOption(option: string, index: number): {
  number: string | null;
  label: string;
  description: string | null;
  recommendation: string | null;
} {
  const plain = { number: null, label: option, description: null, recommendation: null };
  // The questionnaire's RPC fallback emits "1. Label — Description". Do not
  // reinterpret arbitrary Markdown, code, multiline labels or unrelated numbering.
  const match = /^(\d+)\. ([^\r\n]+?)(?: — ([\s\S]*))?$/.exec(option);
  if (!match || Number(match[1]) !== index + 1 || /[\x60*_\[\]<>]/.test(match[2])) return plain;
  const recommended = /\s*[(（](Recommended|推荐|推薦)[)）]$/iu.exec(match[2]);
  return {
    number: match[1],
    label: recommended ? match[2].slice(0, recommended.index).trimEnd() : match[2],
    description: match[3] || null,
    recommendation: recommended?.[1] ?? null,
  };
}

export function presentQuestionTitle(title: string): {
  category: string | null;
  heading: string;
  detail: string | null;
} {
  const normalized = title.replace(/\r\n/g, "\n").trim();
  const divider = /\n[ \t]*\n/.exec(normalized);
  const heading = (divider ? normalized.slice(0, divider.index) : normalized).trim();
  const detail = divider ? normalized.slice(divider.index + divider[0].length).trim() : "";
  const category = /^\[([^\]\n]{1,32})\] ([\s\S]+)$/.exec(heading);
  return {
    category: category?.[1] ?? null,
    heading: category?.[2] ?? heading,
    detail: detail || null,
  };
}

export type QuestionnaireRequest = Extract<import("./types").ExtensionUiRequest, { method: "select" | "input" }>;
export interface QuestionnairePresentation {
  key: string;
  title: string;
  stem: string;
  options: string[];
  other: string | null;
}

const customPrompts = ["Type your answer:", "输入你的回答："];
const otherLabels = ["Type something.", "输入内容"];
function numberedOptions(options: string[]): boolean {
  return options.length >= 2 && options.length <= 4
    && options.every((option, index) => option.startsWith(`${index + 1}. `) && /^[^\r\n]+ — [\s\S]*$/.test(option));
}
function questionnaire(title: string, stem: string, options: string[], other: string | null): QuestionnairePresentation {
  return { key: JSON.stringify([stem, options]), title, stem, options, other };
}

/** Recognize the RPC questionnaire, not arbitrary input dialogs. Never submits data. */
export function getQuestionnaire(
  request: import("./types").ExtensionUiRequest | null,
  previous?: QuestionnairePresentation | null,
): QuestionnairePresentation | null {
  if (!request) return null;
  if (request.method === "select") {
    const options = request.options.slice(0, -1);
    const other = request.options.at(-1);
    if (!numberedOptions(options) || !otherLabels.some(label => other === `${options.length + 1}. ${label}`)) return null;
    let stem = request.title;
    for (const [index, option] of options.entries()) {
      const label = option.slice(option.indexOf(". ") + 2, option.indexOf(" — "));
      const preview = stem.indexOf(`\n\n--- ${index + 1}. ${label} preview ---\n`);
      if (preview >= 0) stem = stem.slice(0, preview);
    }
    return questionnaire(request.title, stem, options, other!);
  }
  if (request.method !== "input") return null;
  if (previous && customPrompts.some(prompt => request.title === `${previous.stem}\n\n${previous.options.join("\n")}\n\n${prompt}`)) return previous;
  const prompt = customPrompts.find(value => request.title.endsWith(`\n\n${value}`));
  if (!prompt) return null;
  const body = request.title.slice(0, -prompt.length - 2);
  const start = body.lastIndexOf("\n\n1. ");
  if (start < 1) return null;
  const options = body.slice(start + 2).split(/\n(?=\d+\. )/);
  if (!numberedOptions(options)) return null;
  const stem = body.slice(0, start);
  return questionnaire(stem, stem, options, null);
}
