import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const selectedAnswer = [
  "Selected upstream preview fixture",
  "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 80 40\"><rect width=\"80\" height=\"40\" fill=\"#336699\"/><script>alert(1)</script></svg>\n```",
].join("\n\n");

// Run on quiet-tools' existing isolated page, never against the live profile.
export async function installSelectedRoutes(page, project) {
  let allRequests = 0;
  let defaultsWritten = 0;
  await page.route("**/api/models?**", (route) => {
    const all = new URL(route.request().url()).searchParams.get("scope") === "all";
    if (all) allRequests++;
    return route.fulfill({ json: {
      models: { "test:test": "Scoped fixture", ...(all ? { "test:outside": "Outside fixture" } : {}) },
      modelList: [
        { provider: "test", id: "test", name: "Scoped fixture" },
        ...(all ? [{ provider: "test", id: "outside", name: "Outside fixture" }] : []),
      ],
      defaultModel: { provider: "test", modelId: "test" },
      isScoped: !all,
    } });
  });
  await page.route("**/api/models/default", (route) => {
    defaultsWritten++;
    return route.fulfill({ status: 400, json: { error: "Fixture forbids changing defaults" } });
  });
  await page.route("**/api/git/status?**", (route) => route.fulfill({ json: {
    isGitRepository: true, repositoryRoot: project, additions: 1, deletions: 1,
    files: [
      { filePath: `${project}/foo`, status: "deleted", code: "D", indexStatus: " ", worktreeStatus: "D" },
      { filePath: `${project}/foo/bar.txt`, status: "untracked", code: "U", indexStatus: "?", worktreeStatus: "?" },
    ],
  } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { window.__selectedCopiedText = text; },
    } });
  });
  return { allRequests: () => allRequests, defaultsWritten: () => defaultsWritten };
}

export async function checkSelectedUi(page, project, routes) {
  const svg = page.locator(".svg-block-image");
  await svg.waitFor();
  assert.equal(await svg.evaluate((img) => img.complete && img.naturalWidth > 0), true);
  const data = await svg.getAttribute("src");
  const clean = decodeURIComponent(data.slice(data.indexOf(",") + 1));
  assert.ok(clean.includes("rect"));
  assert.doesNotMatch(clean, /<script|onload=/i);
  const svgFrame = page.locator(".markdown-code-block").filter({ has: page.locator(".markdown-code-lang").filter({ hasText: /^svg$/ }) }).first();
  await svgFrame.getByTitle("显示 SVG 源码", { exact: true }).click();
  await svgFrame.locator("pre").waitFor();
  await svgFrame.getByTitle("预览 SVG 图片", { exact: true }).click();
  await page.getByRole("button", { name: "打开图片查看器", exact: true }).click();
  const zoom = page.getByRole("dialog", { name: "SVG 图片查看器", exact: true });
  await zoom.waitFor();
  await zoom.press("Escape");
  await zoom.waitFor({ state: "hidden" });
  const downloaded = page.waitForEvent("download");
  await svgFrame.getByRole("button", { name: /下载.*SVG/ }).click();
  const download = await downloaded;
  const contents = await readFile(await download.path(), "utf8");
  assert.ok(contents.includes("rect"));
  assert.doesNotMatch(contents, /<script|onload=/i);

  const math = page.locator(".markdown-assistant-message blockquote .markdown-math-display");
  await math.getByRole("button", { name: "复制", exact: true }).click();
  const copied = await page.evaluate(() => window.__selectedCopiedText);
  assert.ok(copied.includes("\\sum_{n=N}^{\\infty}"));
  assert.ok(copied.includes("\\boxed{"));

  await page.locator("[data-model-selector-trigger]").first().click();
  const list = page.getByRole("listbox").last();
  await list.getByRole("button", { name: "已限定", exact: true }).waitFor();
  assert.equal(await list.getByRole("option").filter({ hasText: "Outside fixture" }).count(), 0);
  await list.getByRole("button", { name: "全部", exact: true }).click();
  const outside = list.getByRole("option").filter({ hasText: "Outside fixture" });
  await outside.waitFor();
  assert.equal(await outside.locator("button").count(), 0, "Outside-scope models cannot become defaults");
  await list.getByRole("textbox", { name: "筛选模型…", exact: true }).press("Tab");
  assert.equal(await list.getByRole("button", { name: "已限定", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await outside.count(), 0);
  await list.press("Escape");
  assert.ok(routes.allRequests() >= 1);
  assert.equal(routes.defaultsWritten(), 0);

  const sidebar = page.locator("#session-sidebar");
  if (!await sidebar.isVisible()) await page.locator("[data-sidebar-toggle]").first().click();
  const files = page.locator("#session-sidebar-panel-files");
  const sectionToggle = files.locator(".sidebar-files-section-toggle");
  if (await sectionToggle.count() && await sectionToggle.getAttribute("aria-expanded") !== "true") await sectionToggle.click();
  // Changes is an existing alternate view, collapsed by default in the custom sidebar.
  await files.getByRole("button", { name: "2 个变更文件", exact: true }).click();
  const tree = files.getByRole("button", { name: "树状视图", exact: true });
  await tree.waitFor();
  await tree.click();
  const bar = files.locator(`.file-explorer-row[title="${project}/foo/bar.txt"]`);
  await bar.waitFor();
  await files.locator(`.file-explorer-row[title="${project}/foo"]`).waitFor();
  const folder = files.locator('div[title="foo"]').filter({ has: page.locator(".file-explorer-chevron") });
  await folder.click();
  await bar.waitFor({ state: "hidden" });
  await folder.click();
  await bar.waitFor();
  await files.getByRole("button", { name: "列表视图", exact: true }).click();
  await tree.waitFor();
  await bar.waitFor();
  console.log("PASS: selected upstream SVG preview/source/zoom/safe download, LaTeX clipboard, model scope/Tab, and lossless Git tree/list");
}
