"use client";
import { runtimeFetch as fetch } from "@/lib/runtime-client.mjs";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionTodo } from "@/lib/session-todos";

export function TodoWorkspace({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<SessionTodo[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    const load = async () => {
      if (controller || document.visibilityState !== "visible") return;
      const request = new AbortController(); controller = request;
      const timeout = window.setTimeout(() => request.abort(), 5000);
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todos`, { signal: request.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const data = await response.json() as { tasks: SessionTodo[] };
        if (alive) { setTasks(data.tasks); setError(false); }
      } catch { if (alive) setError(true); }
      finally { window.clearTimeout(timeout); controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [sessionId]);
  const completed = tasks?.filter((task) => task.status === "completed").length ?? 0;
  const order = { in_progress: 0, pending: 1, completed: 2 };
  const sorted = [...(tasks ?? [])].sort((a, b) => order[a.status] - order[b.status] || a.id - b.id);
  return <section className="todo-workspace" aria-label={t("workspace.todos")}>
    <header><span>{t("workspace.todos")}</span>{tasks && tasks.length > 0 && <span>{completed} / {tasks.length}</span>}</header>
    {error && <p role="alert">{t("workspace.todosError")}</p>}
    {!error && !tasks && <p role="status">{t("chat.loadingSession")}</p>}
    {tasks?.length === 0 && !error && <p>{t("workspace.todosEmpty")}</p>}
    <ul>{sorted.map((task) => <li key={task.id} data-todo-status={task.status}>
      <span className="todo-status-mark" aria-label={t(`workspace.todoStatus.${task.status}`)}>{task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}</span>
      <div><div className="todo-subject">{task.subject}</div>
        {task.activeForm && task.status === "in_progress" && <div className="todo-active-form">{task.activeForm}</div>}
        {task.description && <details><summary>{t("workspace.todoDetails")}</summary><p>{task.description}</p></details>}
      </div>
    </li>)}</ul>
  </section>;
}
