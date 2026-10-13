import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "./types.ts";

/** The path comes only from the package's owned-run transcript header, never a browser parameter. */
export function transcriptSessionPath(text: string): string | undefined {
  const header = text.split("\n\n")[0];
  return header.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Session: "))?.slice(9).trim();
}

export function readPackageChat(file: string, sessionsRoot: string, parentSessionFile?: string) {
  const roots = [realpathSync(sessionsRoot)];
  if (parentSessionFile) {
    // The trusted parent is resolved by Web, never supplied by the browser.
    // Project session folders may themselves be links. Only this parent's
    // child tree is added, not every target of every link under sessions/.
    const parent = realpathSync(parentSessionFile);
    if (!parent.endsWith(".jsonl")) throw new Error("Invalid parent session file");
    roots.push(join(dirname(parent), basename(parent, ".jsonl")));
  }
  const path = realpathSync(file);
  const allowed = roots.some((root) => {
    const child = relative(root, path);
    return child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
  });
  if (!allowed || !path.endsWith(".jsonl")) {
    throw new Error("子代理记录不在允许的会话目录中");
  }
  const fd = openSync(resolve(path), constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("子代理记录不是普通文件");
    const start = Math.max(0, stat.size - 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const messages: AgentMessage[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !["user", "assistant", "toolResult", "bashExecution"].includes(entry.message?.role)) continue;
        messages.push(entry.message);
      } catch { /* torn append or incomplete first line: retry on next refresh */ }
    }
    return { messages: messages.slice(-100), truncated: start > 0 || messages.length > 100 };
  } finally { closeSync(fd); }
}
