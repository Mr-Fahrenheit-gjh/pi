import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { resolveOriginalPi } = require("../bin/pi-meta-original.cjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-original-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, "web"), home = join(root, "home");
  await mkdir(join(web, "node_modules"), { recursive: true });
  await mkdir(home);
  return { root, web, home };
}

async function packageFixture(root) {
  await mkdir(join(root, "dist/bundle"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0" }));
  await writeFile(join(root, "dist/cli.js"), "// fixture\n", { mode: 0o755 });
  await writeFile(join(root, "dist/bundle/cli.js"), "// fixture\n", { mode: 0o755 });
}

async function legacyFixture(root, home) {
  const legacy = join(root, "legacy");
  await packageFixture(legacy);
  await mkdir(join(home, ".pi/agent/bin"), { recursive: true });
  await symlink(join(legacy, "dist/bundle/cli.js"), join(home, ".pi/agent/bin/pi-legacy"));
  return legacy;
}

test("uses the verified installed original when no legacy launcher exists", async (t) => {
  const { web, home } = await fixture(t);
  const original = join(web, "node_modules/.pi-meta-original");
  await packageFixture(original);
  assert.deepEqual(resolveOriginalPi(web, home), { root: await realpath(original), installed: true });
});

test("falls back to the existing legacy launcher when no installed original exists", async (t) => {
  const { root, web, home } = await fixture(t);
  const legacy = await legacyFixture(root, home);
  assert.deepEqual(resolveOriginalPi(web, home), { root: await realpath(legacy), installed: false });
});

test("never falls back when an installed original is a symlink or incomplete", async (t) => {
  const { root, web, home } = await fixture(t);
  const legacy = await legacyFixture(root, home);
  const original = join(web, "node_modules/.pi-meta-original");
  await symlink(legacy, original);
  assert.throws(() => resolveOriginalPi(web, home), /original|symlink/i);
  await rm(original);
  await mkdir(original);
  assert.throws(() => resolveOriginalPi(web, home), /original|ENOENT/i);
});

test("requires an absolute Web directory and refuses a missing original", async (t) => {
  const { web, home } = await fixture(t);
  assert.throws(() => resolveOriginalPi("relative-web", home), /absolute/i);
  assert.throws(() => resolveOriginalPi(web, home), /original|ENOENT/i);
});
