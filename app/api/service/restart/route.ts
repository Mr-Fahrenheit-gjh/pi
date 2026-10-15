import { NextResponse } from "next/server";
import { isLocalServiceRequest, requestServiceRestart, serviceRestartStatus } from "@/lib/service-restart";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!isLocalServiceRequest(request)) return NextResponse.json({ supported: false }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(await serviceRestartStatus(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  if (!isLocalServiceRequest(request, true)) return NextResponse.json({ reason: "local-only" }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ reason: "confirmation-required" }, { status: 400 }); }
  if (body?.confirmed !== true) return NextResponse.json({ reason: "confirmation-required" }, { status: 400 });
  const result = await requestServiceRestart();
  return NextResponse.json(result, { status: result.ok ? 202 : result.status, headers: { "Cache-Control": "no-store" } });
}
