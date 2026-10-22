/** Only explicit, workspace-relative file references; never infer paths from tool text. */
export const MAX_TASK_OUTPUTS = 32;

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

export function parseTaskOutputs(raw: string | null, cwd: string): string[] {
  if (!raw || raw.length > 100000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(path => outputPathForCwd(path, cwd)).filter((path): path is string => path !== null))].slice(0, MAX_TASK_OUTPUTS);
  } catch { return []; }
}

export function taskOutputKey(sessionId: string, cwd: string): string {
  return `pi-task-outputs:${JSON.stringify([sessionId, cwd])}`;
}
