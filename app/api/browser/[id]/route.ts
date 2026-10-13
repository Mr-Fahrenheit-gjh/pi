import { NextResponse } from "next/server";
import { getBrowserManager } from "@/lib/browser-manager";
import { isBrowserId, parseBrowserCommand } from "@/lib/browser-protocol";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, context: Context) {
  const { id } = await context.params;
  if (isBrowserId(id)) getBrowserManager().touch(id);
  const state = isBrowserId(id) ? getBrowserManager().get(id) : null;
  return state ? NextResponse.json({ engine: "chrome", state }) : NextResponse.json({ error: "Browser page expired or closed" }, { status: 404 });
}
export async function POST(req: Request, context: Context) {
  const { id } = await context.params;
  try {
    const command = parseBrowserCommand(await req.json());
    if (!isBrowserId(id) || !command) return NextResponse.json({ error: "Invalid browser command" }, { status: 400 });
    if (!getBrowserManager().get(id)) return NextResponse.json({ error: "Browser page expired or closed" }, { status: 404 });
    return NextResponse.json(await getBrowserManager().command(id, command));
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
export async function DELETE(_req: Request, context: Context) {
  const { id } = await context.params;
  if (!isBrowserId(id)) return NextResponse.json({ error: "Invalid browser id" }, { status: 400 });
  await getBrowserManager().close(id);
  return NextResponse.json({ success: true });
}
