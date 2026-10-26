import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readSessionReadState, updateSessionReadState } from "@/lib/session-read-state";
import { MAX_SESSION_READ_BODY_BYTES, parseSessionReadRequest } from "@/lib/session-read-state-shared";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const refusal = (status: number, error: string) => NextResponse.json({ error }, { status, headers });
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  try { return NextResponse.json({ state: readSessionReadState() }, { headers }); }
  catch { return refusal(503, "Session read state is unavailable"); }
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");
  // Bound streamed input too, not just the untrusted Content-Length header.
  const reader = req.body?.getReader();
  if (!reader) return refusal(400, "Expected a JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let body: unknown;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SESSION_READ_BODY_BYTES) { await reader.cancel(); return refusal(413, "Request body is too large"); }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return refusal(400, "Invalid JSON body"); }
  const request = parseSessionReadRequest(body);
  if (!request) return refusal(400, "Invalid session read request");
  try { return NextResponse.json({ state: await updateSessionReadState(request) }, { headers }); }
  catch { return refusal(503, "Session read state could not be saved"); }
}
