import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { readSessionTodos } from "@/lib/session-todos";

export const dynamic = "force-dynamic";
/** Read only: never starts an agent or invokes the todo tool. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rpc = getRpcSession(id);
  const live = rpc?.isAlive() ? rpc : null;
  const file = live ? null : await resolveSessionPath(id);
  if (!live && !file) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  try {
    const manager = live?.inner.sessionManager ?? openSessionManager(file!);
    return NextResponse.json({ tasks: readSessionTodos(manager.getBranch()), sessionId: id }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to read session tasks" }, { status: 500 });
  }
}
