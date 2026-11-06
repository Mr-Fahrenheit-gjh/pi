import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents, searchSessionContentsPage, SessionSearchCursorError } from "@/lib/session-search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const paged = params.get("paging") === "1";
  const cursor = params.get("cursor") ?? undefined;
  const headers = { "Cache-Control": "no-store" };
  if (cursor && !paged) return NextResponse.json({ error: "Search cursor requires paging" }, { status: 400, headers });
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the trusted whole catalog, never cursor input.
    // A new paged search waits for the current catalog, including other projects
    // and archived sessions. Continuations/legacy clients may reuse the cache
    // while agent activity schedules a refresh; stable ID traversal does not
    // depend on the catalog's changing modified-time order.
    const sessions = query && !request.signal.aborted ? await listAllSessions({ allowStale: !paged || Boolean(cursor) }) : [];
    const result = paged
      ? await searchSessionContentsPage(sessions, query, request.signal, cursor)
      : await searchSessionContents(sessions, query, request.signal);
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (request.signal.aborted) return NextResponse.json({ error: "Search cancelled" }, { status: 499, headers });
    if (error instanceof SessionSearchCursorError) return NextResponse.json({ error: error.message, restart: error.status === 409 }, { status: error.status, headers });
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
