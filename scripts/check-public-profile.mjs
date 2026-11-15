#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const restrictedSkills = ["claude-design", "claude-slides", "claude-design-system", "claude-dashboard", "dataviz"];
const prohibited = /(^|\/)(?:node_modules|\.git|\.api-key|auth\.json|mcp-auth\.json|credentials?\.json|secrets?\.json|sessions|memories|daily|backups|__pycache__)(\/|$)|\.(?:jsonl|sqlite3?|db|pem|key|pyc)$/i;

function inventory(root, current = root) {
  const result = {};
  const info = lstatSync(current);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Not a regular source directory: ${current}`);
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const key = relative(root, path).replaceAll("\\", "/");
    assert.doesNotMatch(key, prohibited, `Private or generated material: ${key}`);
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), `Source link is not distributable: ${key}`);
    if (info.isDirectory()) Object.assign(result, inventory(root, path));
    else {
      assert.ok(info.isFile(), `Not a regular source file: ${key}`);
      if (key === "manifest.json") continue;
      const bytes = readFileSync(path);
      assert.doesNotMatch(bytes.toString("utf8"), /\/Users\/guojiahang\//, `Unexpanded author path: ${key}`);
      result[key] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return result;
}

export function checkPublicProfile({ repoRoot = repository, write = false } = {}) {
  const root = join(repoRoot, "public-config");
  const actual = inventory(root);
  for (const path of ["agent/APPEND_SYSTEM.md", "agent/rules/execution.md", "agent/rules/delegation.md", "agent/skills/grilling/SKILL.md", "agent/skills/pstack/entry/SKILL.md", "agent/settings.template.json", "workspace/AGENTS.md", "sources.json"]) {
    assert.ok(actual[path], `Required public configuration missing: ${path}`);
  }
  for (const role of ["delegate", "scout", "worker", "reviewer", "oracle", "researcher", "evidence-auditor"]) assert.ok(actual[`agent/agents/${role}.md`], `Missing agent role: ${role}`);
  for (const name of restrictedSkills) assert.ok(!Object.keys(actual).some(path => path.startsWith(`agent/skills/${name}/`)), `Do not redistribute restricted skill: ${name}`);
  const settings = JSON.parse(readFileSync(join(root, "agent/settings.template.json"), "utf8"));
  assert.ok(Object.keys(settings).every(key => ["packages", "extensions", "skills", "prompts", "subagents"].includes(key)), "Only portable resource declarations belong in the profile, not author settings");
  const manifest = { schemaVersion: 1, algorithm: "sha256", files: actual };
  const path = join(root, "manifest.json");
  if (write) writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  else assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), manifest, "Public configuration changed: review it and regenerate its manifest");
  return { files: Object.keys(actual).length, roles: 7, restrictedSkills: "sources and patch only" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.every(argument => argument === "--write"), "Only --write is supported");
    console.log(JSON.stringify(checkPublicProfile({ write: args.includes("--write") })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
