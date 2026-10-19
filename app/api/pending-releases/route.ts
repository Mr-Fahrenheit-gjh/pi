import { NextResponse } from "next/server";
import { readReleaseSnapshot } from "@/lib/pending-release-store.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read-only: no request-controlled paths and no access to referenced session/code files.
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json(await readReleaseSnapshot(), { headers });
  } catch {
    return NextResponse.json(
      { error: "The pending release list is unavailable. Check the shared directory, permissions, or capacity." },
      { status: 503, headers },
    );
  }
}
