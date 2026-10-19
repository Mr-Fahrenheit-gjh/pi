import type { Locale } from "./types";

export const UI_LOCALE_STORAGE_KEY = "pi-locale";
export const UI_LOCALE_MIGRATION_KEY = "pi-ui-language-version";
export const UI_LOCALE_VERSION = "english-interface-v1";

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

/** Apply the requested English interface once; preserve later explicit choices. */
export function readUiLocale(storage: LocaleStorage): Locale {
  try {
    if (storage.getItem(UI_LOCALE_MIGRATION_KEY) !== UI_LOCALE_VERSION) {
      storage.setItem(UI_LOCALE_STORAGE_KEY, "en");
      storage.setItem(UI_LOCALE_MIGRATION_KEY, UI_LOCALE_VERSION);
      return "en";
    }
    const stored = storage.getItem(UI_LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN" || stored === "zh-TW") return stored;
  } catch {
    // Privacy/storage restrictions must not revert the requested English UI.
  }
  return "en";
}
