import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slimContext } from './engine.mjs';

export default function contextCache(pi: ExtensionAPI) {
  let enabled = true;
  let last: any = null;
  let warned = false;
  const directory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'context-cache');
  const written = new Set<string>();

  function archive(text: string) {
    const name = createHash('sha256').update(text).digest('hex') + '.txt';
    const path = join(directory, name);
    if (written.has(path)) return path;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error: any) {
      if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== text) throw error;
    }
    written.add(path);
    return path;
  }

  function restore(ctx: any) {
    enabled = true;
    last = null;
    warned = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'context-cache-mode' && typeof entry.data?.enabled === 'boolean') enabled = entry.data.enabled;
    }
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('context', (event, ctx) => {
    if (!enabled || !['openai', 'openai-codex'].includes(ctx.model?.provider ?? '')) return;
    try {
      const result = slimContext(event.messages, archive);
      last = result.stats;
      return { messages: result.messages };
    } catch {
      // Preserve the original request when archival fails: never lose source data.
      if (!warned && ctx.hasUI) ctx.ui.notify('旧工具内容缓存失败，本次保留完整上下文。', 'warning');
      warned = true;
      return;
    }
  });
  pi.registerCommand('context-cache', {
    description: '旧工具内容按需读取：status / on / off（不删原会话）',
    handler: async (value, ctx) => {
      const command = value.trim() || 'status';
      if (command === 'on' || command === 'off') {
        if (!ctx.isIdle()) { ctx.ui.notify('请在当前任务结束后切换。', 'warning'); return; }
        enabled = command === 'on';
        pi.appendEntry('context-cache-mode', { enabled });
      } else if (command !== 'status') {
        ctx.ui.notify('用法：/context-cache [status|on|off]', 'warning'); return;
      }
      ctx.ui.notify(`旧工具缓存：${enabled ? '开' : '关'}。${last ? `上次工具文本 ${last.beforeChars}→${last.afterChars} 字符，${last.archived}块按需读取。` : '尚未处理请求。'}原始会话不变。`, 'info');
    },
  });
}
