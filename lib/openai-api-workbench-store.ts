import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getModelsConfigPath, readModelsConfigSnapshot } from "./models-config-store";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";
import { applyWorkbenchPatch, record, WorkbenchError, type WorkbenchSourceModel } from "./openai-api-workbench";

export function readWorkbenchConfig(path = getModelsConfigPath()) {
  try {
    const snapshot = readModelsConfigSnapshot(path);
    const config = snapshot.config;
    for (const value of [config.providers, record(config.providers).openai, record(record(config.providers).openai).modelOverrides]) {
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error();
    }
    return snapshot;
  } catch { throw new WorkbenchError("invalid-config",409); }
}

/** Synchronous compare-and-write: no asynchronous gap within this process. */
export function saveWorkbenchConfig(request: unknown, model: WorkbenchSourceModel, path = getModelsConfigPath()) {
  const req = record(request);
  const before = readWorkbenchConfig(path);
  if (typeof req.expectedRevision !== "string" || req.expectedRevision !== before.revision) throw new WorkbenchError("stale-config",409);
  const config = applyWorkbenchPatch(before.config,model,req);
  const content = JSON.stringify(config,null,2) + "\n";
  mkdirSync(dirname(path),{recursive:true});
  writePrivateFileAtomicSync(path,content);
  invalidateModelsCache();
  return {revision:createHash("sha256").update(content).digest("hex")};
}
