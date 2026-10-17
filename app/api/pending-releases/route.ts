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
      { error: "待上线清单暂不可用，请检查共享目录、权限或容量。" },
      { status: 503, headers },
    );
  }
}
