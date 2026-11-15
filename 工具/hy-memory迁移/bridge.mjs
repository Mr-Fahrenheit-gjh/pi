import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

// Only this loopback adapter is custom. Memory extraction/governance stays in Hy-Memory/MemHub.
// Independent services have no Pi host loader. Select only their configured
// installation (or the current agent npm tree), never an unrelated global SDK.
export function resolveBackendPaths(env = process.env, home = homedir()) {
  const agent = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent');
  const sdkRoot = env.HY_BRIDGE_PI_SDK_ROOT?.trim() || path.join(agent, 'npm/node_modules/@earendil-works/pi-coding-agent');
  const qmdRoot = env.HY_BRIDGE_QMD_ROOT?.trim() || path.join(agent, 'npm/node_modules/@tobilu/qmd');
  const embedFile = env.HY_BRIDGE_EMBED_FILE?.trim() || path.join(home, '.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf');
  const sdkManifest = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  if (sdkManifest.name !== '@earendil-works/pi-coding-agent') throw new Error('invalid_pi_sdk_package');
  const qmdManifest = JSON.parse(readFileSync(path.join(qmdRoot, 'package.json'), 'utf8'));
  if (qmdManifest.name !== '@tobilu/qmd' || qmdManifest.version !== '2.8.3') throw new Error('qmd_version_changed_revalidate_adapter');
  const sdk = path.join(sdkRoot, 'dist/index.js');
  const dispatcher = path.join(sdkRoot, 'dist/core/http-dispatcher.js');
  const qmd = path.join(qmdRoot, 'dist/llm.js');
  for (const file of [sdk, dispatcher, qmd]) if (!statSync(file).isFile()) throw new Error('backend_entry_not_file');
  try { if (!statSync(embedFile).isFile()) throw new Error('not_file'); }
  catch { throw new Error('existing_qmd_model_not_found_no_download_attempted'); }
  return { sdk, dispatcher, qmd, embedFile };
}
const CHAT_MODEL = 'gpt-6.1-sol';
const EMBED_MODEL = 'qmd-embeddinggemma-300m';
const usageZero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function translateMessages(messages, model) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages_required');
  const system = [], result = [];
  for (const item of messages) {
    if (!item || typeof item.content !== 'string') throw new Error('text_messages_only');
    if (item.role === 'system' || item.role === 'developer') system.push(item.content);
    else if (item.role === 'user') result.push({ role: 'user', content: item.content, timestamp: Date.now() });
    else if (item.role === 'assistant') result.push({ role: 'assistant', content: [{ type: 'text', text: item.content }],
      api: model.api, provider: model.provider, model: model.id, usage: usageZero(), stopReason: 'stop', timestamp: Date.now() });
    else throw new Error('unsupported_message_role');
  }
  if (!result.length) throw new Error('user_message_required');
  return { systemPrompt: system.join('\n\n'), messages: result };
}

export function encodeEmbedding(vector, format = 'float') {
  if (format === 'float') return vector;
  if (format !== 'base64') throw new Error('unsupported_embedding_format');
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value,index) => bytes.writeFloatLE(value,index * 4));
  return bytes.toString('base64');
}

