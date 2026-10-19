import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareWorkspaceFixture } from "./workspace-design.mjs";

export function prepareReadingPolishFixture(agentDir) {
  const fixture = prepareWorkspaceFixture(agentDir);
  mkdirSync(join(fixture.project, "components"), { recursive: true });
  writeFileSync(join(fixture.project, "components", "很长的组件文件名-reading-layout.tsx"), "export const readingLayout = true;\n");
  const path = join(agentDir, "sessions/design/workspace-design-fixture.jsonl");
  const entries = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  const answer = entries.find(entry => entry.id === "answer");
  answer.message.content[0].text = [
    "# 把功夫放在细节里",
    "好的界面让内容先被看见。保持已有功能，用准确的间距、稳定的对齐和自然的反馈，减少操作时的犹豫。",
    "## 一个更安静的工作界面",
    "**清晰的重点，不需要更多装饰。** 中文与 English 混排时，标题、正文和代码各有自己的节奏。",
    "### 阅读与工作",
    "- 保留置顶、搜索和分组\n- 文件操作仍然直接可达\n  - 长文件名截断，完整路径可查看\n  - 子目录保持原来的缩进关系",
    "### 代码与数据",
    "```ts\nconst preferences = { theme: 'unchanged', fontSize: 'user choice', pinnedConversations: 'preserved' };\n```",
    "| 项目 | 状态 |\n| --- | --- |\n| 阅读层级 | 清晰而克制 |\n| 文件操作 | 保留原有入口 |",
    "## 动效服务于操作",
    "侧栏展开与收起保持衔接，不延长等待。开启减少动态效果时直接到达目标状态。",
    "1. 找到内容\n2. 查看结果\n3. 继续工作",
  ].join("\n\n");
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return fixture;
}

