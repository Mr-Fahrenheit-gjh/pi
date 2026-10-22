import { normalizeFilePathSlashes } from "./file-paths";
import { resolveLocalFileHref } from "./file-links";
import { normalizeToolCalls } from "./normalize";
import type { AgentMessage } from "./types";

export const MAX_TASK_OUTPUTS = 500;

/** File-index results stay inside the current project. This is not an access grant. */
export function outputPathForCwd(input: unknown, cwd: string): string | null {
  if (typeof input !== "string" || !cwd || input.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(input)) return null;
  const root = cwd.replace(/\/+$/, "");
  const path = input.startsWith(`${root}/`) ? input.slice(root.length + 1) : input;
  if (!path || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const parts = path.split("/");
  if (parts.includes("..")) return null;
  const clean = parts.filter(part => part && part !== ".").join("/");
  return clean || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Tool paths are literal filenames, not URLs: preserve spaces, %, # and ?. */
export function taskOutputPath(value: unknown, cwd: string): string | null {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const path = normalizeFilePathSlashes(value);
  if (path.endsWith("/") || path.split("/").includes("..")) return null;
  const absolute = path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
  if (!absolute && /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const joined = absolute ? path : `${normalizeFilePathSlashes(cwd).replace(/\/+$/, "")}/${path}`;
  const prefix = joined.startsWith("//") ? "//" : joined.startsWith("/") ? "/" : "";
  const parts = joined.split("/").filter(part => part && part !== ".");
  return parts.length ? prefix + parts.join("/") : null;
}

function writePath(name: unknown, args: unknown, cwd: string): string | null {
  if (name !== "write" && name !== "edit" && name !== "functions.write" && name !== "functions.edit") return null;
  const input = record(args);
  return taskOutputPath(input?.path ?? input?.file_path, cwd);
}

/** Explicit assistant delivery links also cover reports/images created by shell commands. */
function linkedFiles(text: string, cwd: string): string[] {
  const prose = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
  const files: string[] = [];
  // Markdown destinations, including angle-wrapped spaces and one level of balanced parentheses.
  const links = /\[[^\]\n]*\]\((?:<([^>\n]+)>|((?:\\.|[^\\()\n]|\([^()\n]*\))*))\)/g;
  for (const match of prose.matchAll(links)) {
    const href = (match[1] ?? match[2]).trim().replace(/\s+["'][^"']*["']\s*$/, "").replace(/\\([() ])/g, "$1");
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch { /* The resolver also accepts literal percent filenames. */ }
    if (/[\u0000-\u001f\u007f]/.test(decoded) || normalizeFilePathSlashes(decoded).split("/").includes("..")) continue;
    const path = resolveLocalFileHref(href, cwd);
    if (path) files.push(path);
  }
  return files;
}

/** Read one session branch, including pre-compaction history. Never scan a project or run a tool. */
export function collectTaskOutputs(entries: readonly unknown[], cwd: string): { paths: string[]; truncated: boolean } {
  const paths = new Map<string, true>();
  const calls = new Map<string, { name: string; input: unknown }>();
  const add = (path: string | null) => {
    if (!path) return;
    paths.delete(path);
    paths.set(path, true);
  };
  for (const value of entries) {
    const entry = record(value);
    if (entry?.type !== "message") continue;
    const raw = record(entry.message);
    if (!raw) continue;
    if (raw.role === "assistant") {
      const message = normalizeToolCalls(raw as unknown as AgentMessage);
      if (message.role !== "assistant") continue;
      const blocks = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : [];
      for (const block of blocks) {
        if (block.type === "toolCall" && block.toolCallId) calls.set(block.toolCallId, { name: block.toolName, input: block.input });
        if (block.type === "text") for (const path of linkedFiles(block.text, cwd)) add(path);
      }
    } else if (raw.role === "toolResult") {
      const call = typeof raw.toolCallId === "string" ? calls.get(raw.toolCallId) : undefined;
      if (call && raw.isError !== true && (!raw.toolName || raw.toolName === call.name)) add(writePath(call.name, call.input, cwd));
      if (typeof raw.toolCallId === "string") calls.delete(raw.toolCallId);
      // The SDK keeps full arguments and a per-call outcome separately from the parent result.
      const nested = record(raw.nestedCalls);
      if (Array.isArray(nested?.calls)) {
        for (const value of nested.calls) {
          const item = record(value);
          if (item?.status === "ok") add(writePath(item.name, item.arguments, cwd));
        }
      } else if (raw.toolName === "codemode") {
        // Older records only have bounded display args. Invalid/truncated JSON is not evidence.
        const details = record(raw.details);
        if (Array.isArray(details?.calls)) for (const value of details.calls) {
          const item = record(value);
          if (item?.status !== "ok" || typeof item.args !== "string") continue;
          try { add(writePath(item.name, JSON.parse(item.args), cwd)); } catch { /* Skip incomplete args. */ }
        }
      }
    }
  }
  const all = [...paths.keys()];
  return { paths: all.slice(-MAX_TASK_OUTPUTS).reverse(), truncated: all.length > MAX_TASK_OUTPUTS };
}
