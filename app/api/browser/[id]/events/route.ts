import { getBrowserManager } from "@/lib/browser-manager";
import { isBrowserId } from "@/lib/browser-protocol";
import type { BrowserEvent } from "@/lib/browser-types";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = getBrowserManager();
  if (!isBrowserId(id) || !manager.get(id)) return new Response("Browser page expired or closed", { status: 404 });
  let closeStream: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (closed) return; closed = true;
        unsubscribe?.(); if (heartbeat) clearInterval(heartbeat);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* Already cancelled. */ }
      };
      closeStream = cleanup;
      const send = (event: BrowserEvent) => {
        if (closed) return;
        try {
          if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "closed") cleanup();
        } catch { cleanup(); }
      };
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) { cleanup(); return; }
      try {
        const subscription = await manager.subscribe(id, send);
        if (!subscription) { cleanup(); return; }
        unsubscribe = subscription;
        if (closed) { unsubscribe(); return; }
        heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); } }, 20000);
      } catch { cleanup(); }
    },
    cancel() { closeStream(); },
  }, { highWaterMark: 4 * 1024 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
}
