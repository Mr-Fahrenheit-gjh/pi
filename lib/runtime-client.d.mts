export type AgentRuntime = "pi" | "feynman";
export function pageRuntime(pathname?: string): AgentRuntime;
export function runtimeStorageKey(key: string, runtime?: AgentRuntime): string;
export function runtimeApi(path: string, runtime?: AgentRuntime): string;
export const runtimeFetch: typeof globalThis.fetch;
export function runtimePage(runtime: AgentRuntime): string;
