import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { collectTaskOutputs } from "@/lib/task-outputs";

export const dynamic = "force-dynamic";

/** Read only, like todos: no agent creation, directory scan, model call or file access grant. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rpc = getRpcSession(id);
  const live = rpc?.isAlive() ? rpc : null;
  const file = live ? null : await resolveSessionPath(id);
  if (!live && !file) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  try {
    const manager = live?.inner.sessionManager ?? openSessionManager(file!);
    const leafId = new URL(request.url).searchParams.get("leafId") ?? undefined;
    const outputs = collectTaskOutputs(manager.getBranch(leafId), manager.getCwd());
    return NextResponse.json({ ...outputs, sessionId: id }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to read conversation files" }, { status: 500 });
  }
}
