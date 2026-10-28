import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handlePiMetaControl } from "@/lib/pi-meta-control.mjs";
import { restartBlockers } from "@/lib/service-restart";
import { serviceRestartState } from "@/lib/service-restart-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const expected = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-web:meta-control-token/v1")];
  const supplied = request.headers.get("x-pi-meta-control");
  if (process.env.PI_META_PROCESS !== "1" || typeof expected !== "string" || !supplied ||
      Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: { action?: unknown; leaseId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid request" }, { status: 400 }); }
  if (body.action === "identity") {
    return NextResponse.json({ ok: true, pid: process.pid, agentDir: process.env.PI_CODING_AGENT_DIR }, { headers: { "Cache-Control": "no-store" } });
  }
  const state = serviceRestartState();
  const blockers = restartBlockers();
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : undefined;
  if (body.action === "shutdown") {
    const shutdown = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-web:meta-shutdown/v1")];
    if (typeof shutdown !== "function") {
      return NextResponse.json({ ok: false, reason: "unavailable" }, { headers: { "Cache-Control": "no-store" } });
    }
    const commit = handlePiMetaControl(state, "commit", blockers, leaseId);
    if (!commit.ok) return NextResponse.json(commit, { headers: { "Cache-Control": "no-store" } });
    const timer = setTimeout(() => { (shutdown as () => void)(); }, 50);
    timer.unref();
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const result = handlePiMetaControl(state, typeof body.action === "string" ? body.action : "", blockers, leaseId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
