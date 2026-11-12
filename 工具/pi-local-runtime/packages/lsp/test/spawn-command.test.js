import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolve_server_spawn } from '../src/spawn-command.js';

function fixture(t, global = false, command = 'typescript-language-server', name = command, bin = 'dist/cli.mjs') {
    const root = mkdtempSync(join(tmpdir(), 'lsp windows space-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const modules = join(root, 'node_modules');
    const binDir = global ? root : join(modules, '.bin');
    const pkg = join(modules, name);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin: { [command]: bin } }));
    const cli = join(pkg, bin);
    writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))');
    const binary = join(binDir, command);
    writeFileSync(binary, '#!/bin/sh\nexit 99');
    writeFileSync(binary + '.cmd', '@echo off\r\nexit /b 99');
    return { cli, binary, binDir };
}

test('Windows local npm POSIX and cmd shims both launch installed JS using Node without a shell', t => {
    const { cli, binary } = fixture(t);
    const args = ['--stdio', 'space value', '&echo unsafe', '"quote"', '%PATH%'];
    for (const shim of [binary, binary + '.cmd']) {
        const launch = resolve_server_spawn(shim, args, { platform: 'win32' });
        assert.deepEqual(launch, { command: process.execPath, args: [cli, ...args] });
        const result = spawnSync(launch.command, launch.args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), args);
    }
});

test('Windows global tsc PATH resolves extensionless Node bin; Svelte also resolves', t => {
    const { cli, binDir } = fixture(t, true, 'tsc', 'typescript', 'dist/tsc');
    assert.deepEqual(resolve_server_spawn('tsc', ['--version'], { platform: 'win32', env: { Path: binDir } }), { command: process.execPath, args: [cli, '--version'] });
    const svelte = fixture(t, false, 'svelteserver', 'svelte-language-server');
    assert.equal(resolve_server_spawn(svelte.binary, ['--stdio'], { platform: 'win32' }).args[0], svelte.cli);
});

test('POSIX and native exe launches are unchanged; unknown cmd fails closed', t => {
    const { binary } = fixture(t);
    assert.deepEqual(resolve_server_spawn(binary, ['--stdio'], { platform: 'linux' }), { command: binary, args: ['--stdio'] });
    assert.deepEqual(resolve_server_spawn('rust-analyzer.exe', [], { platform: 'win32' }), { command: 'rust-analyzer.exe', args: [] });
    assert.throws(() => resolve_server_spawn(binary + '-unknown.cmd', [], { platform: 'win32' }), /Cannot resolve npm LSP JS CLI/);
    assert.doesNotMatch(readFileSync(new URL('../src/spawn-command.js', import.meta.url), 'utf8'), /shell\s*:\s*true/);
    for (const file of ['client.js', 'servers.js']) assert.match(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), /resolve_server_spawn/);
});
