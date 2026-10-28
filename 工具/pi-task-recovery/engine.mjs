export const STATE_TYPE = 'pi-durable-task';
export const MAX_RETRIES = 3;

export function readState(manager) {
  for (const entry of [...manager.getBranch()].reverse()) {
    if (entry.type === 'custom' && entry.customType === STATE_TYPE) {
      const state = entry.data;
      if (state?.version !== 1 || state.sessionId !== manager.getSessionId()) return undefined;
      return state;
    }
  }
}

export function saveState(manager, state) {
  manager.appendCustomEntry(STATE_TYPE, { ...state, updatedAt: Date.now() });
}

// Called at the common AgentSession.abort boundary, including Stop during a recovery timer.
export function recordStop(manager) {
  const state = readState(manager);
  if (state?.status === 'pending') saveState(manager, { ...state, status: 'cancelled', reason: 'stop' });
}

// Native transport retries and restart recoveries share the same persisted budget.
export function retrySpent(manager) {
  const state = readState(manager);
  if (state?.status !== 'pending') return 0;
  return Number.isSafeInteger(state.spent) && state.spent >= 0 ? state.spent : MAX_RETRIES;
}
export function recordRetry(manager, attempt) {
  const state = readState(manager);
  if (state?.status === 'pending') saveState(manager, { ...state, spent: attempt });
}

export function recoveryDecision(state, { sessionId, currentPid, ownerAlive = false } = {}) {
  if (!state || state.sessionId !== sessionId || state.status !== 'pending') return { action: 'none' };
  if (state.ownerPid !== currentPid && ownerAlive) return { action: 'none', reason: 'owner-alive' };
  if (state.finalAnswerCommitted) return { action: 'complete' };
  if (state.tools?.length) return { action: 'pause', reason: 'tool-outcome-unknown' };
  if (state.waitingForInput) return { action: 'pause', reason: 'confirmation-interrupted' };
  if (!state.admitted) return { action: 'pause', reason: 'input-not-committed' };
  if (!Number.isSafeInteger(state.spent) || state.spent < 0 || state.spent >= MAX_RETRIES) {
    return { action: 'pause', reason: 'retry-exhausted' };
  }
  return { action: 'resume', spent: state.spent + 1 };
}

export const RECOVERY_INSTRUCTION = '上次运行在最终结算前中断。请从已有会话和工具结果继续完成原任务，不从头重做。已经完成的操作不要重复；若无法确认某一步是否执行成功，先核对实际状态。不得扩大原任务授权，也不得重复发布、支付、删除或重复启动已有子代理。';
