import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = /pi[-_]meta|fey(?:n)?man/i;

test("public current tree contains no private runtime implementations or routes", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const blocked = paths.filter(path => excluded.test(path) || path.startsWith("app/api/runtime/meta/") || path.startsWith("app/api/service/meta-deployment/"));
  assert.deepEqual(blocked, [], "Do not export machine-specific runtimes in the public distribution");
});

test("public UI and native clients do not offer removed runtimes", () => {
  for (const file of ["lib/runtime-client.mjs", "lib/runtime-client.d.mts", "lib/service-restart.ts", "components/ServiceRestartButton.tsx"]) {
    assert.equal(existsSync(new URL("../" + file, import.meta.url)), false, `${file} must remain removed`);
  }
  for (const file of ["components/AppShell.tsx", "lib/agent-client.ts", "lib/browser-client.ts"]) {
    const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.doesNotMatch(source, excluded, file);
    assert.doesNotMatch(source, /\/api\/runtime\/|\/api\/service\/restart/, file);
  }
});
