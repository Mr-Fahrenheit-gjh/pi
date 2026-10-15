export interface SessionTodo {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function snapshot(value: unknown): SessionTodo[] | null {
  const data = object(value);
  if (!Array.isArray(data.tasks) || typeof data.nextId !== "number") return null;
  return data.tasks.flatMap((value) => {
    const task = object(value);
    if (!Number.isSafeInteger(task.id) || typeof task.subject !== "string" || !["pending", "in_progress", "completed"].includes(String(task.status))) return [];
    return [{ id: task.id as number, subject: task.subject, status: task.status as SessionTodo["status"],
      ...(typeof task.description === "string" ? { description: task.description } : {}),
      ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
    }];
  });
}
/** rpiv-todo's persisted current-branch contract: custom snapshots outrank legacy tool results. */
export function readSessionTodos(branch: Iterable<unknown>): SessionTodo[] {
  let custom: SessionTodo[] | null = null;
  let legacy: SessionTodo[] | null = null;
  for (const value of branch) {
    const entry = object(value);
    if (entry.type === "custom" && entry.customType === "rpiv-todo-state") custom = snapshot(entry.data) ?? custom;
    if (entry.type === "message") {
      const message = object(entry.message);
      if (message.role === "toolResult" && message.toolName === "todo") legacy = snapshot(message.details) ?? legacy;
    }
  }
  return custom ?? legacy ?? [];
}
