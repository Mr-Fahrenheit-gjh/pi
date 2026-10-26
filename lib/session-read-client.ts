import { isSessionReadId, MAX_SESSION_READ_IDS, parseSessionReadSnapshot, type SessionReadRequest, type SessionReadSnapshot } from "./session-read-state-shared";

interface UnreadIntent { pending: boolean; token: number; uncertainAfter?: number }

/** One page/runtime's protocol state. Requests capture tokens before entering the write queue. */
export class SessionReadClient {
  snapshot: SessionReadSnapshot | null = null;
  mode: "unknown" | "legacy" | "shared" = "unknown";
  private queue: Promise<unknown> = Promise.resolve();
  private migrationStarted = false;
  private eligible: Set<string> | null = null;
  private pollFailed = false;
  private attempted = new Map<string, number>();
  private explicitUnread = new Map<string, UnreadIntent>();
  constructor(private readonly options: {
    fetch: typeof fetch;
    legacyIds: () => string[];
    migrated: () => void;
    changed: () => void;
    failed: () => void;
  }) {}
  private accept(value: unknown): boolean {
    const state = parseSessionReadSnapshot(value);
    if (!state) return false;
    this.mode = "shared";
    if (!this.snapshot || state.revision > this.snapshot.revision) {
      this.snapshot = state;
      for (const [id, intent] of this.explicitUnread) this.reconcileIntent(id, intent);
      this.options.changed();
    }
    return true;
  }
  noteRunning(data: { sessionReadState?: unknown; runningSessionIds?: unknown }): void {
    if (!Object.hasOwn(data, "sessionReadState")) {
      if (!Array.isArray(data.runningSessionIds) || !data.runningSessionIds.every(id => typeof id === "string")) { this.transportFailed(); return; }
      this.pollFailed = false;
      if (this.mode === "unknown") { this.mode = "legacy"; this.options.changed(); }
      return;
    }
    // A malformed supported response is not evidence of an old backend.
    this.mode = "shared";
    if (!this.accept(data.sessionReadState)) { this.transportFailed(); return; }
    this.pollFailed = false;
    this.migrate();
  }
  /** Only a full catalogue knows child relations; summary rows are not sufficient. */
  noteEligible(ids: readonly string[]): void {
    this.eligible = new Set(ids);
    this.migrate();
  }
  private migrate(): void {
    if (!this.snapshot || !this.eligible || this.migrationStarted) return;
    this.migrationStarted = true;
    const ids = this.options.legacyIds().filter(id => isSessionReadId(id) && this.eligible!.has(id));
    void (async () => {
      for (let i = 0; i < ids.length; i += MAX_SESSION_READ_IDS) {
        if (!await this.send({ action: "import", ids: ids.slice(i, i + MAX_SESSION_READ_IDS) })) return;
      }
      this.options.migrated();
    })();
  }
  transportFailed(): void {
    if (!this.pollFailed) this.options.failed();
    this.pollFailed = true;
  }
  private reconcileIntent(id: string, intent: UnreadIntent): void {
    if (intent.uncertainAfter !== undefined && this.snapshot && this.snapshot.revision > intent.uncertainAfter) {
      // A lost response may have committed unread: preserve that first observed token,
      // but never suppress all later completions on the same conversation.
      intent.token = Object.hasOwn(this.snapshot.unread, id) ? this.snapshot.unread[id] : 0;
      delete intent.uncertainAfter;
    }
  }
  private send(request: SessionReadRequest, intents?: Map<string, UnreadIntent>): Promise<boolean> {
    const operation = async () => {
      const observedRevision = this.snapshot?.revision ?? 0;
      let refused = false;
      try {
        const response = await this.options.fetch("/api/sessions/read-state", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request), cache: "no-store", redirect: "error",
        });
        if (!response.ok) { refused = true; throw new Error("Read-state sync failed"); }
        const body = await response.json();
        const state = parseSessionReadSnapshot(body.state);
        if (!state) throw new Error("Invalid read-state response");
        for (const [id, intent] of intents ?? []) {
          intent.pending = false;
          intent.token = Object.hasOwn(state.unread, id) ? state.unread[id] : 0;
        }
        const accepted = this.accept(state);
        if (intents) this.options.changed();
        return accepted;
      } catch {
        for (const [id, intent] of intents ?? []) {
          intent.pending = false;
          if (!refused) { intent.uncertainAfter = observedRevision; this.reconcileIntent(id, intent); }
        }
        this.options.failed();
        if (intents) this.options.changed();
        return false;
      }
    };
    const pending = this.queue.then(operation);
    this.queue = pending;
    return pending;
  }
  mark(ids: readonly string[], read: boolean): Promise<boolean> {
    if (!this.snapshot) { this.options.failed(); return Promise.resolve(false); }
    const unique = [...new Set(ids)].filter(isSessionReadId);
    // Capture *all* tokens now, never after another request or batch completes.
    const entries = unique.map(id => ({ id, token: Object.hasOwn(this.snapshot!.unread, id) ? this.snapshot!.unread[id] : 0 }));
    const requests: Promise<boolean>[] = [];
    for (let i = 0; i < unique.length; i += MAX_SESSION_READ_IDS) {
      const part = entries.slice(i, i + MAX_SESSION_READ_IDS);
      if (read) requests.push(this.send({ action: "read", entries: part }));
      else {
        const intents = new Map(part.map(({ id, token }) => [id, { pending: true, token }]));
        for (const [id, intent] of intents) this.explicitUnread.set(id, intent);
        requests.push(this.send({ action: "unread", ids: part.map(entry => entry.id) }, intents));
      }
    }
    return Promise.all(requests).then(results => results.every(Boolean));
  }
  /** Selection/focus is a new opportunity to read an explicitly marked conversation. */
  attentionChanged(): void { this.explicitUnread.clear(); }
  autoRead(id: string | null, visible: boolean, focused: boolean): void {
    if (!id || !visible || !focused || !this.snapshot) return;
    const token = Object.hasOwn(this.snapshot.unread, id) ? this.snapshot.unread[id] : 0;
    const intent = this.explicitUnread.get(id);
    if (intent && (intent.pending || intent.uncertainAfter !== undefined || intent.token === token)) return;
    if (this.attempted.get(id) === token) return;
    this.attempted.set(id, token); // Failed writes are not retried automatically.
    void this.mark([id], true);
  }
}
