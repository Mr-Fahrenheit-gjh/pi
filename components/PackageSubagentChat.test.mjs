import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { PackageSubagentChat } = await jiti.import("./PackageSubagentChat.tsx");

test("child transcript has no redundant toolbar in running or completed state", () => {
  for (const state of ["running", "complete"]) {
    const html = renderToStaticMarkup(React.createElement(PackageSubagentChat, {
      session: { id: "parent", cwd: "/fixture" },
      target: { id: "child", runId: "run", index: 0, label: "final-review", state },
    }));
    assert.match(html, /aria-label="子代理记录"/);
    assert.match(html, /正在读取子代理记录/);
    assert.doesNotMatch(html, /返回主代理|输入仍发给主代理|刷新|final-review|<button/);
  }
});

test("automatic refresh stays read-only and selection lives in the right workspace", () => {
  const child = readFileSync(new URL("./PackageSubagentChat.tsx", import.meta.url), "utf8");
  assert.match(child, /setInterval\(\(\) => void load\(\), 2000\)/);
  assert.match(child, /visibilitychange/);
  assert.match(child, /controller\?\.abort\(\)/);
  assert.doesNotMatch(child, /setRefresh|onReturn|fleetStateLabel/);
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<AgentWorkspace/);
  assert.doesNotMatch(shell, /setPackageSelection|data-agent-switcher-panel/);
  const workspace = readFileSync(new URL("./AgentWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /const choose = \(id: string\) => \{ setSelection\(id\); setOpen\(false\); trigger\.current\?\.focus\(\); \}/);
  assert.match(workspace, /role="option"[^\n]*onClick=\{\(\) => choose\(item\.id\)\}/);
  assert.doesNotMatch(workspace, /handleSelectSession|onSend|startRpcSession/);
});
