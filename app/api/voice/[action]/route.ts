import { voiceRequest } from "@/lib/voice-server";
export const runtime = "nodejs";
export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  return voiceRequest(req, (await params).action);
}
