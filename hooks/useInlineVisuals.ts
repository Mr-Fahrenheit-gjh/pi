"use client";

import { useSyncExternalStore } from "react";
import { getInlineVisualsEnabled, INLINE_VISUAL_DEFAULT, subscribeInlineVisuals } from "@/lib/inline-visual-preference";

export function useInlineVisuals(): boolean {
  return useSyncExternalStore(subscribeInlineVisuals, getInlineVisualsEnabled, () => INLINE_VISUAL_DEFAULT);
}
