import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initializePiMeta } from "./pi-meta-config.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "agent");
  const packages = ["pi-web-access", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo"];
  for (const name of packages) await mkdir(join(main, "npm/node_modules", name), { recursive: true });
  await mkdir(join(main, "extensions/codex-speed"), { recursive: true });
  await mkdir(join(main, "skills/grilling"), { recursive: true });
  await writeFile(join(main, "extensions/codex-speed/index.ts"), "// fixture");
  await writeFile(join(main, "skills/grilling/SKILL.md"), "---\nname: grilling\n---\nfixture");
  await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model", packages: ["unwanted"], theme: "unwanted" }));
  await writeFile(join(main, "auth.json"), "{\"fixture\":true}", { mode: 0o600 });
  await writeFile(join(main, "models.json"), "{\"fixtureModels\":true}", { mode: 0o600 });
  await writeFile(join(main, "mcp.json"), JSON.stringify({ mcpServers: { tushareMcp: { enabled: false }, other: { enabled: true } } }), { mode: 0o600 });
  return { root, main, meta: join(root, "meta-agent"), packages };
}

test("initializes only requested packages, Fast and MCP protection without changing the source", async (t) => {
  const { main, meta, packages } = await fixture(t);
  const before = await readFile(join(main, "settings.json"), "utf8");
  assert.equal(await initializePiMeta({ mainAgentDir: main, metaAgentDir: meta, packageDir }), meta);
  const settings = JSON.parse(await readFile(join(meta, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, packages.map(name => join(main, "npm/node_modules", name)));
  assert.deepEqual(settings.extensions, [join(main, "extensions/codex-speed/index.ts"), join(packageDir, "bin/pi-meta-mcp-permissions.ts")]);
  assert.deepEqual(settings.skills, [join(main, "skills/grilling")]);
  assert.equal(settings.defaultProvider, "fixture");
  assert.equal(settings.defaultModel, "fixture-model");
  assert.equal(settings.theme, undefined);
  assert.equal(await readFile(join(main, "settings.json"), "utf8"), before);
  assert.equal(await readlink(join(meta, "auth.json")), join(main, "auth.json"));
  assert.deepEqual(JSON.parse(await readFile(join(meta, "mcp.json"), "utf8")), { mcpServers: { tushareMcp: { enabled: false } } });
  assert.equal(await readFile(join(meta, "models.json"), "utf8"), await readFile(join(main, "models.json"), "utf8"));
  assert.equal((await lstat(meta)).mode & 0o077, 0);
  assert.equal((await lstat(join(meta, "mcp.json"))).mode & 0o077, 0);
});

test("MCP OAuth tokens remain independent when Tushare configuration is copied", async (t) => {
  const { main, meta } = await fixture(t);
  await writeFile(join(main, "mcp-auth.json"), '{"fixture":"private"}', { mode: 0o600 });
  await initializePiMeta({ mainAgentDir: main, metaAgentDir: meta, packageDir });
  assert.deepEqual(JSON.parse(await readFile(join(meta, "mcp.json"), "utf8")), { mcpServers: { tushareMcp: { enabled: false } } });
  await assert.rejects(lstat(join(meta, "mcp-auth.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(main, "mcp-auth.json"), "utf8"), '{"fixture":"private"}');
});

test("reuse preserves independent Meta settings and refuses unrecognized or symlinked directories", async (t) => {
  const { root, main, meta } = await fixture(t);
  await initializePiMeta({ mainAgentDir: main, metaAgentDir: meta, packageDir });
  await writeFile(join(meta, "settings.json"), "{\"changed\":true}");
  await initializePiMeta({ mainAgentDir: main, metaAgentDir: meta, packageDir });
  assert.equal(await readFile(join(meta, "settings.json"), "utf8"), "{\"changed\":true}");
  const foreign = join(root, "foreign");
  await mkdir(foreign, { mode: 0o700 });
  await assert.rejects(initializePiMeta({ mainAgentDir: main, metaAgentDir: foreign, packageDir }), /unrecognized/i);
  const link = join(root, "link");
  await symlink(meta, link);
  await assert.rejects(initializePiMeta({ mainAgentDir: main, metaAgentDir: link, packageDir }), /directory|symlink/i);
});
