import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAutoTitle, STATE } from './core.ts';
import { buildTitleTranscript, parseGeneratedSessionTitle, TITLE_PROMPT } from './title.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(generate = async () => '量化面试随机过程讲解') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-title-'));
  const file = join(dir, 'session.jsonl');
  let entries = [], nextId = 0, id = 'session-1', branch = undefined;
  const handlers = new Map(), calls = [], notices = [];
  const persist = () => writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const append = entry => { const result = { id: String(++nextId), ...entry }; entries.push(result); persist(); return result; };
  const ctx = {
    sessionManager: {
      getEntries: () => entries.slice(), getBranch: () => branch ?? entries.slice(),
      getSessionId: () => id, getSessionFile: () => file,
    }, hasUI: true, ui: { notify: (...args) => notices.push(args) },
  };
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const pi = {
    on: (type, fn) => handlers.set(type, fn),
    appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
    setSessionName: name => { append({ type: 'session_info', name }); emit('session_info_changed', { name }); },
  };
  const wrapped = (text, ctx, signal) => { calls.push({ text, signal }); return generate(text, ctx, signal); };
  const start = () => emit('session_start');
  function user(text = '讲解随机过程', persistBefore = false) {
    const message = { role: 'user', content: text };
    if (persistBefore) append({ type: 'message', message });
    emit('message_end', { message });
    if (!persistBefore) append({ type: 'message', message });
    return message;
  }
  const name = () => entries.filter(e => e.type === 'session_info').at(-1)?.name;
  const records = kind => entries.filter(e => e.type === 'custom' && e.customType === STATE && e.data.kind === kind);
  persist(); installAutoTitle(pi, wrapped); start();
  return { ctx, pi, emit, user, start, append, name, records, calls, notices, file,
    entries: () => entries, switchId: () => { id = 'session-2'; },
    setBranch: value => { branch = value; }, cleanup: () => { emit('session_shutdown'); rmSync(dir, { recursive: true, force: true }); },
  };
}
async function using(generate, fn) {
  const h = harness(generate);
  try { await fn(h); } finally { h.cleanup(); }
}

