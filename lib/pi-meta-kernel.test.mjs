import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = process.env.PI_META_TEST_DEPENDENCY_ROOT;
assert.ok(webRoot && isAbsolute(webRoot), "PI_META_TEST_DEPENDENCY_ROOT must point to the installed Web package");
const { resolveOriginalPi } = createRequire(import.meta.url)("../bin/pi-meta-original.cjs");
const originalPi = resolveOriginalPi(webRoot);
const preload = fileURLToPath(new URL("../bin/pi-meta-kernel.cjs", import.meta.url));
const sdk = join(webRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const probe = `
  const { pathToFileURL } = require('node:url');
  (async () => {
    const esm = await import(pathToFileURL(process.env.TEST_SDK).href);
    const cjs = require(process.env.TEST_SDK);
    process.stdout.write(JSON.stringify({
      patched: 'hasPendingInterruptSteer' in esm.AgentSession.prototype,
      sameClass: esm.AgentSession === cjs.AgentSession,
      original: globalThis[Symbol.for('pi-web:meta-original-agent-session/v1')] === true,
      childRoot: process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
    }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

function run(script = probe, overrides = {}) {
  const options = existsSync(preload) ? `--require=${JSON.stringify(preload)}` : "";
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      JITI_FS_CACHE: "0",
      NODE_OPTIONS: options,
      PI_META_PROCESS: "1",
      PI_META_WEB_PACKAGE_DIR: webRoot,
      PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: "/wrong/inherited/root",
      TEST_SDK: sdk,
      ...overrides,
    },
  });
}

test("Meta loads the original AgentSession for import and require, and selects the original child SDK", () => {
  const child = run();
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.patched, false, "Meta must not load the patched Web AgentSession");
  assert.equal(value.sameClass, true);
  assert.equal(value.original, true);
  assert.equal(value.childRoot, originalPi.root);
});

test("an installed original works without a home pi-legacy launcher", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-installed-original-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, "web"), modules = join(web, "node_modules"), home = join(root, "home");
  await mkdir(modules, { recursive: true });
  await mkdir(home);
  // Isolated fixture links existing dependencies; the original package itself
  // is an independent copy, as in the installer, and has no nested Pi copies.
  for (const name of await readdir(join(webRoot, "node_modules"))) {
    if (name !== ".pi-meta-original") await symlink(join(webRoot, "node_modules", name), join(modules, name));
  }
  const original = join(modules, ".pi-meta-original");
  await mkdir(original);
  await cp(join(originalPi.root, "package.json"), join(original, "package.json"));
  await cp(join(originalPi.root, "dist"), join(original, "dist"), { recursive: true });
  const sdkDependencies = join(webRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules");
  if (existsSync(sdkDependencies)) await cp(sdkDependencies, join(original, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const env = { HOME: home, PI_META_WEB_PACKAGE_DIR: web };
  const child = run(probe, env);
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.original, true);
  assert.equal(value.childRoot, await realpath(original));
  const command = `
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [process.env.PI_SUBAGENT_PI_BINARY, '--version'], { encoding: 'utf8', env: process.env });
    process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
  `;
  const cliChild = run(command, env);
  assert.equal(cliChild.status, 0, cliChild.stderr);
  const result = JSON.parse(cliChild.stdout);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.4\.0/);
});

test("the regular Web SDK remains patched when Meta is not active", () => {
  const child = run(probe, { PI_META_PROCESS: "0" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).patched, true);
});

test("Meta refuses Pi bundles that bypass its shared-auth lock", () => {
  const script = `import(require('node:url').pathToFileURL(process.env.TEST_BUNDLE).href)
    .catch(error => { console.error(error); process.exitCode = 1; });`;
  const bundles = [join(webRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js"),
    join(originalPi.root, "dist/bundle/cli.js")];
  for (const bundle of bundles) {
    const child = run(script, { TEST_BUNDLE: bundle });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Pi Meta refuses Pi bundles/);
  }
});

test("a worker thread inherits the original-kernel preload", () => {
  const script = `
    const { Worker } = require('node:worker_threads');
    const code = ${JSON.stringify(probe.replace("process.stdout.write(JSON.stringify({", "require('node:worker_threads').parentPort.postMessage({").replace("    }));", "    });"))};
    const worker = new Worker(code, { eval: true });
    worker.on('message', value => process.stdout.write(JSON.stringify(value)));
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
  `;
  const child = run(script);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).patched, false);
  assert.equal(JSON.parse(child.stdout).original, true);
});

test("the installed pi-subagents creates an original in-memory child and resolves the original CLI", { skip: !process.env.PI_META_TEST_AGENT_ROOT }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-original-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meta = join(root, "meta"), main = join(root, "main"), legacy = join(root, "legacy");
  await Promise.all([mkdir(meta), mkdir(main), mkdir(legacy)]);
  await writeFile(join(legacy, "auth.json"), "{}");
  await symlink(join(legacy, "auth.json"), join(main, "auth.json"));
  await symlink(join(main, "auth.json"), join(meta, "auth.json"));
  await writeFile(join(meta, "settings.json"), "{}");
  const plugin = join(process.env.PI_META_TEST_AGENT_ROOT, "npm/node_modules/pi-subagents/src/runs/shared");
  const script = `
    const { pathToFileURL } = require('node:url');
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    (async () => {
      const api = await import(pathToFileURL(path.join(process.env.TEST_PLUGIN, 'child-session.js')).href);
      const spawn = await import(pathToFileURL(path.join(process.env.TEST_PLUGIN, 'pi-spawn.js')).href);
      const factory = api.createDefaultChildSessionFactory();
      try {
        const child = await factory.create({ cwd:process.env.PI_CODING_AGENT_DIR, runtime:{}, tools:[], excludeTools:[],
          ambientExtensions:false, noSkills:true, noContextFiles:true, extensionPaths:[], hooks:[], storage:{kind:'memory'} });
        const host = await api.loadHostPiCodingAgent();
        const spec = spawn.getPiSpawnCommand(['--version']);
        const cli = spawnSync(spec.command, spec.args, { encoding:'utf8', env:process.env });
        process.stdout.write(JSON.stringify({ created:!!child.sessionId, sessionFile:child.sessionFile ?? null,
          patched:'hasPendingInterruptSteer' in host.AgentSession.prototype, agentDir:host.getAgentDir(),
          cli:spec.command, cliStatus:cli.status, cliError:cli.error?.message, version:(cli.stdout ?? "").trim() }));
        await child.dispose();
      } finally { await factory.dispose(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const authPreload = fileURLToPath(new URL("../bin/pi-meta-auth-lock.cjs", import.meta.url));
  const child = run(script, { PI_CODING_AGENT_DIR: meta, TEST_PLUGIN: plugin,
    PI_META_AUTH_PATH: join(meta, "auth.json"), PI_META_SHARED_AUTH_PATH: join(main, "auth.json"),
    NODE_OPTIONS: `--require=${JSON.stringify(preload)} --require=${JSON.stringify(authPreload)}` });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.created, true);
  assert.equal(value.sessionFile, null);
  assert.equal(value.patched, false);
  assert.equal(value.agentDir, meta);
  assert.equal(value.cli, join(originalPi.root, "dist/cli.js"));
  assert.equal(value.cliStatus, 0, value.cliError);
  assert.match(value.version, /1\.4\.0/);
});

test("Meta refuses an absent Web SDK instead of falling back to a patched engine", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-kernel-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = run("process.stdout.write('unexpected')", { PI_META_WEB_PACKAGE_DIR: root });
  assert.notEqual(child.status, 0, "missing SDK must prevent Meta startup");
  assert.match(child.stderr, /Pi Meta.*(kernel|SDK|package)/i);
});

