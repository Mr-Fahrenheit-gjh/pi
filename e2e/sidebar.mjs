import assert from "node:assert/strict";

/** Isolated fixtures: never launch Finder or touch the real release registry. */
export async function installSidebarActionRoutes(page, project) {
  const opened = [];
  let failOpen = false;
  const entries = Array.from({ length: 15 }, (_, index) => ({
    schemaVersion: 1, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revision: 1, scope: "web", title: `Fixture ${index}`, summary: "Layout fixture", status: "pending",
    sourceSessions: ["fixture"], codeLocations: ["fixture"], verification: ["fixture"],
    releaseSteps: ["fixture"], rollback: ["fixture"], dependencies: [], createdAt: "2026-11-03T00:00:00.000Z",
  }));
  await page.route("**/api/pending-releases", route => route.fulfill({ json: { entries, warnings: [], pendingCount: 15 } }));
  await page.route("**/api/open-in-explorer", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { supported: true, platform: "darwin" } });
    opened.push(route.request().postDataJSON().cwd);
    return route.fulfill({ status: failOpen ? 500 : 200, json: failOpen ? { error: "open_failed" } : { ok: true } });
  });
  await page.route("**/api/git/status?**", route => route.fulfill({ json: {
    isGitRepository: true, repositoryRoot: project, additions: 1, deletions: 0,
    files: [
      { filePath: `${project}/sidebar-fixture.txt`, status: "untracked", code: "U", indexStatus: "?", worktreeStatus: "?" },
      { filePath: `${project}/second-fixture.txt`, status: "untracked", code: "U", indexStatus: "?", worktreeStatus: "?" },
    ],
  } }));
  return { opened, failOpen: value => { failOpen = value; } };
}

/** Direct Finder, secondary Git, and a footer responsive to sidebar—not viewport—width. */
export async function checkSidebarActions(page, project, routes) {
  // Exercise the normal English chrome; quiet-tools resumes in its explicit test locale.
  await page.evaluate(() => localStorage.setItem("pi-locale", "en"));
  await page.reload({ waitUntil: "networkidle" });
  const sidebar = page.locator("#session-sidebar");
  if (!await page.locator("#session-sidebar.sidebar-open").count()) await page.locator("[data-sidebar-toggle]").first().click();
  const files = page.locator("#session-sidebar-panel-files");
  const finder = files.getByRole("button", { name: "Open in Finder", exact: true });
  await finder.click();
  assert.deepEqual(routes.opened, [project]);
  assert.equal(await files.getByRole("button", { name: "2 changed files", exact: true }).count(), 0);
  await files.locator(".sidebar-file-options").click();
  const menu = page.getByRole("menu");
  assert.equal(await menu.getByText("Open in Finder", { exact: true }).count(), 0);
  await menu.getByRole("menuitemcheckbox", { name: "2 changed files", exact: true }).click();
  await files.locator(`.file-explorer-row[title="${project}/sidebar-fixture.txt"]`).waitFor();
  await files.locator(".sidebar-file-options").click();
  assert.equal(await menu.getByRole("menuitemcheckbox", { name: "2 changed files", exact: true }).getAttribute("aria-checked"), "true");
  await menu.press("Escape");
  const toggle = files.locator(".sidebar-files-section-toggle");
  await toggle.click();
  routes.failOpen(true);
  await finder.click();
  await files.getByRole("alert").waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Finder failure reveals the folded files section");
  routes.failOpen(false);

  const footer = sidebar.locator(".workspace-settings-entry");
  await footer.locator(".pending-release-count").getByText("15", { exact: true }).waitFor();
  const viewport = page.viewportSize();
  const originalWidth = await sidebar.evaluate(el => el.style.getPropertyValue("--sidebar-width"));
  for (const width of [180, 220, 260, 320, 420]) {
    await sidebar.evaluate((el, value) => { el.style.setProperty("--sidebar-width", `${value}px`); el.style.transition = "none"; }, width);
    const geometry = await footer.evaluate(el => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { box: rect(el), buttons: [...el.querySelectorAll(":scope > button")].map(button => ({
        box: rect(button), title: button.title, label: button.getAttribute("aria-label"),
        textVisible: getComputedStyle(button.querySelector("span:not(.pending-release-count)")).display !== "none",
        parts: [...button.querySelectorAll(":scope > svg, :scope > span")].filter(part => getComputedStyle(part).display !== "none").map(rect),
      })) };
    });
    assert.equal(geometry.buttons.length, 3);
    for (const [index, button] of geometry.buttons.entries()) {
      assert.ok(button.title && button.label, "Icon-only controls retain their names/tooltips");
      assert.equal(button.textVisible, width >= 320, `Text visibility at sidebar ${width}`);
      assert.ok(button.box.left >= geometry.box.left && button.box.right <= geometry.box.right, `Button stays inside footer at ${width}`);
      if (index) assert.ok(button.box.left >= geometry.buttons[index - 1].box.right, "Buttons never overlap");
      for (const part of button.parts) assert.ok(part.left >= button.box.left - 0.5 && part.right <= button.box.right + 0.5, `Content fits its button at ${width}`);
      for (let i = 1; i < button.parts.length; i++) assert.ok(button.parts[i].left >= button.parts[i - 1].right - 0.5, `Icon, label and count never overlap at ${width}`);
    }
    assert.equal(await footer.locator(".pending-release-count").isVisible(), true);
    assert.deepEqual(page.viewportSize(), viewport);
  }
  await sidebar.evaluate((el, value) => { el.style.setProperty("--sidebar-width", value); el.style.removeProperty("transition"); }, originalWidth);
  await page.evaluate(() => localStorage.setItem("pi-locale", "zh-CN"));
  await page.reload({ waitUntil: "networkidle" });
  console.log("PASS: direct Finder, Git in More actions, error reveal, footer 180/220/260/320/420px without content overlap");
}

