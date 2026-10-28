import { NextResponse } from "next/server";
import { acquireMetaDeploymentLease, cancelMetaDeploymentLease, commitMetaDeploymentLease, isLocalServiceRequest, ownsMetaDeploymentLease } from "@/lib/service-restart";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isLocalServiceRequest(request)) return NextResponse.json({ owns: false }, { status: 403, headers: noStore });
  const leaseId = new URL(request.url).searchParams.get("leaseId") ?? "";
  return NextResponse.json({ owns: ownsMetaDeploymentLease(leaseId) }, { headers: noStore });
}

/** The live response is the lease: disconnecting releases admission immediately. */
export async function POST(request: Request) {
  if (!isLocalServiceRequest(request, true)) return NextResponse.json({ reason: "local-only" }, { status: 403, headers: noStore });
  let body: { confirmed?: boolean; action?: string; leaseId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ reason: "confirmation-required" }, { status: 400, headers: noStore }); }
  if (body?.confirmed !== true) return NextResponse.json({ reason: "confirmation-required" }, { status: 400, headers: noStore });
  if (body.action === "commit" || body.action === "cancel") {
    const validId = typeof body.leaseId === "string" && /^[a-f0-9-]{36}$/.test(body.leaseId);
    const ok = validId && (body.action === "commit" ? commitMetaDeploymentLease(body.leaseId!) : cancelMetaDeploymentLease(body.leaseId!));
    return NextResponse.json({ ok }, { status: ok ? 200 : 409, headers: noStore });
  }
  if (body.action !== undefined && body.action !== "prepare") return NextResponse.json({ reason: "invalid-action" }, { status: 400, headers: noStore });
  if (request.signal.aborted) return NextResponse.json({ reason: "disconnected" }, { status: 409, headers: noStore });
  const lease = await acquireMetaDeploymentLease();
  if (!lease.ok) return NextResponse.json(lease, { status: lease.status, headers: noStore });
  if (request.signal.aborted) {
    lease.release();
    return NextResponse.json({ reason: "disconnected" }, { status: 409, headers: noStore });
  }
  let closed = false;
  let abort: (() => void) | undefined;
  const release = () => {
    if (closed) return;
    closed = true;
    if (abort) request.signal.removeEventListener("abort", abort);
    lease.release();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => { release(); try { controller.close(); } catch { /* Already closed. */ } };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) return abort();
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ ok: true, leaseId: lease.leaseId })}\n`));
    },
    cancel() { release(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