test('only user messages 1, 5, 10 trigger; afterwards title stays fixed', async () => using(undefined, async h => {
  for (let i = 1; i <= 15; i++) { h.user(`问题 ${i}`); await flush(); }
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.records('attempt').map(e => e.data.count), [1, 5, 10]);
  assert.deepEqual(h.records('applied').map(e => e.data.count), [1, 5, 10]);
  assert.equal(h.name(), '量化面试随机过程讲解');
  assert.match(h.calls[1].text, /问题 5/);
}));
test('assistant/tool messages do not count', async () => using(undefined, async h => {
  for (const role of ['assistant', 'toolResult', 'system']) h.emit('message_end', { message: { role, content: 'text' } });
  assert.equal(h.calls.length, 0);
  h.user(); await flush(); assert.equal(h.calls.length, 1);
}));
test('duplicate event and reload cannot repeat a milestone', async () => using(undefined, async h => {
  const msg = h.user(); h.emit('message_end', { message: msg }); await flush();
  h.start(); h.emit('message_end', { message: msg }); await flush();
  assert.equal(h.calls.length, 1);
  for (let i = 2; i <= 5; i++) h.user();
  await flush(); assert.equal(h.calls.length, 2);
}));
test('also handles hosts that already persisted the user event', async () => using(undefined, async h => {
  h.user('问题', true); await flush(); assert.equal(h.calls.length, 1);
}));
for (const manual of ['我的标题', '', '量化面试随机过程讲解']) {
  test(`manual rename permanently stops automation: ${JSON.stringify(manual)}`, async () => using(undefined, async h => {
    h.user(); await flush(); h.pi.setSessionName(manual); h.start();
    for (let i = 2; i <= 12; i++) h.user();
    await flush(); assert.equal(h.calls.length, 1); assert.equal(h.name(), manual);
    assert.equal(h.records('manual').length, 1);
  }));
}
test('existing unmarked title is always protected', async () => using(undefined, async h => {
  h.append({ type: 'session_info', name: '原有标题' }); h.start();
  for (let i = 0; i < 12; i++) h.user();
  await flush(); assert.equal(h.calls.length, 0); assert.equal(h.name(), '原有标题');
}));
test('manual rename during an in-flight request wins', async () => {
  let resolve;
  await using(() => new Promise(r => { resolve = r; }), async h => {
    h.user(); h.pi.setSessionName('手动标题'); resolve('迟到的自动标题'); await flush();
    assert.equal(h.name(), '手动标题'); assert.equal(h.calls[0].signal.aborted, true);
  });
});
test('disk-only rename from another wrapper is protected', async () => {
  let resolve;
  await using(() => new Promise(r => { resolve = r; }), async h => {
    h.user();
    writeFileSync(h.file, [...h.entries(), { type: 'session_info', id: 'external', name: '外部手动标题' }].map(e => JSON.stringify(e)).join('\n'));
    resolve('不得写入'); await flush();
    assert.equal(h.name(), undefined); assert.equal(h.records('manual').length, 1);
  });
});
test('session replacement discards late results', async () => {
  let resolve;
  await using(() => new Promise(r => { resolve = r; }), async h => {
    h.user(); h.switchId(); h.start(); resolve('旧会话标题'); await flush(); assert.equal(h.name(), undefined);
  });
});
test('shutdown cancels requests and prevents late writes', async () => {
  let resolve;
  await using(() => new Promise(r => { resolve = r; }), async h => {
    h.user(); h.emit('session_shutdown'); resolve('迟到'); await flush(); assert.equal(h.name(), undefined);
    assert.equal(h.calls[0].signal.aborted, true);
  });
});
test('older milestone finishing last cannot overwrite a newer title', async () => {
  const resolves = [];
  await using(() => new Promise(r => resolves.push(r)), async h => {
    for (let i = 0; i < 10; i++) h.user();
    resolves[2]('第十条最终标题'); await flush();
    resolves[1]('第五条标题'); resolves[0]('第一条标题'); await flush();
    assert.equal(h.name(), '第十条最终标题'); assert.equal(h.records('applied').length, 1);
  });
});
test('failed milestone is not retried but later milestones still work', async () => {
  let n = 0;
  await using(async () => { if (++n === 1) throw new Error('模拟失败'); return '第五条标题'; }, async h => {
    h.user(); await flush(); h.start();
    for (let i = 2; i <= 5; i++) h.user();
    await flush(); assert.equal(h.calls.length, 2); assert.equal(h.name(), '第五条标题');
    assert.equal(h.records('error').length, 1); assert.equal(h.notices.length, 1);
  });
});
test('restoring unnamed old chats does not backfill missed milestones', async () => using(undefined, async h => {
  for (let i = 0; i < 4; i++) h.append({ type: 'message', message: { role: 'user', content: '旧消息' } });
  h.start(); assert.equal(h.calls.length, 0);
  h.user(); await flush(); assert.equal(h.calls.length, 1); assert.equal(h.records('attempt')[0].data.count, 5);
}));
test('subagent metadata disables naming', async () => using(undefined, async h => {
  h.append({ type: 'custom', customType: 'pi-web:subagent', data: {} }); h.start();
  h.user(); await flush(); assert.equal(h.calls.length, 0);
}));
test('branch user count determines next milestone, session attempts remain deduplicated', async () => using(undefined, async h => {
  h.user(); await flush();
  const branch = h.entries().filter(e => e.type === 'message');
  h.setBranch(branch); h.emit('session_tree');
  h.user(); await flush(); assert.equal(h.calls.length, 1);
}));
test('detached naming does not block message handling', async () => {
  let resolve;
  await using(() => new Promise(r => { resolve = r; }), async h => {
    const result = h.emit('message_end', { message: { role: 'user', content: '测试' } });
    assert.equal(result, undefined); assert.equal(h.calls.length, 1);
    resolve('标题'); await flush();
  });
});
test('Pi Web title prompt and cleanup are retained', () => {
  assert.match(TITLE_PROMPT, /8-24 characters/);
  assert.equal(parseGeneratedSessionTitle('标题：“随机过程学习计划”'), '随机过程学习计划');
  assert.equal(parseGeneratedSessionTitle('{"title":"伊藤引理讲解"}'), '伊藤引理讲解');
  assert.throws(() => parseGeneratedSessionTitle('...'));
});
test('title transcript drops tools/thinking, keeps user goals, bounds long conversations', () => {
  const messages = [{ role: 'user', content: '最初研究目标' }];
  for (let i = 0; i < 30; i++) messages.push(
    { role: 'user', content: '问'.repeat(1500) },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '秘密' }, { type: 'toolCall', name: '秘密工具' }, { type: 'text', text: '回答'.repeat(500) }] },
    { role: 'toolResult', content: '秘密工具结果' },
  );
  messages.push({ role: 'user', content: '最终研究结果' });
  const text = buildTitleTranscript(messages);
  assert.ok(text.length < 6100); assert.match(text, /最初研究目标/); assert.match(text, /最终研究结果/); assert.doesNotMatch(text, /秘密/);
});
