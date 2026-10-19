import { enLocale } from "./messages/en.ts";
import { interpolateMessage } from "./format.ts";

/** Default copy for client-safe helpers called outside an I18nProvider. */
export function englishText(key, params) {
  return interpolateMessage(enLocale.messages[key] ?? key, params);
}
