import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { initializePiMeta } from "./pi-meta-config.mjs";

test("Pi loads the requested existing plugins and grilling from an isolated Meta profile", async (t) => {
  const source = process.env.PI_META_TEST_AGENT_ROOT;
  assert.ok(source, "PI_META_TEST_AGENT_ROOT must point at the existing installed plugins");
  const root = await mkdtemp(join(tmpdir(), "pi-meta-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "main"), meta = join(root, "meta-agent"), cwd = join(root, "project");
  await mkdir(join(main, "npm"), { recursive: true });
  await symlink(join(source, "npm/node_modules"), join(main, "npm/node_modules"));
  await mkdir(join(main, "extensions"), { recursive: true });
  await mkdir(join(main, "skills"), { recursive: true });
  await mkdir(cwd);
  await symlink(join(source, "extensions/codex-speed"), join(main, "extensions/codex-speed"));
  await symlink(join(source, "skills/grilling"), join(main, "skills/grilling"));
  await writeFile(join(main, "settings.json"), "{}");
  await writeFile(join(main, "auth.json"), "{}", { mode: 0o600 });
  await initializePiMeta({ mainAgentDir: main, metaAgentDir: meta, packageDir: fileURLToPath(new URL("..", import.meta.url)) });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = meta;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const session = SessionManager.create(cwd);
  assert.ok(session.getSessionDir().startsWith(join(meta, "sessions") + "/"));
  const services = await createAgentSessionServices({ cwd, agentDir: meta, resourceLoaderOptions: { noContextFiles: true } });
  const result = services.resourceLoader.getExtensions();
  assert.deepEqual(result.errors.map(error => `${error.path}: ${error.error}`), []);
  const tools = new Set(result.extensions.flatMap(extension => [...extension.tools.keys()]));
  const commands = new Set(result.extensions.flatMap(extension => [...extension.commands.keys()]));
  for (const tool of ["web_enable", "ask_user_question", "todo"]) assert.ok(tools.has(tool), `missing ${tool}`);
  assert.ok(!tools.has("subagent"));
  assert.ok(commands.has("fast"));
  assert.ok(services.resourceLoader.getSkills().skills.some(skill => skill.name === "grilling"));
});

test("Meta selects the default prompt without workspace rules or skills", async (t) => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(rpc, /piMeta \? \{\s*noSkills: true,\s*noContextFiles: true,\s*systemPromptOverride: \(\) => undefined,\s*appendSystemPrompt: \[\]/);
  assert.match(rpc, /\.\.\.\(piMeta \? \[\] : \[\s*createInlineVisualExtension/);
  const root = await mkdtemp(join(tmpdir(), "pi-meta-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi", "skills", "fixture"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(cwd, "AGENTS.md"), "WORKSPACE_RULE_FIXTURE");
  await writeFile(join(cwd, ".pi", "SYSTEM.md"), "SYSTEM_OVERRIDE_FIXTURE");
  await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "APPEND_FIXTURE");
  await writeFile(join(cwd, ".pi", "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: fixture skill\n---\nfixture");
  const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
    noSkills: true, noContextFiles: true, systemPromptOverride: () => undefined, appendSystemPrompt: [],
  } });
  assert.deepEqual(services.resourceLoader.getSkills().skills, []);
  assert.deepEqual(services.resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.equal(services.resourceLoader.getSystemPrompt(), undefined);
  assert.deepEqual(services.resourceLoader.getAppendSystemPrompt(), []);
});
