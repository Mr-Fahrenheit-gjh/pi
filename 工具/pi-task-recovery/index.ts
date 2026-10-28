import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { STATE_TYPE, MAX_RETRIES, RECOVERY_INSTRUCTION, readState, recoveryDecision } from './engine.mjs';

const RESUME_TYPE = 'pi-task-recovery-resume';
const NOTICE_TYPE = 'pi-task-recovery-notice';

export default function taskRecovery(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let outcome: string | undefined;
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function persist(ctx: ExtensionContext, patch: Record<string, unknown>) {
    const state = readState(ctx.sessionManager);
    if (state) pi.appendEntry(STATE_TYPE, { ...state, ...patch, updatedAt: Date.now() });
  }
  function notice(ctx: ExtensionContext, text: string) {
    ctx.ui.setStatus('task-recovery', text);
    pi.sendMessage({ customType: NOTICE_TYPE, content: text, display: true, details: { recovery: true } });
  }
  function pause(ctx: ExtensionContext, reason: string) {
    persist(ctx, { status: 'paused', reason });
    const text = reason === 'retry-exhausted'
      ? '任务已暂停：自动恢复／重试已达三次，仍未成功。原任务和进度已保留。'
      : '任务已暂停：中断处的操作或确认尚未完成核实，需要确认后再继续。原任务和进度已保留。';
    notice(ctx, text);
  }
  pi.on('session_start', (event, ctx) => {
    cancelTimer(); closing = false; outcome = undefined;
    if (event.reason === 'fork') return;
    const state = readState(ctx.sessionManager);
    let ownerAlive = false;
    if (state?.ownerPid && state.ownerPid !== process.pid) {
      try { process.kill(state.ownerPid, 0); ownerAlive = true; }
      catch (error: any) { ownerAlive = error.code !== 'ESRCH'; }
    }
    const decision = recoveryDecision(state, { sessionId: ctx.sessionManager.getSessionId(), currentPid: process.pid, ownerAlive });
    if (decision.action === 'complete') { persist(ctx, { status: 'done' }); return; }
    if (decision.action === 'pause') { pause(ctx, decision.reason); return; }
    if (decision.action !== 'resume' || !ctx.isIdle()) return;
    const runId = state.runId;
    // Leave session_start and host binding before starting a model request.
    timer = setTimeout(() => {
      timer = undefined;
      const latest = readState(ctx.sessionManager);
      if (closing || !ctx.isIdle() || latest?.runId !== runId || latest.status !== 'pending') return;
      // Stop tombstone and budget are checked again immediately before admission.
      const next = recoveryDecision(latest, { sessionId: ctx.sessionManager.getSessionId(), currentPid: process.pid });
      if (next.action !== 'resume') { if (next.action === 'pause') pause(ctx, next.reason); return; }
      persist(ctx, { spent: next.spent, ownerPid: process.pid, recovering: true });
      ctx.ui.setStatus('task-recovery', `正在恢复中断任务（${next.spent}/${MAX_RETRIES}）`);
      pi.sendMessage({ customType: RESUME_TYPE, content: RECOVERY_INSTRUCTION, display: true, details: { runId } }, { triggerTurn: true });
    }, 15000);
    ctx.ui.setStatus('task-recovery', '检测到未完成任务，15秒后自动恢复');
  });
  pi.on('before_agent_start', (event, ctx) => {
    cancelTimer(); outcome = undefined;
    if (event.messageType === 'custom' && event.message.customType === RESUME_TYPE) return;
    pi.appendEntry(STATE_TYPE, {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), runId: randomUUID(),
      status: 'pending', spent: 0, tools: [], waitingForInput: false, admitted: false,
      ownerPid: process.pid, updatedAt: Date.now(),
    });
    ctx.ui.setStatus('task-recovery', undefined);
  });
  pi.on('message_end', (event, ctx) => {
    const message = event.message;
    if (message.role === 'user' || (message.role === 'custom' && message.customType === RESUME_TYPE)) {
      persist(ctx, { admitted: true });
    }
    if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      // Actual model progress breaks a consecutive failure streak; a new process alone does not.
      const calls = message.content.filter((block: any) => block.type === 'toolCall').map((call: any) => ({ id: call.id, name: call.name }));
      persist(ctx, { spent: 0, recovering: false, tools: calls, finalAnswerCommitted: message.stopReason === 'stop' && calls.length === 0 });
    }
  });
  pi.on('turn_start', (_event, ctx) => persist(ctx, { finalAnswerCommitted: false }));
  pi.on('tool_execution_start', (event, ctx) => {
    const state = readState(ctx.sessionManager);
    if (state?.status !== 'pending') return;
    persist(ctx, { tools: [...state.tools.filter((tool: any) => tool.id !== event.toolCallId), { id: event.toolCallId, name: event.toolName }] });
  });
  pi.on('tool_execution_end', (event, ctx) => {
    const state = readState(ctx.sessionManager);
    if (state) persist(ctx, { tools: state.tools.filter((tool: any) => tool.id !== event.toolCallId) });
  });
  pi.on('ui_prompt_start', (_event, ctx) => persist(ctx, { waitingForInput: true }));
  pi.on('ui_prompt_end', (_event, ctx) => persist(ctx, { waitingForInput: false }));
  pi.on('agent_before_settle', event => { outcome = event.outcome; });
  pi.on('agent_settled', (event, ctx) => {
    cancelTimer();
    if (closing) return;
    const state = readState(ctx.sessionManager);
    if (!state || state.status === 'cancelled') { ctx.ui.setStatus('task-recovery', undefined); return; }
    if (event.aborted) {
      persist(ctx, { status: 'cancelled', reason: 'stop' });
      ctx.ui.setStatus('task-recovery', undefined);
    }
    else if (outcome === 'error') {
      persist(ctx, { status: 'paused', reason: state.spent >= MAX_RETRIES ? 'retry-exhausted' : 'model-error' });
      notice(ctx, state.spent >= MAX_RETRIES
        ? '任务已暂停：自动恢复／重试已达三次，仍未成功。原任务和进度已保留。'
        : '任务已暂停：模型请求失败，原任务和进度已保留。');
    } else {
      persist(ctx, { status: 'done', tools: [], waitingForInput: false });
      ctx.ui.setStatus('task-recovery', undefined);
    }
  });
  pi.on('session_shutdown', () => { closing = true; cancelTimer(); });
  pi.registerCommand('recovery-status', {
    description: '查看当前任务的持久恢复状态与已使用次数',
    handler: async (_args, ctx) => {
      const state = readState(ctx.sessionManager);
      ctx.ui.notify(state ? `任务状态：${state.status}；恢复／重试 ${state.spent}/${MAX_RETRIES}；${state.reason || '无暂停原因'}` : '当前会话还没有持久恢复记录。', 'info');
    },
  });
}
