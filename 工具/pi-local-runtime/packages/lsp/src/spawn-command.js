import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const npm_servers = {
    'typescript-language-server': 'typescript-language-server',
    tsc: 'typescript',
    svelteserver: 'svelte-language-server',
};

// Like the memory adapter's qmd launcher, execute the installed JS CLI with
// Node rather than executing npm's Windows .cmd/POSIX shims through a shell.
export function resolve_server_spawn(command, args = [], options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') return { command, args };
    const env = options.env ?? process.env;
    let binary = command;
    if (!isAbsolute(command) && !command.includes('/') && !command.includes('\\')) {
        const entries = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
        for (const directory of entries) {
            const found = ['.exe', '.cmd', ''].map(suffix => join(directory, command + suffix)).find(existsSync);
            if (found) { binary = found; break; }
        }
    }
    if (/\.exe$/i.test(binary)) return { command: binary, args };
    const name = basename(binary).replace(/\.cmd$/i, '');
    const package_name = npm_servers[name];
    if (package_name && (binary.includes('/') || binary.includes('\\'))) {
        const bin_dir = dirname(binary);
        const modules = basename(bin_dir) === '.bin' ? dirname(bin_dir) : join(bin_dir, 'node_modules');
        const root = join(modules, package_name);
        const manifest_file = join(root, 'package.json');
        if (existsSync(manifest_file)) {
            const manifest = JSON.parse(readFileSync(manifest_file, 'utf8'));
            const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
            if (manifest.name !== package_name || typeof relative !== 'string') throw new Error(`Invalid npm LSP bin: ${name}`);
            const cli = resolve(root, relative);
            if (!statSync(cli).isFile() || !(/\.[cm]?js$/i.test(cli) || /^#![^\r\n]*\bnode\b/.test(readFileSync(cli, 'utf8')))) {
                throw new Error(`npm LSP bin is not a Node CLI: ${name}`);
            }
            return { command: process.execPath, args: [cli, ...args] };
        }
    }
    if (/\.cmd$/i.test(binary)) throw new Error(`Cannot resolve npm LSP JS CLI for ${binary}; configure a native executable instead`);
    return { command: binary, args };
}