// Use after runWorkspaceDesignChecks on the same isolated page: its runtime
// routes intercept all model commands; only the temporary fixture is mutated.
export async function runReadingPolishChecks(page, { baseURL, outputDir, project }) {
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw new Error("Candidate port required");
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const checks = [];
  const screenshots = [];
  const shot = async name => {
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
    const path = `${outputDir}/${name}.png`;
    await page.screenshot({ path });
    screenshots.push(path);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
  const answer = page.locator(".conversation-transition .markdown-assistant-message").filter({ has: page.getByRole("heading", { name: "把功夫放在细节里", exact: true }) });
  await answer.waitFor();
  const metrics = await answer.evaluate(node => {
    const style = getComputedStyle(node);
    return {
      fontSize: parseFloat(style.fontSize),
      fontFamily: style.fontFamily,
      headings: ["h1", "h2", "h3"].map(selector => parseFloat(getComputedStyle(node.querySelector(selector)).fontSize)),
      firstMargin: getComputedStyle(node.firstElementChild).marginTop,
      paragraphGap: parseFloat(getComputedStyle(node.querySelector("p")).marginBottom),
      strong: getComputedStyle(node.querySelector("strong")).fontWeight,
      frame: [style.borderTopWidth, style.paddingTop, style.backgroundColor],
    };
  });
  check(metrics.headings[0] > metrics.headings[1] && metrics.headings[1] > metrics.headings[2] && metrics.headings[2] > metrics.fontSize, "Heading hierarchy must be distinct from body text");
  check(metrics.firstMargin === "0px", "First heading must not add leading whitespace");
  check(metrics.paragraphGap > 8, "Paragraphs need more separation than the old 8px rhythm");
  check(metrics.strong === "800", "Existing emphasis weight is preserved");
  check(metrics.frame[0] === "0px" && metrics.frame[1] === "0px" && metrics.frame[2] === "rgba(0, 0, 0, 0)", "Answers remain unframed");
  checks.push("reading: h1 > h2 > h3 > body, paragraph rhythm, no leading gap, emphasis and unframed answers preserved");

  const preferenceResult = await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--chat-content-font-size", "20px");
    const node = [...document.querySelectorAll(".conversation-transition .markdown-assistant-message")].find(node => node.querySelector("h1"));
    const result = { body: getComputedStyle(node).fontSize, h1: getComputedStyle(node.querySelector("h1")).fontSize };
    root.style.removeProperty("--chat-content-font-size");
    return result;
  });
  check(preferenceResult.body === "20px" && preferenceResult.h1 === "30px", "Headings must scale with the user's font size");
  checks.push("preferences: heading scale follows custom body size without changing stored preferences");

  const row = page.locator("#session-sidebar .file-explorer-row").filter({ has: page.getByTitle(`${project}/components`, { exact: true }) });
  await row.waitFor();
  const rowStyle = await row.evaluate(node => ({ height: getComputedStyle(node).height, radius: getComputedStyle(node).borderRadius }));
  check(rowStyle.height === "28px" && rowStyle.radius === "6px", "File rows share comfortable geometry");
  await row.click();
  await page.locator("#session-sidebar").getByTitle(`${project}/components/很长的组件文件名-reading-layout.tsx`, { exact: true }).waitFor();
  await row.hover();
  check(await row.locator("button").count() > 0, "File row actions remain available on hover");
  await page.mouse.move(1100, 100);
  checks.push("files: consistent row geometry, folder expansion, long name and hover actions preserved");

  await page.locator('a.session-tree-main[href*="session=workspace-design-fixture"]').first().hover();
  const unpin = page.getByRole("button", { name: "取消置顶", exact: true });
  if (await unpin.count()) await unpin.first().click();
  await page.getByRole("button", { name: "置顶", exact: true }).first().click();
  await page.locator(".session-tree-pinned-toggle").waitFor();
  check(await page.locator(".session-tree-pinned-toggle").isVisible(), "Pinned conversations remain visible");
  checks.push("navigation: pin action and pinned conversation section preserved");

  const selectTheme = async theme => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-section-tabs").getByRole("button", { name: "常规", exact: true }).click();
    await page.locator(`input[name="theme"][value="${theme}"]`).locator("..").click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.keyboard.press("Escape");
  };
  for (const theme of ["claude-white", "dark"]) {
    await selectTheme(theme);
    await page.getByRole("heading", { name: "把功夫放在细节里", exact: true }).scrollIntoViewIfNeeded();
    await shot(`reading-${theme}-1440`);
  }
  await selectTheme("claude-white");

  const left = page.locator("[data-sidebar-toggle]");
  const right = page.locator("[data-right-panel-toggle]");
  const position = () => page.locator(".chat-input-shell").first().evaluate(node => node.getBoundingClientRect().x);
  await left.click();
  await page.mouse.move(900, 100);
  await page.waitForFunction(() => document.querySelector("#session-sidebar").getBoundingClientRect().width < 1);
  const beforePreview = await position();
  await left.hover();
  await page.locator("#session-sidebar.sidebar-preview").waitFor();
  check(Math.abs(await position() - beforePreview) < 1, "Hover preview must not shift the chat");
  await page.mouse.move(900, 100);
  await page.waitForFunction(() => !document.querySelector(".sidebar-preview, .sidebar-preview-exiting"));
  check(Math.abs(await position() - beforePreview) < 1, "Preview exit must not jump back into layout");
  await left.click();
  await page.mouse.move(900, 100);
  await page.waitForFunction(() => document.querySelector("#session-sidebar").getBoundingClientRect().width >= 259);
  await right.hover();
  await page.locator("#file-panel.right-panel-preview").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".right-panel-preview, .right-panel-preview-exiting"));
  await page.mouse.move(900, 100);
  checks.push("motion: left preview entry/exit without layout shift, right preview dismisses with Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const durations = await page.evaluate(() => [...document.querySelectorAll(".sidebar-container, .sidebar-overlay-backdrop, .right-panel-container, .right-panel-overlay-backdrop, .composer-entry, .file-explorer-chevron")].map(node => getComputedStyle(node).transitionDuration));
    check(durations.every(value => value.split(",").every(part => parseFloat(part) === 0)), `Reduced motion must disable all changed transitions at ${width}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}`);
    check(await answer.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Answer overflow at ${width}`);
    if (width === 390) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".sidebar-overlay-backdrop")).opacity === "0");
      await page.getByRole("heading", { name: "把功夫放在细节里", exact: true }).scrollIntoViewIfNeeded();
      await shot("reading-mobile-390");
    }
  }
  checks.push("accessibility: reduced motion and no page/answer overflow at 1440/820/390");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const options = page.locator("[data-composer-options-trigger]");
  await options.focus();
  await page.keyboard.press("Enter");
  await page.locator(".composer-options").waitFor();
  await page.keyboard.press("Escape");
  check(await options.evaluate(node => node === document.activeElement), "Keyboard dismissal restores focus");
  checks.push("keyboard: composer settings open with Enter and restore focus on Escape");
  return { passed: true, checks, screenshots, metrics, rowStyle, preferenceResult, mocked: true, modelRequests: 0 };
}
