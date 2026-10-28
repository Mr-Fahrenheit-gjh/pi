import assert from "node:assert/strict";
import test from "node:test";
import install, { requiresGithubApproval } from "../bin/pi-meta-mcp-permissions.ts";

test("GitHub delete and merge require interactive approval", async () => {
  let handler;
  install({ on(event, callback) { assert.equal(event, "tool_call"); handler = callback; } });
  for (const name of ["mcp__github__delete_repository", "mcp__github__merge_pull_request", "github_delete_repo", "github_merge_pull_request"]) {
    assert.equal(requiresGithubApproval(name), true);
    assert.match((await handler({ toolName: name }, { hasUI: false })).reason, /approval/i);
    assert.match((await handler({ toolName: name }, { hasUI: true, ui: { confirm: async () => false } })).reason, /approval/i);
    assert.equal(await handler({ toolName: name }, { hasUI: true, ui: { confirm: async () => true } }), undefined);
  }
  assert.equal(requiresGithubApproval("mcp__github__get_repository"), false);
  assert.equal(await handler({ toolName: "mcp__github__get_repository" }, { hasUI: false }), undefined);
});
