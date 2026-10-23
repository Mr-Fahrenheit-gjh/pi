import { NextResponse } from "next/server";
import { getBrowserManager } from "@/lib/browser-manager";
import { getDesignDeck } from "@/lib/design-deck-bridge";
import { isBrowserId, parseBrowserCommand } from "@/lib/browser-protocol";
import { normalizePreviewUrl } from "@/lib/browser-preview";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const url = typeof b.url === "string" ? normalizePreviewUrl(b.url) : null;
    const size = parseBrowserCommand({ type: "resize", width: b.width ?? 1000, height: b.height ?? 800 });
    if (!isBrowserId(b.id) || !url || !size || size.type !== "resize") return NextResponse.json({ error: "Invalid browser page" }, { status: 400 });
    const deck = typeof b.designDeckId === "string" ? getDesignDeck(b.designDeckId) : undefined;
    if (b.designDeckId !== undefined && (!deck || deck.id.replace(/-/g, "") !== b.id || deck.url !== url)) {
      return NextResponse.json({ error: "Design deck is no longer available" }, { status: 410 });
    }
    const manager = getBrowserManager();
    const state = await manager.create(b.id, url, size.width, size.height);
    // A deck can finish while Chrome starts. Do not leave a late-created orphan behind.
    if (deck && getDesignDeck(deck.id) !== deck) {
      await manager.close(b.id);
      return NextResponse.json({ error: "Design deck is no longer available" }, { status: 410 });
    }
    return NextResponse.json({ engine: "chrome", state });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
