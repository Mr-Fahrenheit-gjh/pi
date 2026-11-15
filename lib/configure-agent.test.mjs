import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyConfiguration, planConfiguration, renderTemplate } from "../bin/configure-agent.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi public profile ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo space");
  const target = join(root, "agent");
  const workspace = join(root, "project");
  const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  write(join(repoRoot, "public-config/agent/APPEND_SYSTEM.md"), "Read {{AGENT_DIR}}/rules/execution.md; repo {{REPO_ROOT}}\n");
  write(join(repoRoot, "public-config/agent/rules/execution.md"), "execution\n");
  write(join(repoRoot, "public-config/agent/agents/worker.md"), "---\nname: worker\n---\nRead only when requested.\n");
  write(join(repoRoot, "public-config/agent/skills/grilling/SKILL.md"), "---\nname: grilling\n---\nConfirm decisions.\n");
  write(join(repoRoot, "public-config/agent/skills/grilling/example.png"), Buffer.from([137, 80, 78, 71, 0, 255, 128]));
  write(join(repoRoot, "public-config/agent/extensions/example.ts"), "export default function() {}\n");
  write(join(repoRoot, "public-config/agent/settings.template.json"), JSON.stringify({ packages: [{ source: "npm:example@1.0.0", extensions: [] }, "{{REPO_ROOT}}/tools/example"], extensions: ["-{{AGENT_DIR}}/extensions/disabled.ts"] }));
  write(join(repoRoot, "public-config/workspace/AGENTS.md"), "Project rules.\n");
  return { root, repoRoot, target, workspace, write };
}

test("configuration plan is offline and read-only; application expands paths and is idempotent", t => {
  const f = fixture(t);
  const options = { repoRoot: f.repoRoot, target: f.target };
  const plan = planConfiguration(options);
  assert.equal(plan.length, 5);
  assert.equal(readdirSync(f.root).includes("agent"), false);
  applyConfiguration(plan);
  assert.match(readFileSync(join(f.target, "APPEND_SYSTEM.md"), "utf8"), /agent\/rules\/execution\.md/);
  assert.doesNotMatch(readFileSync(join(f.target, "APPEND_SYSTEM.md"), "utf8"), /\{\{/);
  assert.deepEqual(readFileSync(join(f.target, "skills/grilling/example.png")), Buffer.from([137, 80, 78, 71, 0, 255, 128]));
  assert.equal(readdirSync(f.target).includes("settings.json"), false);
  assert.equal(readdirSync(f.target).includes("extensions"), false);
  assert.ok(planConfiguration(options).every(file => file.status === "unchanged"));
  applyConfiguration(planConfiguration(options));
});

test("extension import preserves package filters and disabled entries without running code", t => {
  const f = fixture(t);
  applyConfiguration(planConfiguration({ repoRoot: f.repoRoot, target: f.target, withExtensions: true }));
  const settings = JSON.parse(readFileSync(join(f.target, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0], { source: "npm:example@1.0.0", extensions: [] });
  assert.equal(settings.packages[1], f.repoRoot.replaceAll("\\", "/") + "/tools/example");
  assert.equal(settings.extensions[0], "-" + f.target.replaceAll("\\", "/") + "/extensions/disabled.ts");
});

test("different existing files abort before the first write and leave user data untouched", t => {
  const f = fixture(t);
  f.write(join(f.target, "rules/execution.md"), "user rules\n");
  f.write(join(f.target, "auth.json"), "private-user-fixture");
  const plan = planConfiguration({ repoRoot: f.repoRoot, target: f.target });
  assert.throws(() => applyConfiguration(plan), /未修改任何配置/);
  assert.deepEqual(readdirSync(f.target).sort(), ["auth.json", "rules"]);
  assert.equal(readFileSync(join(f.target, "auth.json"), "utf8"), "private-user-fixture");
  assert.equal(readFileSync(join(f.target, "rules/execution.md"), "utf8"), "user rules\n");
});

test("workspace rules are written only to an explicitly selected workspace", t => {
  const f = fixture(t);
  applyConfiguration(planConfiguration({ repoRoot: f.repoRoot, target: f.target, workspace: f.workspace }));
  assert.equal(readFileSync(join(f.workspace, "AGENTS.md"), "utf8"), "Project rules.\n");
  assert.equal(readdirSync(f.target).includes("AGENTS.md"), false);
  assert.equal(readdirSync(f.repoRoot).includes("AGENTS.md"), false);
});

test("source and destination directory links cannot redirect import", t => {
  const f = fixture(t);
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(f.target);
  symlinkSync(elsewhere, join(f.target, "rules"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => planConfiguration({ repoRoot: f.repoRoot, target: f.target }), /符号链接/);
  assert.deepEqual(readdirSync(elsewhere), []);
  unlinkSync(join(f.target, "rules"));
  const sourceRules = join(f.repoRoot, "public-config/agent/rules");
  rmSync(sourceRules, { recursive: true });
  symlinkSync(elsewhere, sourceRules, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => planConfiguration({ repoRoot: f.repoRoot, target: f.target }), /普通目录|符号链接/);
});

test("changes between planning and applying are not overwritten", t => {
  const f = fixture(t);
  const plan = planConfiguration({ repoRoot: f.repoRoot, target: f.target });
  f.write(join(f.target, "APPEND_SYSTEM.md"), "new user prompt");
  assert.throws(() => applyConfiguration(plan), /目标已变化/);
  assert.equal(readFileSync(join(f.target, "APPEND_SYSTEM.md"), "utf8"), "new user prompt");
  assert.deepEqual(readdirSync(f.target), ["APPEND_SYSTEM.md"]);
});

test("replacing an ancestor immediately before open cannot redirect a write", t => {
  const f = fixture(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const plan = planConfiguration({ repoRoot: f.repoRoot, target: f.target });
  const original = fs.openSync;
  let attempted = false;
  let blockedByOS = false;
  let failure;
  fs.openSync = (path, flags, ...args) => {
    if (!attempted && flags === "wx") {
      attempted = true;
      try {
        renameSync(f.target, f.target + "-selected");
        symlinkSync(outside, f.target, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        blockedByOS = true;
      }
    }
    return original(path, flags, ...args);
  };
  syncBuiltinESMExports();
  try { applyConfiguration(plan); } catch (error) { failure = error; }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(attempted, true);
  assert.deepEqual(readdirSync(outside), [], "No payload or empty file may be created outside the selected directory identity");
  if (!blockedByOS) assert.match(failure?.message ?? "", /符号链接|变化/);
});

test("target must be explicit and Windows template paths remain parseable JSON", t => {
  const f = fixture(t);
  assert.throws(() => planConfiguration({ repoRoot: f.repoRoot }), /必须显式指定/);
  assert.equal(renderTemplate("{{REPO_ROOT}} | {{AGENT_DIR}}", { repoRoot: "C:\\repo space", agentDir: "D:\\pi agent" }), "C:/repo space | D:/pi agent");
});
