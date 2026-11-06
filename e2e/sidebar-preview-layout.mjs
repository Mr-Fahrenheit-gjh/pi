// Run against the parent's isolated candidate after prepareWorkspaceFixture().
// No server, dependency install, session mutation or production navigation is performed here.
import assert from "node:assert/strict";

export async function runSidebarPreviewLayoutChecks(page, { baseURL }) {
  assert.match(baseURL, /^http:\/\/127\.0\.0\.1:301[5-9]\d$/);
  const checks = [];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "domcontentloaded" });
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

// Claude-scale navigation on the isolated source/dev fixture; no model calls.
export async function runSidebarScaleChecks(page, { baseURL, outputDir, sessionId }) {
  const checks = [];
  const context = page.context();
  await context.addInitScript(() => {
    localStorage.setItem('pi-theme', 'claude-white');
    localStorage.setItem('pi-web:sidebar-show-archived', 'true');
    window.EventSource = class {
      readyState = 1; onmessage = null; onerror = null;
      constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connected', isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
  });
  const state = { running: false, state: { isStreaming: false, isPromptRunning: false, messages: [], thinkingLevel: 'off', extensionStatuses: [], extensionWidgets: [] } };
  await page.route('**/api/sessions/*/state', route => route.fulfill({ json: state }));
  await page.route(`**/api/agent/${sessionId}`, route => route.fulfill({ json: state }));
  await page.goto(`${baseURL}/?session=${sessionId}`, { waitUntil: 'networkidle' });
  await page.locator('.markdown-assistant-message').first().waitFor();
  await page.locator('.session-tree-pinned-label').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const scroll = page.locator('.sidebar-sessions-view:not([hidden]):not(.sidebar-archive-view) .session-tree-scroll');
  const top = () => scroll.evaluate(el => { el.scrollTop = 0; });
  await top();
  const metrics = await page.evaluate(() => {
    const measure = selector => {
      const el = document.querySelector(selector), s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, transform: s.textTransform, x: r.x, y: r.y, height: r.height, width: r.width };
    };
    return Object.fromEntries(Object.entries({ new: '.sidebar-quick-new', search: '.sidebar-quick-search', newLabel: '.sidebar-quick-new > span', project: '.session-tree-group-toggle', projectLabel: '.session-tree-group-name', projectIcon: '.session-tree-project-icon', session: '.session-tree-session[data-row-key^="session:group:"] .session-tree-title', pinned: '.session-tree-pinned-label', pinnedSession: '.session-tree-session.is-standalone-pin .session-tree-title', document: '.sidebar-files-section-label', settings: '.workspace-settings-entry > button' }).map(([key, selector]) => [key, measure(selector)]));
  });
  for (const key of ['new', 'search', 'project', 'session', 'settings']) assert.equal(metrics[key].fontSize, '14px', key);
  for (const key of ['new', 'search', 'project', 'settings']) assert.equal(metrics[key].height, 32, key);
  assert.equal(metrics.pinned.fontSize, '12px'); assert.equal(metrics.pinned.transform, 'none');
  assert.equal(metrics.projectIcon.width, 20); assert.equal(metrics.projectIcon.height, 20);
  assert.equal(metrics.newLabel.x, metrics.projectLabel.x, 'Navigation/project text column');
  assert.equal(metrics.projectLabel.x, metrics.session.x, 'Nested conversations keep the project text column');
  assert.equal(metrics.pinnedSession.x, metrics.pinned.x, 'Standalone pins follow Claude’s unindented recent/pinned rows');
  assert.equal(metrics.document.x, metrics.pinned.x, 'Section headings share their left edge');
  assert.equal(metrics.document.fontSize, '12px'); assert.equal(metrics.document.transform, 'none');
  assert.equal(await page.locator('.sidebar-quick-actions input').count(), 0);
  checks.push('14px content, 12px sentence-case sections, 32px rows, 20px project icons, aligned text columns');
  const fixed = async () => ({ brand: (await page.locator('.sidebar-brand').boundingBox()).y, settings: (await page.locator('.workspace-settings-entry').boundingBox()).y });
  const before = await fixed();
  const firstY = (await page.locator('.sidebar-quick-new').boundingBox()).y;
  const box = await scroll.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(() => document.querySelector('.session-tree-scroll').scrollTop > 100);
  const moved = await scroll.evaluate(el => el.scrollTop);
  assert.ok(Math.abs(firstY - (await page.locator('.sidebar-quick-new').boundingBox()).y - moved) < 1);
  assert.deepEqual(await fixed(), before);
  checks.push('real wheel scroll moves New/Search with the tree; brand and Settings stay fixed');
  await page.screenshot({ path: `${outputDir}/sidebar-scrolled.png`, style: 'nextjs-portal { display: none !important; }' });
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const archived = page.locator('.session-tree-footer-button').filter({ hasText: 'Archived' });
  await archived.waitFor();
  const endBox = await archived.boundingBox(), scrollBox = await scroll.boundingBox();
  assert.ok(endBox.y + endBox.height <= scrollBox.y + scrollBox.height + 1, 'Last row reachable');
  const saved = await scroll.evaluate(el => el.scrollTop);
  await archived.click();
  await page.locator('.sidebar-archive-back').waitFor();
  await page.locator('.sidebar-archive-back').click();
  await scroll.waitFor({ state: 'visible' });
  assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - saved) < 1, 'Archive round-trip restores container scrollTop');
  checks.push('virtualized bottom reachable and archive return preserves scroll position');
  await top();
  await page.locator('.sidebar-files-section-toggle').click();
  await page.waitForFunction(() => document.querySelector('.sidebar-files-section-toggle').getAttribute('aria-expanded') === 'false');
  const more = page.locator('.session-tree-more-toggle[data-more-action="more"]').first();
  await more.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const active = document.activeElement, surface = active?.closest('.session-tree-scroll');
    if (!surface || !active.matches('[data-more-action]')) return false;
    const a = active.getBoundingClientRect(), s = surface.getBoundingClientRect();
    return a.y >= s.y && a.bottom <= s.bottom;
  });
  checks.push('keyboard Show more reveals/focuses its moved row with the navigation offset');
  await page.locator('.session-tree-more-toggle[data-more-action="less"]').first().click();
  await top();
  await page.locator('.session-tree-pinned-toggle').click();
  assert.equal(await page.locator('.session-tree-pinned-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('.session-tree-pinned-toggle').click();
  await page.locator('.sidebar-files-section-toggle').click();
  await page.locator('.sidebar-quick-search').click();
  await page.locator('.quick-actions-surface[data-mode="chat"]').waitFor();
  await page.screenshot({ path: `${outputDir}/sidebar-search.png`, style: 'nextjs-portal { display: none !important; }' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+j');
  await page.locator('.quick-actions-surface[data-mode="chat"]').waitFor();
  await page.keyboard.press('Escape');
  checks.push('Pinned folding and Search/Cmd+J remain functional');
  await top();
  await page.locator('.chat-input-textarea').focus();
  await page.locator('.chat-input-textarea').blur();
  await page.mouse.move(1100, 20);
  await page.screenshot({ path: `${outputDir}/sidebar-chat.png`, style: 'nextjs-portal { display: none !important; }' });
  await page.locator('.sidebar-quick-new').click();
  await page.locator('.new-session-greeting').waitFor();
  await top();
  await page.locator('.chat-input-textarea').blur();
  await page.mouse.move(1100, 20);
  await page.screenshot({ path: `${outputDir}/sidebar-welcome.png`, style: 'nextjs-portal { display: none !important; }' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push('New opens welcome; no horizontal overflow');
  return { passed: true, metrics, checks, screenshots: ['sidebar-chat.png', 'sidebar-scrolled.png', 'sidebar-search.png', 'sidebar-welcome.png'].map(name => `${outputDir}/${name}`) };
}