export async function createBackends(env = process.env) {
  const { sdk, dispatcher, qmd, embedFile } = resolveBackendPaths(env);
  const { ModelRuntime } = await import(pathToFileURL(sdk).href);
  // SDK-only callers must initialize the same proxy-aware dispatcher as Pi's host.
  const { configureHttpDispatcher } = await import(pathToFileURL(dispatcher).href);
  configureHttpDispatcher(240_000);
  const { LlamaCpp } = await import(pathToFileURL(qmd).href);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel('openai-codex', CHAT_MODEL);
  if (!model || !runtime.hasConfiguredAuth('openai-codex')) throw new Error('pi_model_or_auth_unavailable');
  const llm = new LlamaCpp({ embedModel: embedFile, inactivityTimeoutMs: 120_000, disposeModelsOnInactivity: true });
  let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  return {
    chat: (body, signal) => serial(async () => {
      if (signal.aborted) throw new Error('request_aborted');
      const context = translateMessages(body.messages, model);
      if (body.response_format?.type === 'json_object') context.systemPrompt += '\nReturn a valid JSON object only, without Markdown fences.';
      const answer = await runtime.completeSimple(model, context, {
        reasoning: 'medium', maxTokens: Math.min(Math.max(Number(body.max_tokens || body.max_completion_tokens || 4096), 1024), 16384),
        signal, cacheRetention: 'short', transport: 'sse',
      });
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted' || answer.stopReason === 'length') {
        throw new Error('pi_completion_' + answer.stopReason);
      }
      const content = answer.content.filter(x => x.type === 'text').map(x => x.text).join('');
      if (!content.trim()) throw new Error('empty_completion');
      return { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now()/1000), model: CHAT_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: answer.usage.input + answer.usage.cacheRead, completion_tokens: answer.usage.output, total_tokens: answer.usage.totalTokens } };
    }),
    embed: (body, signal) => serial(async () => {
      if (signal.aborted) throw new Error('request_aborted');
      const inputs = typeof body.input === 'string' ? [body.input] : body.input;
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64 || inputs.some(x => typeof x !== 'string' || !x.trim())) {
        throw new Error('invalid_embedding_input');
      }
      if (body.encoding_format && !['float','base64'].includes(body.encoding_format)) throw new Error('unsupported_embedding_format');
      if (body.dimensions !== undefined && body.dimensions !== 768) throw new Error('embedding_dimensions_must_be_768');
      // Hy-Memory's standard OpenAI embedder does not distinguish query/document inputs.
      // Use symmetric raw text consistently; validate retrieval quality rather than silently mixing QMD task prefixes.
      const embeddings = await llm.embedBatch(inputs);
      if (embeddings.some(x => !x || !Array.isArray(x.embedding) || x.embedding.length !== 768 || x.embedding.some(n => !Number.isFinite(n)))) {
        throw new Error('invalid_embedding_output');
      }
      return { object: 'list', model: EMBED_MODEL, data: embeddings.map((x,index) => ({ object: 'embedding', index, embedding: encodeEmbedding(x.embedding,body.encoding_format) })),
        usage: { prompt_tokens: embeddings.reduce((n,x) => n + (x.tokens || 0),0), total_tokens: embeddings.reduce((n,x) => n + (x.tokens || 0),0) } };
    }),
    close: () => llm.dispose(),
  };
}

export function createServer(backends, token) {
  const expected = Buffer.from('Bearer ' + token);
  const counters = { chat: 0, embedding: 0, failed: 0 };
  const server = http.createServer(async (req,res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const respond = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(401, { error: { message: 'unauthorized' } });
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', chat_model: CHAT_MODEL, reasoning: 'medium', embedding_model: EMBED_MODEL, dimensions: 768, counters });
    if (req.method !== 'POST' || !['/v1/chat/completions','/v1/embeddings'].includes(req.url)) return respond(404, { error: { message: 'not_found' } });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2*1024*1024) { const e = new Error('body_too_large'); e.status = 413; throw e; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const e = new Error('invalid_json'); e.status = 400; throw e; }
      if (body.stream || body.tools?.length) { const e = new Error('stream_and_tools_not_supported'); e.status = 400; throw e; }
      if (body.response_format?.type === 'json_schema') { const e = new Error('response_format json_schema is not supported; use prompted JSON'); e.status = 400; throw e; }
      const chat = req.url === '/v1/chat/completions';
      if (body.model !== (chat ? CHAT_MODEL : EMBED_MODEL)) { const e = new Error('model_not_allowed'); e.status = 400; throw e; }
      const result = await (chat ? backends.chat(body,controller.signal) : backends.embed(body,controller.signal));
      counters[chat ? 'chat' : 'embedding']++; respond(200,result);
    } catch (error) {
      counters.failed++;
      // Never log request bodies, completions, credentials, upstream errors, or personal paths.
      respond(error.status || 502, { error: { message: error.status ? error.message : 'backend_request_failed', type: 'adapter_error' } });
      console.error(JSON.stringify({ event: 'request_failed', kind: req.url === '/v1/embeddings' ? 'embedding' : 'chat', code: error.status || 502 }));
    } finally { clearTimeout(timeout); res.off('close',onClose); }
  });
  server.requestTimeout = 250_000; server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tokenFile = process.env.HY_BRIDGE_TOKEN_FILE;
  if (!tokenFile) throw new Error('HY_BRIDGE_TOKEN_FILE_required');
  const token = readFileSync(tokenFile,'utf8').trim();
  if (token.length < 32) throw new Error('private_token_too_short');
  const backends = await createBackends();
  const server = createServer(backends,token);
  const port = Number(process.env.HY_BRIDGE_PORT || 30147);
  server.listen(port,'127.0.0.1',() => console.log(JSON.stringify({ event: 'listening', port, reasoning: 'medium', qmd: '2.8.3' })));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections(); await backends.close(); process.exit(0); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
}
