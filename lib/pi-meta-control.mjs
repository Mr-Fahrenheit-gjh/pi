const TIMERS = new WeakMap();

/** A synchronous worker-side barrier: no await between checking work and draining. */
export function handlePiMetaControl(state, action, blockers, leaseId) {
  const owned = typeof leaseId === "string" && state.drainId === leaseId;
  if (action === "status") return { ok: true, pending: state.pending, closing: state.closing === true, owned, ...blockers };
  if (action === "resume") {
    if (state.closing) return { ok: false, reason: "closing" };
    if (!owned) return { ok: false, reason: "stale" };
    const timer = TIMERS.get(state);
    if (timer) clearTimeout(timer);
    TIMERS.delete(state);
    state.pending = false;
    delete state.drainId;
    return { ok: true };
  }
  if (action === "commit") {
    if (!owned) return { ok: false, reason: "stale" };
    if (!state.pending || state.closing || blockers.sessions || blockers.terminals) return { ok: false, reason: "busy" };
    const timer = TIMERS.get(state);
    if (timer) clearTimeout(timer);
    TIMERS.delete(state);
    state.closing = true; // Irreversible: never reopen admission after shutdown is committed.
    return { ok: true, pending: true, closing: true };
  }
  if (action !== "drain") return { ok: false, reason: "invalid-action" };
  if (typeof leaseId !== "string" || !/^[a-f0-9-]{36}$/.test(leaseId)) return { ok: false, reason: "invalid-lease" };
  if (state.pending || state.closing) return { ok: false, reason: "pending" };
  if (blockers.sessions || blockers.terminals) return { ok: false, reason: "busy", ...blockers };
  state.pending = true;
  state.drainId = leaseId;
  const timer = setTimeout(() => {
    if (state.drainId !== leaseId || state.closing) return;
    state.pending = false;
    delete state.drainId;
    state.error = "meta-restart-timeout";
    TIMERS.delete(state);
  }, 15_000);
  timer.unref?.();
  TIMERS.set(state, timer);
  return { ok: true, pending: true, owned: true, ...blockers };
}
