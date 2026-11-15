// Real TypeScript 7 language server over stdio; no npm download required.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const root = new URL('.', import.meta.url);
const child = spawn('/opt/homebrew/bin/tsc', ['--lsp', '--stdio'], { cwd: fileURLToPath(root), stdio: ['pipe','pipe','pipe'] });
let buffer = Buffer.alloc(0), nextId = 0;
const pending = new Map();
const timer = setTimeout(() => { child.kill(); throw new Error('LSP timeout'); }, 30000);
function send(message) { const body = Buffer.from(JSON.stringify(message)); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body); }
function request(method, params) { const id = ++nextId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }); }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\r\n\r\n');
    if (split < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())[1]);
    if (buffer.length < split + 4 + length) return;
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length));
    buffer = buffer.subarray(split + 4 + length);
    if (message.method && message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    }
  }
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
try {
  const initialized = await request('initialize', { processId: process.pid, rootUri: root.href, capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } } });
  assert(initialized.capabilities.diagnosticProvider, 'server must provide pull diagnostics');
  notify('initialized', {});
  for (const name of ['adapter.ts', 'compat.ts', 'index.ts']) {
    const uri = new URL(name, root);
    notify('textDocument/didOpen', { textDocument: { uri: uri.href, languageId: 'typescript', version: 1, text: readFileSync(uri, 'utf8') } });
    const result = await request('textDocument/diagnostic', { textDocument: { uri: uri.href } });
    assert.deepEqual(result.items, [], `${name}: ${JSON.stringify(result)}`);
    console.log(`PASS LSP textDocument/diagnostic ${name}: 0 diagnostics`);
  }
  await request('shutdown');
  const exited = once(child, 'exit');
  notify('exit');
  child.stdin.end();
  await exited;
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
