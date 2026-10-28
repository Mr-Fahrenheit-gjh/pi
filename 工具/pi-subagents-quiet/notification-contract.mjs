// Model-facing wording only. Execution, ownership, errors and subscriptions stay upstream-owned.
export const LOCAL_COMPLETION_POLICY = '本机普通子代理完成只保存记录，不自动唤醒模型。继续独立工作，在真实依赖点用阻塞 bg_wait 或精确 status 收齐结果；不轮询。显式唤醒订阅仅按需使用，交付前收齐且不遗留订阅。求助与基础设施错误仍可通知。';

const DELEGATION_GATE = 'Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.';
const DELEGATION_SAFETY_GATE = '• Direct parent execution is the default. Invoke subagents only when delegation is authorized by the operator\'s current request or applicable user/project instructions; task size, complexity, risk, tool-call count, or recipe fit do not independently authorize delegation.';

// Remove the upstream opt-in gate; local delegation rules own when to delegate.
// Keep execution permissions, infrastructure handling and workflow contracts intact.
export function adaptDelegationText(text) {
  return text.split('\n').filter(line => ![DELEGATION_GATE, `- ${DELEGATION_GATE}`, DELEGATION_SAFETY_GATE].includes(line.trim())).join('\n')
    .replaceAll('For operator-requested delegation, use subagents;', 'For delegation, use subagents;');
}

const NATIVE_ASYNC_GUIDANCE = 'Native async completion wakes this session: return control, no sleep/poll or bg_wait merely for a wake. bg_wait is for provider/detached work without native notification needing a same-turn result.';
const LOCAL_ASYNC_GUIDANCE = 'Routine async completion is recorded silently on this host; it does not wake the model. Continue independent work, then use blocking bg_wait at a real dependency barrier or inspect exact status. No sleep/poll. Collect required results before final delivery; explicit nonBlocking wake subscriptions must serve a real asynchronous need and must not outlive delivery.';
const WAIT_INTRO = `Wait for owned background, provider, or detached work, then return.

Routine subagent completion is silent on this host. Continue independent work first; use blocking bg_wait at a real dependency barrier to collect required results before final delivery. Prefer an exact run id. Do not sleep or poll. Headless auto-draining keeps work alive but does not synthesize its results. Explicit nonBlocking subscriptions still wake the originating session; use them only for a real asynchronous need and leave none outstanding after delivery.`;
const WAIT_FIELDS = {
  id: 'Async run or remembered detached foreground run id/prefix. Routine subagent completion is silent locally: use blocking bg_wait at a real dependency barrier. Prefer an exact run id; omit only when intentionally waiting across this session’s initially active work.',
  nonBlocking: 'Resolve id to one exact run, persist an explicit wake subscription, and return immediately. Use only when asynchronous continuation is needed; collect its result before final delivery and leave no outstanding subscription. The originating session wakes on completion, failure, attention, reconciliation failure, or timeout. Requires id and cannot be combined with all.',
  all: 'Wait for every run/provider item active when the call begins. Use when all their results are required before delivery. Default false: return when the first tracked item finishes or needs attention. Ignored when id targets one run.',
  timeoutMs: 'Stop this wait after this many milliseconds; active work keeps running. Defaults to config waitTool.defaultTimeoutMs, then 1800000 (30 minutes). Window expiry returns a non-error active-work result, not task completion.',
};

export function adaptToolContract(tool) {
  if (tool.name === 'subagent') {
    const description = adaptDelegationText(tool.description).replaceAll(NATIVE_ASYNC_GUIDANCE, LOCAL_ASYNC_GUIDANCE);
    const promptSnippet = tool.promptSnippet === undefined ? undefined : adaptDelegationText(tool.promptSnippet);
    const promptGuidelines = tool.promptGuidelines?.filter(line => line !== DELEGATION_GATE);
    if (description === tool.description && promptSnippet === tool.promptSnippet && promptGuidelines?.length === tool.promptGuidelines?.length) return tool;
    return { ...tool, description,
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet }),
      ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines }),
    };
  }
  if (tool.name !== 'bg_wait') return tool;
  const bullets = tool.description.indexOf('\n\n• { }');
  // Preserve the option semantics, provider/child boundaries and disabled-config notice.
  const description = tool.description.startsWith(WAIT_INTRO) ? tool.description
    : bullets < 0 ? `${WAIT_INTRO}\n\n${tool.description}` : WAIT_INTRO + tool.description.slice(bullets);
  if (description === tool.description && Object.entries(WAIT_FIELDS).every(([name, text]) => !tool.parameters.properties[name] || tool.parameters.properties[name].description === text)) return tool;
  const properties = { ...tool.parameters.properties };
  for (const [name, text] of Object.entries(WAIT_FIELDS)) {
    if (properties[name]) properties[name] = { ...properties[name], description: text };
  }
  return { ...tool, description, parameters: { ...tool.parameters, properties } };
}

const RECEIPT_REPLACEMENTS = [
  ['You are in an interactive session. Return control to the user now; Pi will wake you through the native completion notification when this subagent completes or needs attention. Do not run sleep/polling loops to wait for this async subagent; it does not need a wait call.',
    'Routine completion is recorded silently on this host and will not wake the model. Continue independent work; collect this run at a real dependency barrier before final delivery. Do not sleep or poll. Supervisor requests and infrastructure errors may still notify.'],
  ['Use bg_wait only for provider, detached, or other background work that lacks a native completion notification.',
    'Use blocking bg_wait({ id: "<run-id>" }) when this run’s result is needed. An explicit nonBlocking subscription is only for a real asynchronous continuation and must not outlive delivery.'],
  ['If the current turn must receive results from work without a native notification before it ends, call blocking bg_wait(); ordinary async subagent runs do not need a wait call because their completion is delivered natively.',
    'Collect required child results before finishing the user task; silent completion records do not substitute for reading the results.'],
  ['Otherwise, continue any independent work or return control to the user. Use subagent({ action: "status", id: "..." }) for a one-shot status/result or to inspect a blocked/stale run, never as a wait loop.',
    'Use subagent({ action: "status", id: "..." }) for a one-shot result/status check or to inspect a blocked/stale run; never poll in a loop.'],
  ['This is a non-interactive run: Pi auto-drains current-session subagent work at agent_end so detached children are not abandoned. Use bg_wait only when this turn must receive provider, detached, or other background-work results that have no native completion notification.',
    'This is a non-interactive run: Pi auto-drains current-session work at agent_end, but does not synthesize its results. Routine completion is silent locally; use blocking bg_wait at a dependency barrier to collect required results before delivery.'],
];

export function adaptAsyncReceipt(result) {
  // Only dispatch receipts, never status/child reports, errors or structured payloads.
  if (result.isError || !result.details?.asyncId || !Array.isArray(result.details.results) || result.details.results.length) return result;
  let changed = false;
  const content = result.content.map(block => {
    if (block.type !== 'text' || !block.text.includes('The async run is detached')) return block;
    let text = block.text;
    for (const [oldText, newText] of RECEIPT_REPLACEMENTS) text = text.replaceAll(oldText, newText);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...result, content } : result;
}
