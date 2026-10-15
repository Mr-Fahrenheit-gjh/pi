// Run against the parent's isolated candidate after prepareWorkspaceFixture().
// No server, dependency install, session mutation or production navigation is performed here.
import assert from "node:assert/strict";

export async function runSidebarPreviewLayoutChecks(page, { baseURL }) {
  assert.match(baseURL, /^http:\/\/127\.0\.0\.1:301[5-9]\d$/);
  const checks = [];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
    await page.locator(".workspace-topbar").waitFor({ state: "attached" });
    const sides = [
      { id: "session-sidebar", prefix: "sidebar", toggle: "[data-sidebar-toggle]" },
      { id: "file-panel", prefix: "right-panel", toggle: "[data-right-panel-toggle]" },
    ];
    for (const side of sides) {
      if (await page.locator(`#${side.id}.${side.prefix}-open`).count()) await page.locator(side.toggle).click();
    }
    await page.mouse.move(width / 2, 450);
    await page.waitForFunction(() => ["session-sidebar", "file-panel"].every((id) => document.getElementById(id).getAnimations().length === 0));

    for (const side of sides) {
      for (const dismissal of ["pointer", "Escape"]) {
        await page.locator(side.toggle).hover();
        await page.locator(`#${side.id}.${side.prefix}-preview`).waitFor();
        await page.waitForFunction((id) => document.getElementById(id).getAnimations().length === 0, side.id);
        // Move from the fixed toggle into the panel to cover the hover bridge.
        await page.mouse.move(side.prefix === "sidebar" ? 100 : width - 100, 150);
        assert.equal(await page.locator(`#${side.id}.${side.prefix}-preview`).count(), 1);
        const paint = await page.locator(`#${side.id}`).evaluate((panel) => {
          const style = getComputedStyle(panel);
          const surfaces = [...panel.querySelectorAll(".sidebar-archive-view, .file-workspace-header, .file-viewer-toolbar, .file-viewer-content, .file-source-view")];
          return { background: style.backgroundImage, color: style.backgroundColor, opacity: style.opacity, mask: style.maskImage,
            coveringSurfaces: surfaces.filter((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)").map((node) => node.className) };
        });
        assert.equal(paint.background, "none", "Preview has no gradient");
        assert.ok(paint.color !== "rgba(0, 0, 0, 0)" && !/rgba\([^)]*,\s*0\./.test(paint.color), "Preview uses an opaque theme surface");
        assert.equal(paint.opacity, "1", "Preview text/icons must remain opaque");
        assert.equal(paint.mask, "none", "Preview must not mask content");
        // Native inner surfaces stay intact; only the former gradient was removed.
        // Capture the whole main/document geometry on every frame, not just final positions.
        await page.evaluate(() => {
          const main = document.querySelector(".workspace-topbar").parentElement;
          const geometry = () => {
            const rect = main.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height, document.documentElement.clientWidth,
              document.documentElement.clientHeight, document.documentElement.scrollWidth, document.documentElement.scrollHeight];
          };
          window.__sidebarLayoutTrace = { initial: geometry(), frames: [], active: true };
          const record = () => {
            const trace = window.__sidebarLayoutTrace;
            if (!trace.active) return;
            trace.frames.push(geometry());
            requestAnimationFrame(record);
          };
          requestAnimationFrame(record);
        });
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        // A compact right preview can cover the viewport centre; leave at its opposite edge.
        await page.mouse.move(side.prefix === "sidebar" ? width - 32 : 32, 450);
        await page.waitForFunction(({ id, prefix }) => {
          const panel = document.getElementById(id);
          return !panel.classList.contains(`${prefix}-preview`) && !panel.classList.contains(`${prefix}-preview-exiting`);
        }, side);
        // Include class removal and any accidental follow-on compact transform in the trace.
        await page.evaluate(() => new Promise((resolve) => {
          const until = performance.now() + 250;
          const next = () => performance.now() >= until ? resolve() : requestAnimationFrame(next);
          requestAnimationFrame(next);
        }));
        const trace = await page.evaluate(() => {
          window.__sidebarLayoutTrace.active = false;
          const trace = window.__sidebarLayoutTrace;
          delete window.__sidebarLayoutTrace;
          return trace;
        });
        assert.ok(trace.frames.length > 2, "Missing animation-frame samples");
        for (const frame of trace.frames) {
          frame.forEach((value, index) => assert.ok(Math.abs(value - trace.initial[index]) < 1,
            `${side.prefix} ${dismissal} exit at ${width}px changed geometry[${index}]: ${trace.initial[index]} -> ${value}`));
        }
        if (width === 1440) assert.ok((await page.locator(`#${side.id}`).boundingBox()).width < 1);
        assert.equal(await page.locator(side.toggle).getAttribute("aria-expanded"), "false");
        checks.push(`${width}px ${side.prefix}: hover bridge, ${dismissal} exit, ${trace.frames.length} stable geometry frames`);
      }
    }
  }
  return { passed: true, checks };
}
