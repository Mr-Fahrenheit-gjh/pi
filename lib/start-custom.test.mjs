import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { prepare, getPlan, resolveNpmCli, sourceFingerprint } = require("../bin/start-custom.js");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi custom startup space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app/page.tsx"), "export default 1");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  const calls = [];
  const runNpm = async (args) => {
    calls.push(args);
    if (args[0] === "ci") mkdirSync(join(root, "node_modules"), { recursive: true });
    if (args[0] === "run") {
      mkdirSync(join(root, ".next"), { recursive: true });
      writeFileSync(join(root, ".next/BUILD_ID"), "fixture-build");
    }
  };
  return { root, calls, runNpm };
}

test("first launch installs locked project dependencies and builds; repeat launch does neither", async t => {
  const f = fixture(t);
  assert.equal(getPlan(f.root).install, true);
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["ci"], ["run", "build"]]);
  f.calls.length = 0;
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, []);
  assert.equal(getPlan(f.root).build, false);
});

test("docs do not rebuild; source changes rebuild; lockfile changes reinstall", async t => {
  const f = fixture(t);
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  f.calls.length = 0;
  writeFileSync(join(f.root, "README.md"), "new instructions");
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, []);
  writeFileSync(join(f.root, "app/page.tsx"), "export default 2");
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["run", "build"]]);
  f.calls.length = 0;
  writeFileSync(join(f.root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["ci"], ["run", "build"]]);
});

test("failed reinstall invalidates old readiness even when a partial dependency directory remains", async t => {
  const f = fixture(t);
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  rmSync(join(f.root, "node_modules"), { recursive: true });
  await assert.rejects(prepare(f.root, { runNpm: async args => {
    assert.deepEqual(args, ["ci"]);
    mkdirSync(join(f.root, "node_modules"));
    throw new Error("fixture reinstall failed");
  }, log() {} }), /fixture reinstall failed/);
  assert.equal(getPlan(f.root).install, true);
  assert.equal(getPlan(f.root).build, true);
  f.calls.length = 0;
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["ci"], ["run", "build"]]);
});

test("failed build is retried without reinstalling; missing output is not marked ready", async t => {
  const f = fixture(t);
  await assert.rejects(prepare(f.root, { runNpm: async args => {
    if (args[0] === "ci") await f.runNpm(args);
    else throw new Error("fixture build failed");
  }, log() {} }), /fixture build failed/);
  f.calls.length = 0;
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["run", "build"]]);
  rmSync(join(f.root, ".next/BUILD_ID"));
  await assert.rejects(prepare(f.root, { runNpm: async () => {}, log() {} }), /BUILD_ID/);
  assert.equal(getPlan(f.root).build, true);
});

test("forced rebuild only rebuilds; source hash ignores tests and generated output", async t => {
  const f = fixture(t);
  const before = sourceFingerprint(f.root);
  writeFileSync(join(f.root, "app/page.test.mjs"), "fixture test");
  assert.equal(sourceFingerprint(f.root), before);
  await prepare(f.root, { runNpm: f.runNpm, log() {} });
  f.calls.length = 0;
  await prepare(f.root, { forceBuild: true, runNpm: f.runNpm, log() {} });
  assert.deepEqual(f.calls, [["run", "build"]]);
});

test("npm uses its JS CLI with Node instead of executing a Windows shell shim", t => {
  const f = fixture(t);
  const cli = join(f.root, "npm-cli.js");
  writeFileSync(cli, "fixture npm");
  assert.equal(resolveNpmCli({ npm_execpath: cli }, join(f.root, "node.exe")), cli);
  assert.throws(() => resolveNpmCli({}, join(f.root, "no-node", "node.exe"), []), /npm/);
  const source = readFileSync(new URL("../bin/start-custom.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test("an existing setup lock is not removed or overwritten", async t => {
  const f = fixture(t);
  const lock = join(f.root, ".pi-web-setup.lock");
  writeFileSync(lock, "another setup owns this");
  await assert.rejects(prepare(f.root, { runNpm: f.runNpm, log() {} }), /初始化尚未结束/);
  assert.equal(readFileSync(lock, "utf8"), "another setup owns this");
  assert.deepEqual(f.calls, []);
});

test("invalid launch arguments and upstream update fail before preparation", () => {
  const script = new URL("../bin/start-custom.js", import.meta.url);
  for (const [args, expected] of [[["--port", "invalid"], /Port must/], [["update"], /定制版请使用 git pull/]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /按锁文件准备|构建定制网页端/);
  }
});

test("linked dependency directories are refused rather than modifying another installation", async t => {
  const f = fixture(t);
  const other = join(f.root, "shared modules");
  mkdirSync(other);
  symlinkSync(other, join(f.root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepare(f.root, { runNpm: f.runNpm, log() {} }), /node_modules.*link|node_modules.*链接/);
  unlinkSync(join(f.root, "node_modules"));
  symlinkSync(join(f.root, "missing modules"), join(f.root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepare(f.root, { runNpm: f.runNpm, log() {} }), /node_modules.*link|node_modules.*链接/);
  assert.deepEqual(f.calls, []);
});
