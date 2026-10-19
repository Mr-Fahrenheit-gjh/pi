import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { PendingReleasePanel } = await jiti.import("./PendingReleasePanel.tsx");
const { SubagentFleetPanel } = await jiti.import("./SubagentFleetPanel.tsx");
const { normalizeFleetView, fleetCostText, fleetStateLabel } = await jiti.import("../lib/subagent-fleet-view.ts");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { interpolateMessage } = await jiti.import("../lib/i18n/format.ts");
const { default: ts } = await jiti.import("typescript");
const render = (component, props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));

test("requested navigation and composer labels are English", () => {
  for (const [key, text] of Object.entries({ "sidebar.tabFiles": "Document", "sidebar.pinned": "Pinned", "sidebar.new": "New", "workspace.todos": "Tasks", "common.agents": "Sub-agents", "chat.compact": "Compact", "chat.collapseControls": "Collapse controls", "chat.disableSound": "Disable completion sound" })) assert.equal(enLocale.messages[key], text);
  assert.match(enLocale.messages["sidebar.searchSessions"], /^Search all conversations/);
});

test("pending release chrome is English while entry titles, summaries and evidence remain original", () => {
  const entry = { id: "test", title: "中文标题", summary: "中文摘要", status: "pending", scope: "extension", revision: 1,
    createdAt: "2026-10-19", sourceSessions: ["中文来源"], codeLocations: ["中文目录"], verification: ["中文验证"], releaseSteps: ["中文步骤"], rollback: ["中文回退"], dependencies: [] };
  const html = render(PendingReleasePanel, { snapshot: { entries: [entry], warnings: [], pendingCount: 1 }, loading: false, error: null, onClose() {}, onRefresh() {} });
  for (const value of ["Pending releases", "Extension", "View details", "Copy handoff", "Source session", "中文标题", "中文摘要", "中文来源", "中文目录", "中文验证", "中文步骤", "中文回退"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /待上线|查看详情|复制交接说明/);
});

test("sub-agent panel chrome is English and generated labels do not rewrite tasks or records", () => {
  const html = render(SubagentFleetPanel, { sessionId: "fixture" });
  assert.match(html, /Sub-agent tasks/); assert.match(html, /Usage &amp; cost/); assert.doesNotMatch(html, /子任务|刷新中/);
  const raw = { available: true, text: "子代理中文输出", asyncSnapshot: { runs: [{ id: "run-a", label: "检查中文文件", role: "中文角色", state: "running", goal: "保留中文活动", usage: { input: 5 } }] } };
  const before = JSON.stringify(raw);
  const view = normalizeFleetView(raw);
  assert.equal(view.text, "子代理中文输出"); assert.equal(view.runs[0].label, "检查中文文件"); assert.equal(view.runs[0].role, "中文角色"); assert.equal(view.runs[0].activity, "保留中文活动");
  assert.equal(fleetStateLabel(view.runs[0].state), "Running"); assert.deepEqual(view.runs[0].metrics, [{ label: "Input", value: 5 }]); assert.equal(JSON.stringify(raw), before);
  const t = (key, params) => interpolateMessage(zhCNLocale.messages[key], params);
  assert.equal(fleetStateLabel("running", t), "运行中"); assert.equal(normalizeFleetView(raw, t).runs[0].label, "检查中文文件");
  const cost = fleetCostText({ children: [{ label: "中文子任务", usage: { input: 3 } }], unresolvedAsyncChildren: 1 });
  assert.match(cost, /Main session/); assert.match(cost, /中文子任务: 3 tokens/); assert.match(cost, /Unresolved task usage: 1/);
  assert.match(fleetCostText({ parent: { input: 3 } }, t, "zh-CN"), /主会话: 3 tokens/);
});

test("foreground labels are localized and cost views keep raw data for live locale changes", () => {
  const hook = readFileSync(new URL("../hooks/usePackageSubagents.ts", import.meta.url), "utf8");
  assert.match(hook, /id: "package:foreground", label: t\("agentPicker\.foreground"\)/);
  assert.match(hook, /role: t\("agentSwitcher\.subagent"\)/);
  const fleet = readFileSync(new URL("./SubagentFleetPanel.tsx", import.meta.url), "utf8");
  assert.match(fleet, /setCostData\(data\)/);
  assert.match(fleet, /fleetCostText\(costData, t, locale\)/);
  assert.match(fleet, /normalizeFleetView\(viewData, t\)/);
  assert.match(fleet, /\[costData, costError, t, locale\]/);
  assert.match(fleet, /\}, \[sessionId\]\);/);
});

test("all application TSX chrome has no hard-coded Chinese text or accessibility labels", () => {
  const offenders = [];
  for (const file of readdirSync(new URL("./", import.meta.url)).filter(file => file.endsWith(".tsx"))) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = node => {
      if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text)) offenders.push(`${file}: JSX text`);
      if (ts.isJsxAttribute(node) && ["aria-label", "title", "placeholder", "alt"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && /\p{Script=Han}/u.test(node.initializer.text)) offenders.push(`${file}: ${node.name.getText(source)}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  assert.deepEqual(offenders, []);
});
