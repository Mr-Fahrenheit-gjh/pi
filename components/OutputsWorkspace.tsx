"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import { MAX_TASK_OUTPUTS, outputPathForCwd } from "@/lib/task-outputs";
import type { Tab } from "./TabBar";

export function OutputsWorkspace({ paths, cwd, openFiles, ready, persisted, onPin, onRemove, onOpen }: {
  paths: string[]; cwd: string; openFiles: Tab[]; ready: boolean; persisted: boolean;
  onPin: (path: string) => void; onRemove: (path: string) => void; onOpen: (path: string, diff?: boolean) => void;
}) {
  const { t } = useI18n();
  const [candidate, setCandidate] = useState("");
  const openPaths = [...new Set(openFiles.map(file => outputPathForCwd(file.filePath, cwd)).filter((path): path is string => path !== null))];
  const available = openPaths.filter(path => !paths.includes(path));
  const choice = available.includes(candidate) ? candidate : available[0] ?? "";
  return <section className="outputs-workspace" aria-label={t("outputs.title")}>
    <header><h2>{t("outputs.title")}</h2><p>{t("outputs.description")}</p></header>
    <div className="outputs-pin-row">
      <select aria-label={t("outputs.chooseFile")} value={choice} disabled={!ready || !available.length} onChange={event => setCandidate(event.target.value)}>
        {!available.length && <option value="">{t(openPaths.length ? "outputs.allPinned" : "outputs.openFileFirst")}</option>}
        {available.map(path => <option key={path} value={path}>{path}</option>)}
      </select>
      <button type="button" className="quiet-action-button" disabled={!ready || !choice || paths.length >= MAX_TASK_OUTPUTS} onClick={() => onPin(choice)}>{t("outputs.pin")}</button>
    </div>
    {!persisted && <p role="status" className="outputs-note">{t("outputs.tabOnly")}</p>}
    {paths.length >= MAX_TASK_OUTPUTS && <p className="outputs-note">{t("outputs.limit", { count: MAX_TASK_OUTPUTS })}</p>}
    {!paths.length && <p className="outputs-empty">{t("outputs.empty")}</p>}
    <ul>{paths.map(path => <li key={path}>
      <button type="button" className="output-file" onClick={() => onOpen(path)} title={path}><strong>{getFileName(path)}</strong><span>{path}</span></button>
      <button type="button" className="quiet-action-button" onClick={() => onOpen(path, true)} aria-label={t("outputs.diffFile", { path })}>{t("outputs.diff")}</button>
      <button type="button" className="quiet-action-button" onClick={() => onRemove(path)} aria-label={t("outputs.unpinFile", { path })} title={t("outputs.unpin")}>×</button>
    </li>)}</ul>
  </section>;
}
