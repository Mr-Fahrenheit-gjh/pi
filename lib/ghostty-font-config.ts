import { fontFamilyCss } from "./font-preferences";

export interface GhosttyFontPreferences {
  fontFamily: string;
  fontSize: number;
  source: "ghostty" | "default";
}
export const DEFAULT_GHOSTTY_FONT: GhosttyFontPreferences = {
  fontFamily: '"JetBrainsMono Nerd Font", "Maple Mono NF", "MesloLGS NF", monospace',
  fontSize: 14,
  source: "default",
};

/** Only project font names/size; never expose commands, environment or other config. */
export function parseGhosttyFontConfig(config: string): GhosttyFontPreferences {
  const families: string[] = [];
  let fontSize = DEFAULT_GHOSTTY_FONT.fontSize;
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*(font-family|font-size)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (match[1] === "font-family") {
      if (!value) families.length = 0;
      else if (families.length < 8 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)) families.push(value);
    } else if (value && Number.isFinite(Number(value))) {
      fontSize = Math.min(72, Math.max(8, Number(value)));
    }
  }
  const css = fontFamilyCss(families.join(", "));
  return { fontFamily: css ? `${css}, ${DEFAULT_GHOSTTY_FONT.fontFamily}` : DEFAULT_GHOSTTY_FONT.fontFamily, fontSize, source: "ghostty" };
}
