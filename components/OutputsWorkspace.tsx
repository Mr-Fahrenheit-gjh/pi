"use client";

import { useI18n } from "@/hooks/useI18n";
import { useTaskOutputs } from "@/hooks/useTaskOutputs";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { MAX_TASK_OUTPUTS } from "@/lib/task-outputs";
import { sortOutputPaths } from "@/lib/output-order";

export function OutputsWorkspace({ sessionId, cwd, leafId, refreshKey, onOpen }: {
  sessionId: string; cwd: string; leafId: string | null; refreshKey: number; onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const { paths, loading, failed, truncated, refresh } = useTaskOutputs(sessionId, cwd, leafId, refreshKey);
  return <section className="outputs-workspace" aria-label={t("outputs.title")} aria-busy={loading}>
    <header><div><h2>{t("outputs.title")}</h2><p>{t("outputs.description")}</p></div>
      <button type="button" className="quiet-action-button" onClick={refresh} disabled={loading} aria-label={t("outputs.refresh")} title={t("outputs.refresh")}>↻</button>
    </header>
    {failed && <p role="alert" className="outputs-note">{t("outputs.failed")} <button type="button" onClick={refresh}>{t("outputs.retry")}</button></p>}
    {loading && !paths.length && <p role="status" className="outputs-empty">{t("outputs.loading")}</p>}
    {!loading && !failed && !paths.length && <p className="outputs-empty">{t("outputs.empty")}</p>}
    {truncated && <p className="outputs-note">{t("outputs.limit", { count: MAX_TASK_OUTPUTS })}</p>}
    <ul>{sortOutputPaths(paths).map(path => <li key={path}>
      <button type="button" className="output-file" onClick={() => onOpen(path)} title={path}>
        <svg aria-hidden="true" width="18" height="20" viewBox="0 0 18 20" fill="none"><path d="M3 1.5h7l5 5v12H3zM10 1.5v5h5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>
        <span><strong>{getFileName(path)}</strong><span>{getRelativeFilePath(path, cwd)}</span></span>
      </button>
    </li>)}</ul>
  </section>;
}
