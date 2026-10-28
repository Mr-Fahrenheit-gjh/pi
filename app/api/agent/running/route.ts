import { NextResponse } from "next/server";
import { getDesignDecks } from "@/lib/design-deck-bridge";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { readSessionReadState } from "@/lib/session-read-state";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";
import { feynmanRestartBlockingIds } from "@/lib/feynman-rpc";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { piMetaRestartBlockingIds } from "@/lib/pi-meta-process.mjs";
import { serviceRestartState } from "@/lib/service-restart-state";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET() {
  let sessionReadState;
  try { sessionReadState = readSessionReadState(); }
  catch { return NextResponse.json({ error: "Session read state is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      designDecks: getDesignDecks(),
      runningSessionIds: getRunningRpcSessionIds(),
      piMetaDeploymentLease: 1,
      otherRuntimeRunningSessionIds: [
        ...feynmanRestartBlockingIds(),
        ...(serviceRestartState().pending ? ["service:restarting"] : []),
        ...await piMetaRestartBlockingIds({ mainAgentDir: getAgentDir(), packageDir: process.cwd() }),
      ],
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision(),
      sessionReadState,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
