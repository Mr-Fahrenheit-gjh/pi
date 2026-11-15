import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModules } from './load-modules.js';

const { get_server_config, LspServerManager } = await loadModules();

async function withTempProject(run) {
 const root = await mkdtemp(join(tmpdir(), 'pi-lsp-'));
 try {
  await writeFile(join(root, 'package.json'), '{}');
  await run(root);
 } finally {
  await rm(root, { recursive: true, force: true });
 }
}

test('PATH TypeScript 7 native LSP wins even when the project has older TypeScript', async () => {
 await withTempProject(async root => {
  const packageDir = join(root, 'node_modules', 'typescript');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: '6.0.0' }));
  const config = get_server_config('typescript', root, { global_typescript_major: () => 7 });
  assert.deepEqual({ command: config.command, args: config.args, backend: config.backend, is_project_local: config.is_project_local }, {
   command: 'tsc', args: ['--lsp', '--stdio'], backend: 'typescript-native', is_project_local: false,
  });
 });
});

test('shared server startup failure is attributed to each requested file', async () => {
 await withTempProject(async root => {
  const files = [join(root, 'first.ts'), join(root, 'second.ts')];
  await Promise.all(files.map(file => writeFile(file, 'export {};')));
  const manager = new LspServerManager({
   cwd: () => root,
   create_client: () => ({
    async start() { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('synthetic startup failure'); },
    async stop() {},
   }),
  });
  const results = await Promise.all(files.map(file => manager.resolve_file_state(file, { hasUI: false })));
  assert.deepEqual(results.map(result => result.error.file), files);
  assert.ok(results.every(result => !result.ok && result.error.message === 'synthetic startup failure'));
  await manager.clear_language_state();
 });
});
