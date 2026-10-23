import { randomUUID } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { designDeckUrl, type DesignDeckPresentation } from "./design-deck";
import { getBrowserManager } from "./browser-manager";

const REGISTRY = Symbol.for("pi-web:design-decks/v1");
function registry(): Map<string, DesignDeckPresentation> {
  const root = globalThis as unknown as Record<symbol, unknown>;
  return (root[REGISTRY] ??= new Map<string, DesignDeckPresentation>()) as Map<string, DesignDeckPresentation>;
}

export function getDesignDecks(): DesignDeckPresentation[] {
  return [...registry().values()];
}

export function getDesignDeck(id: string): DesignDeckPresentation | undefined {
  return getDesignDecks().find(deck => deck.id === id);
}

/** Opt in on this session's event bus; CLI hosts keep the package's normal presenter. */
export function createDesignDeckExtension(): InlineExtension {
  return {
    name: "pi-web-design-deck", hidden: true,
    factory(api) {
      let sessionId: string | undefined;
      let owned: DesignDeckPresentation | undefined;
      const clear = () => {
        if (owned) {
          if (registry().get(owned.sessionId) === owned) registry().delete(owned.sessionId);
          void getBrowserManager().close(owned.id.replace(/-/g, "")).catch(() => {});
        }
        owned = undefined;
      };
      api.on("session_start", (_event, ctx) => {
        clear();
        sessionId = ctx.sessionManager.getSessionId();
      });
      api.events.on("design-deck:present", (value: unknown) => {
        if (!sessionId || !value || typeof value !== "object") return;
        const request = value as { url?: unknown; title?: unknown; handled?: boolean };
        const url = designDeckUrl(request.url);
        if (!url) return;
        clear();
        owned = {
          id: randomUUID(), sessionId, url,
          title: typeof request.title === "string" ? request.title.slice(0, 200) : "Design Deck",
        };
        registry().set(sessionId, owned);
        // The event bus invokes this handler synchronously, before the package chooses a presenter.
        request.handled = true;
      });
      api.events.on("design-deck:closed", (value: unknown) => {
        if (value && typeof value === "object" && owned
          && designDeckUrl((value as { url?: unknown }).url) === owned.url) clear();
      });
      api.on("session_shutdown", () => { clear(); sessionId = undefined; });
    },
  };
}
