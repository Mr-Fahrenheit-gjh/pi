import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { ensurePiMeta } from "@/lib/pi-meta-process.mjs";
import { forwardPiMetaRequest, piMetaUpstreamPath } from "@/lib/pi-meta-proxy.mjs";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { serviceRestartState } from "@/lib/service-restart-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function forward(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  let upstreamPath: string;
  try { upstreamPath = piMetaUpstreamPath(request.url); }
  catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  // The worker sees localhost over its socket; preserve the caller's original
  // loopback check before forwarding any OS file-manager request.
  if (upstreamPath.split("?", 1)[0] === "/api/open-in-explorer" && !isLoopbackHost(request.headers.get("host"))) {
    if (request.method === "GET") return NextResponse.json({ supported: false, reason: "remote", platform: process.platform });
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  try {
    const worker = await ensurePiMeta({ mainAgentDir: getAgentDir(), packageDir: process.cwd(), canStart: () => !serviceRestartState().pending });
    return await forwardPiMetaRequest(worker.socketPath, request);
  } catch (error) {
    console.error("[pi-meta] Worker unavailable:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Pi Meta is unavailable; check the server log before retrying." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
