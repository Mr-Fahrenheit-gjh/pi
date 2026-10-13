import { NextResponse } from "next/server";
import { readGhosttyFontPreferences } from "@/lib/ghostty-font-config-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readGhosttyFontPreferences(), { headers: { "Cache-Control": "no-store" } });
}