test("Meta refuses a modified runtime dependency even when its version is unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-kernel-modified-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "node_modules/@earendil-works");
  await mkdir(dir, { recursive: true });
  if (originalPi.installed) {
    const copy = join(root, "node_modules/.pi-meta-original");
    await mkdir(copy);
    await cp(join(originalPi.root, "package.json"), join(copy, "package.json"));
    await cp(join(originalPi.root, "dist"), join(copy, "dist"), { recursive: true });
    if (existsSync(join(originalPi.root, "node_modules"))) {
      await cp(join(originalPi.root, "node_modules"), join(copy, "node_modules"), { recursive: true, verbatimSymlinks: true });
    }
  }
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-codemode", "pi-mcp", "pi-telemetry", "pi-tui"]) {
    const from = join(webRoot, "node_modules/@earendil-works", name);
    const to = join(dir, name);
    if (name === "pi-agent-core") {
      // Dependency roots may be symlinks in a test fixture: copy their bytes,
      // never mutate the original candidate through a copied symlink.
      await cp(from, to, { recursive: true, dereference: true });
      const info = await lstat(to);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.equal(await realpath(to), join(await realpath(dir), name));
    }
    else await symlink(from, to, "dir");
  }
  const modified = join(dir, "pi-agent-core/dist/index.js");
  assert.ok((await lstat(modified)).isFile() && !(await lstat(modified)).isSymbolicLink());
  await writeFile(modified, "// modified with the same package version\n", { flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW });
  const child = run("process.stdout.write('unexpected')", { PI_META_WEB_PACKAGE_DIR: root });
  assert.notEqual(child.status, 0, "modified SDK dependency must prevent Meta startup");
  assert.match(child.stderr, /Pi Meta.*(integrity|mismatch)/i);
});
