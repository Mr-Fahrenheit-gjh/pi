"use client";

import { NativeBrowser } from "./NativeBrowser";
import type { DesignDeckPresentation } from "@/lib/design-deck";

const keepDeckLocation = () => {};

/** Keep mounted when hidden: changing tabs must not discard selections or cancel the tool. */
export function DesignDeckWorkspace({ deck, active }: { deck: DesignDeckPresentation; active: boolean }) {
  // The live presentation owns one page. Reloads/windows reconnect; none may delete it on unmount.
  const browserId = deck.id.replace(/-/g, "");
  return <section aria-label={deck.title || "Design Deck"} style={{ width: "100%", height: "100%" }}>
    <NativeBrowser
      url={deck.url}
      presentationId={deck.id}
      controlsId={`browser-controls-${browserId}`}
      active={active}
      collapsed
      onExpand={keepDeckLocation}
      onNavigate={keepDeckLocation}
    />
  </section>;
}