/*
 * The sidebar's sessions and files in either layout: on a desktop the files
 * sit below the sessions by default (both in view; the files section may be
 * folded to its header row), phones and Settings › General › File browser
 * "Separate tab" show one tab at a time. Both panels keep their ids in both.
 */

/** Shows the explorer: the Files tab, or the files section opened. */
export async function showSidebarFiles(page) {
  const files = page.locator("#session-sidebar-panel-files");
  const tab = page.getByRole("tab", { name: "Files", exact: true });
  const toggle = files.locator(".sidebar-files-section-toggle");
  await tab.or(toggle).first().waitFor();
  if (await tab.count()) {
    if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  } else if (await toggle.getAttribute("aria-expanded") !== "true") {
    await toggle.click();
  }
  await files.locator(".sidebar-files-body").waitFor({ state: "visible" });
}

/** Shows the session rows: the Sessions tab, or nothing to do below the files. */
export async function showSidebarSessions(page) {
  const tab = page.getByRole("tab", { name: "Sessions", exact: true });
  await tab.or(page.locator(".sidebar-brand")).first().waitFor();
  if (await tab.count() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await page.locator("#session-sidebar-panel-sessions").waitFor({ state: "visible" });
}

/**
 * On a desktop both regions show by default; "Separate tab" brings the tabs
 * back and "Below sessions" returns, the file tree mounted throughout: its
 * own root stays on the page and its file search keeps its query, which a
 * remount would lose (open folders would come back from the per-folder
 * memory, so they prove nothing).
 */
export async function checkFilesPlacement(page) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  const files = page.getByRole("region", { name: "Files", exact: true });
  const tablist = page.getByRole("tablist", { name: "Sidebar view", exact: true });
  await sessions.waitFor();
  await files.waitFor();
  assert.equal(await tablist.count(), 0, "No tabs while the files sit below the sessions");
  await showSidebarFiles(page);
  await page.getByRole("separator", { name: "Resize file browser", exact: true }).waitFor();
  const fileSearch = files.getByRole("button", { name: "Search files", exact: true });
  const fileQuery = page.locator("#file-search-input");
  if (await fileSearch.getAttribute("aria-expanded") !== "true") await fileSearch.click();
  await fileQuery.fill("e2e-placement");
  // FileExplorer's root, not the scroll box the sidebar always renders around it.
  const tree = await page.locator("#session-sidebar-panel-files .sidebar-files-scroll > *").first().elementHandle();
  const choose = async (label) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-section-tabs").getByRole("button", { name: "General", exact: true }).click();
    const radio = page.getByRole("radio", { name: label, exact: true });
    await radio.locator("..").click();
    assert.equal(await radio.isChecked(), true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
  };

  await choose("Separate tab");
  await tablist.waitFor();
  assert.equal(await tablist.getByRole("tab").count(), 2);
  assert.equal(await tablist.getByRole("tab", { name: "Files", exact: true }).count(), 1);
  assert.equal(await sessions.count() + await files.count(), 0, "The panels are the tabs' again");
  assert.equal(await page.locator(".sidebar-files-section").count(), 0);
  await showSidebarFiles(page);
  await page.getByRole("tabpanel", { name: "Files", exact: true }).waitFor();

  await choose("Below sessions");
  await sessions.waitFor();
  await files.waitFor();
  assert.equal(await tablist.count(), 0);
  assert.equal(await tree.evaluate((element) => element.isConnected), true, "Switching layouts keeps the file tree mounted");
  assert.equal(await fileQuery.inputValue(), "e2e-placement", "and its file search");
  await tree.dispose();
  await fileQuery.fill("");
  await fileSearch.click();
  await fileQuery.waitFor({ state: "detached" });
}
