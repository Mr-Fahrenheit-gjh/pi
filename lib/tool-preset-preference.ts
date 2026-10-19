import { runtimeStorageKey } from "./runtime-client.mjs";
import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";
const DEFAULT_TOOL_PRESET: ToolPreset = "full";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Only an explicit pick from the tool dropdown is ever stored, so a missing value
 * means "never chose". Fresh sessions default to all built-in tools locally;
 * explicit choices (including configured) and existing sessions are unchanged.
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return DEFAULT_TOOL_PRESET;
  try {
    const value = storage.getItem(runtimeStorageKey(STORAGE_KEY));
    return isToolPreset(value) ? value : DEFAULT_TOOL_PRESET;
  } catch {
    return DEFAULT_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(runtimeStorageKey(STORAGE_KEY), preset);
  } catch {
    // Browser storage is best-effort.
  }
}
