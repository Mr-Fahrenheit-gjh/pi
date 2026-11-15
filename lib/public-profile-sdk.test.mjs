import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { applyConfiguration, planConfiguration } from "../bin/configure-agent.mjs";

// An explicit path lets a maintainer reuse an existing matching SDK offline.
// Consumers and CI resolve the SDK from this checkout's locked dependencies.
const sdk = process.env.PI_TEST_SDK_PATH ? pathToFileURL(resolve(process.env.PI_TEST_SDK_PATH)).href : "@earendil-works/pi-coding-agent";

test("a clean SDK actually discovers the imported prompt, project rules and required skills", async t => {
  const { DefaultResourceLoader, SettingsManager } = await import(sdk);
  const root = mkdtempSync(join(tmpdir(), "pi public sdk "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  applyConfiguration(planConfiguration({ target: agentDir, workspace: cwd }));
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  const prompt = loader.getAppendSystemPrompt().join("\n");
  assert.match(prompt, /沟通与执行/);
  assert.match(prompt, /ask_user_question/);
  assert.match(prompt, /grilling/);
  assert.doesNotMatch(prompt, /\/Users\/guojiahang\/|\{\{(?:REPO_ROOT|AGENT_DIR)\}\}/);
  assert.ok(loader.getAgentsFiles().agentsFiles.some(file => file.content.includes("工作区约定")));
  const skills = new Set(loader.getSkills().skills.map(skill => skill.name));
  for (const name of ["grilling", "pstack", "frontend-design", "browser-harness", "mcp-wiring"]) assert.ok(skills.has(name), `SDK did not discover ${name}`);
  for (const name of ["claude-design", "claude-slides", "claude-design-system", "claude-dashboard", "dataviz"]) assert.equal(skills.has(name), false, `${name} requires separately licensed materials`);
  for (const role of ["delegate", "scout", "worker", "reviewer", "oracle", "researcher", "evidence-auditor"]) assert.match(readFileSync(join(agentDir, "agents", role + ".md"), "utf8"), /\S/);
  assert.deepEqual(loader.getExtensions().errors, []);
});
