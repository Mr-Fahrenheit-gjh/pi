export const LSP_TOOL_NAMES = new Set([
    'lsp_diagnostics_many',
    'lsp_find_symbol',
    'lsp_hover',
    'lsp_definition',
    'lsp_references',
    'lsp_document_symbols',
]);
export const LSP_SYSTEM_PROMPT = `

## Language server support via LSP tools

Use active LSP tools for precise types, definitions, references and symbols; text search for broad discovery.
Before completion or commit, validate changed supported files with lsp_diagnostics_many (also for one file). If diagnostics are unavailable, disclose that limitation and use applicable static checks. execution_ok/legacy ok mean tool success only; inspect diagnostic_error_count, warning_count and code_clean before claiming clean code. LSP is scoped to returned diagnostics, not a substitute for project tests.`;
export function should_inject_lsp_prompt(event) {
    const selected_tools = event.systemPromptOptions?.selectedTools;
    return (!selected_tools ||
        selected_tools.some((tool) => LSP_TOOL_NAMES.has(tool)));
}
export function append_lsp_system_prompt(system_prompt) {
    return system_prompt.includes(LSP_SYSTEM_PROMPT.trim()) ? system_prompt : system_prompt + LSP_SYSTEM_PROMPT;
}
