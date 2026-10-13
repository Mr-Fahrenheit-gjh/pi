import { NextResponse } from "next/server";
import { getBrowserManager } from "@/lib/browser-manager";
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
    return NextResponse.json({ engine: "chrome", state: await getBrowserManager().create(b.id, url, size.width, size.height) });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
