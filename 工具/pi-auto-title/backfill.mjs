// One-off: fill unnamed main sessions in this project's directory only.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildTitleTranscript, TITLE_SYSTEM_PROMPT, TITLE_PROMPT, TITLE_MAX_TOKENS, TITLE_TIMEOUT_MS, parseGeneratedSessionTitle } from './title.ts';
const root = process.env.PI_WEB_PACKAGE_ROOT ?? '/opt/homebrew/lib/node_modules/@agegr/pi-web';
const core = `${root}/node_modules/@earendil-works/pi-coding-agent`;
const { SessionManager, ModelRuntime } = await import(pathToFileURL(`${core}/dist/index.js`));
const { getSupportedThinkingLevels } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/index.js`));
const { configureHttpDispatcher } = await import(pathToFileURL(`${core}/dist/core/http-dispatcher.js`));
configureHttpDispatcher();
const project = '/Users/guojiahang/Documents/pi';
const directory = join(homedir(), '.pi/agent/sessions/--Users-guojiahang-Documents-pi--');
const base = 'http://127.0.0.1:30141';
const reportDir = resolve('工具/pi-auto-title/backfills');
mkdirSync(reportDir, { recursive: true });
const reportPath = process.argv[2] ? resolve(process.argv[2]) : join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`);
async function api(path, options) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Pi Web HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
const fingerprint = file => { const stat = statSync(file); return `${stat.size}:${stat.mtimeMs}`; };
const active = new Set((await api('/api/agent/running')).runningSessionIds);
const report = process.argv[2] ? JSON.parse(readFileSync(reportPath, 'utf8')) : {
  project, model: 'openai-codex/gpt-6-luna', startedAt: new Date().toISOString(),
  scope: 'unnamed main sessions only; preserve existing names; exclude running sessions',
  skipped: { named: 0, subagent: 0, empty: 0, active: 0, otherProject: 0 }, items: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
if (!process.argv[2]) {
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()) {
    const file = join(directory, filename);
    const manager = SessionManager.open(file);
    const header = manager.getHeader();
    const entries = manager.getEntries();
    if (header?.cwd !== project) { report.skipped.otherProject++; continue; }
    if (entries.some(e => e.type === 'custom' && /subagent/i.test(e.customType))) { report.skipped.subagent++; continue; }
    if (manager.getSessionName()?.trim()) { report.skipped.named++; continue; }
    if (active.has(manager.getSessionId())) { report.skipped.active++; continue; }
    const messages = manager.getBranch().filter(e => e.type === 'message').map(e => e.message);
    const transcript = buildTitleTranscript(messages);
    if (!messages.some(m => m.role === 'user') || !transcript.trim()) { report.skipped.empty++; continue; }
    report.items.push({ id: manager.getSessionId(), file, priorName: manager.getSessionName() ?? '', fingerprint: fingerprint(file), status: 'pending' });
  }
  save();
}
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const model = runtime.getModel('openai-codex', 'gpt-6-luna');
if (!model || !runtime.hasConfiguredAuth('openai-codex')) throw new Error('Luna model or auth unavailable');
const reasoning = model.reasoning ? getSupportedThinkingLevels(model)[0] : 'off';
let next = 0, processed = 0;
const pending = report.items.filter(item => ['pending', 'generated'].includes(item.status));
console.log(`Report: ${reportPath}\nCandidates: ${pending.length}; preserved/skipped: ${JSON.stringify(report.skipped)}`);
async function worker() {
  while (next < pending.length) {
    const item = pending[next++];
    try {
      let manager = SessionManager.open(item.file);
      if (manager.getSessionName()?.trim()) { item.status = 'skipped-new-name'; save(); continue; }
      if (fingerprint(item.file) !== item.fingerprint) { item.status = 'skipped-changed'; save(); continue; }
      if (!item.title) {
        const messages = manager.getBranch().filter(e => e.type === 'message').map(e => e.message);
        const transcript = buildTitleTranscript(messages);
        item.requestStartedAt = new Date().toISOString(); save();
        const response = await runtime.streamSimple(model, {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: `${transcript}\n\n${TITLE_PROMPT}` }], timestamp: Date.now() }],
        }, { maxTokens: TITLE_MAX_TOKENS, cacheRetention: 'none', sessionId: randomUUID(), signal: AbortSignal.timeout(TITLE_TIMEOUT_MS), ...(reasoning && reasoning !== 'off' ? { reasoning } : {}) }).result();
        if (['error', 'aborted'].includes(response.stopReason)) throw new Error(response.errorMessage || response.stopReason);
        item.title = parseGeneratedSessionTitle(response.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
        item.usage = response.usage;
        item.status = 'generated'; save();
      }
      const running = new Set((await api('/api/agent/running')).runningSessionIds);
      manager = SessionManager.open(item.file);
      if (manager.getSessionName()?.trim()) item.status = 'skipped-new-name';
      else if (running.has(item.id)) item.status = 'skipped-active';
      else if (fingerprint(item.file) !== item.fingerprint) item.status = 'skipped-changed';
      else {
        // Pi Web owns the metadata write/cache invalidation; no direct JSONL rewrites.
        await api(`/api/sessions/${encodeURIComponent(item.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.title }),
        });
        const fresh = SessionManager.open(item.file);
        const name = fresh.getSessionName();
        if (name !== item.title) throw new Error(`Persisted title mismatch: ${name}`);
        item.nameEntryId = fresh.getEntries().filter(e => e.type === 'session_info').at(-1)?.id;
        item.status = 'updated'; item.updatedAt = new Date().toISOString();
      }
    } catch (error) {
      item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error);
      console.error(`${item.id}: ${item.error}`);
    } finally {
      processed++; save();
      if (processed % 10 === 0 || processed === pending.length) console.log(`${processed}/${pending.length} processed`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
report.finishedAt = new Date().toISOString();
report.totals = report.items.reduce((result, item) => { result[item.status] = (result[item.status] ?? 0) + 1; return result; }, {});
save();
console.log(JSON.stringify(report.totals));
if (report.totals.failed) process.exitCode = 1;
