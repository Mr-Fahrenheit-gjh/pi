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
export async function runSidebarScaleChecks(page, { baseURL, outputDir, sessionId, theme = 'light' }) {
  const checks = [];
  const context = page.context();
  await context.addInitScript(theme => {
    localStorage.setItem('pi-theme', theme);
    localStorage.setItem('pi-web:sidebar-show-archived', 'true');
    window.EventSource = class {
      readyState = 1; onmessage = null; onerror = null;
      constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connected', isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
  }, theme);
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
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, lineHeight: s.lineHeight, transform: s.textTransform, x: r.x, y: r.y, height: r.height, width: r.width };
    };
    return Object.fromEntries(Object.entries({ brand: '.sidebar-brand', header: '.sidebar-header', sidebarToggle: '[data-sidebar-toggle]', new: '.sidebar-quick-new', search: '.sidebar-quick-search', newLabel: '.sidebar-quick-new > span', project: '.session-tree-group-toggle', projectLabel: '.session-tree-group-name', projectIcon: '.session-tree-project-icon', session: '.session-tree-session[data-row-key^="session:group:"] .session-tree-title', pinned: '.session-tree-pinned-label', pinnedSession: '.session-tree-session.is-standalone-pin .session-tree-title', document: '.sidebar-files-section-label', settings: '.workspace-settings-entry > button' }).map(([key, selector]) => [key, measure(selector)]));
  });
  assert.equal(metrics.brand.fontSize, '18px');
  assert.equal(metrics.brand.fontWeight, '400');
  assert.match(metrics.brand.fontFamily, /Claude Interface Serif/);
  assert.equal(metrics.brand.lineHeight, '26px');
  assert.equal(metrics.header.height, 48);
  assert.equal(metrics.brand.x, metrics.newLabel.x, 'Brand shares the navigation text column');
  assert.ok(metrics.brand.x >= metrics.sidebarToggle.x + metrics.sidebarToggle.width, 'Brand and collapse targets do not overlap');
  assert.ok(Math.abs(metrics.brand.y + metrics.brand.height / 2 - metrics.sidebarToggle.y - metrics.sidebarToggle.height / 2) <= 1, 'Brand and collapse button are vertically centered together');
  await page.locator('.sidebar-brand').click();
  await page.getByRole('menu').waitFor();
  assert.equal(await page.locator('.sidebar-brand').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sidebar-brand').getAttribute('aria-expanded'), 'false');
  await page.locator('[data-sidebar-toggle]').click();
  await page.locator('#session-sidebar.sidebar-closed').waitFor({ state: 'attached' });
  await page.locator('[data-sidebar-toggle]').click();
  await page.locator('#session-sidebar.sidebar-open').waitFor();
  await page.waitForFunction(() => document.getElementById('session-sidebar').getAnimations().length === 0);
  checks.push('18px/400 actual application serif brand, 48px header; distinct collapse target and working brand menu');
  for (const key of ['new', 'search', 'project', 'session', 'settings']) assert.equal(metrics[key].fontSize, '14px', key);
  for (const key of ['new', 'search', 'project', 'settings']) assert.equal(metrics[key].height, 32, key);
  assert.equal(metrics.pinned.fontSize, '12px'); assert.equal(metrics.pinned.transform, 'none');
  assert.equal(metrics.projectIcon.width, 20); assert.equal(metrics.projectIcon.height, 20);
  assert.equal(metrics.newLabel.x, metrics.projectLabel.x, 'Navigation/project text column');
  assert.equal(metrics.session.x, metrics.pinned.x, 'Ordinary conversation titles use the left text edge, not a vacant fork column');
  assert.equal(metrics.pinnedSession.x, metrics.pinned.x, 'Standalone pins follow Claude’s unindented recent/pinned rows');
  assert.equal(metrics.document.x, metrics.pinned.x, 'Section headings share their left edge');
  assert.equal(metrics.document.fontSize, '12px'); assert.equal(metrics.document.transform, 'none');
  assert.equal(await page.locator('.sidebar-quick-actions input').count(), 0);
  const parent = page.locator('[data-row-key="session:pinned:sidebar-scale-0"]');
  const plain = page.locator('[data-row-key="session:pinned:sidebar-scale-1"]');
  const child = page.locator('[data-row-key="session:pinned:sidebar-scale-3"]');
  const nested = page.locator('[data-row-key="session:pinned:sidebar-scale-4"]');
  const titleX = async row => (await row.locator('.session-tree-title').boundingBox()).x;
  assert.equal(await titleX(parent), await titleX(plain), 'Fork parents and ordinary conversations share the same title edge');
  assert.equal(await titleX(child) - await titleX(parent), 16);
  assert.equal(await titleX(nested) - await titleX(child), 16);
  const linkBox = await parent.locator('.session-tree-main').boundingBox();
  const toggleBox = await parent.locator('.session-tree-branch-toggle').boundingBox();
  assert.ok(toggleBox.x >= linkBox.x + linkBox.width - 1, 'Independent fork toggle trails the link without covering its text');
  await parent.locator('.session-tree-branch-toggle').click();
  await child.waitFor({ state: 'detached' });
  await parent.locator('.session-tree-branch-toggle').click();
  await nested.waitFor();
  const projectShape = await page.locator('.session-tree-group-toggle .session-tree-project-icon').first().innerHTML();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const renderedFonts = {};
  for (const selector of ['.sidebar-quick-search > span', '.sidebar-brand']) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    renderedFonts[selector] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  }
  assert.ok(renderedFonts['.sidebar-quick-search > span'].some(font => font.isCustomFont && font.glyphCount > 0 && /26-245-1/.test(font.familyName)), 'Application Sans version renders, not the marketing font or a fallback');
  assert.ok(renderedFonts['.sidebar-brand'].some(font => font.isCustomFont && font.glyphCount > 0 && /Anthropic Serif/.test(font.familyName)));
  await cdp.detach();
  for (const palette of ['light', 'claude-white']) {
    const colors = await page.evaluate(palette => {
      const saved = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = palette;
      const read = selector => getComputedStyle(document.querySelector(selector)).color;
      const result = { label: read('.session-tree-pinned-label'), section: read('.sidebar-files-section-label') };
      document.documentElement.dataset.theme = saved;
      return result;
    }, palette);
    assert.equal(colors.label, colors.section);
    const channels = colors.label.match(/\d+/g).map(Number);
    assert.equal(channels[0], channels[1]); assert.equal(channels[1], channels[2], 'Labels are neutral gray, not blue-gray');
  }
  checks.push('Same root title edge with or without forks; 16px child steps, trailing collapse control; shared rounded project icon; real application font and neutral Light/Claude White labels');
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
  assert.equal(await page.locator('.session-tree-footer-button .session-tree-project-icon').innerHTML(), projectShape, 'Open project uses the same rounded project symbol');
  assert.equal(await page.locator('.session-tree-footer-button').first().evaluate(node => getComputedStyle(node).color), metrics.project.color, 'Project entry and project names share the same ink hierarchy');
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
  await page.locator('.sidebar-quick-search').click();
  const searchDialog = page.locator('.quick-actions-surface[data-mode="chat"]');
  const searchInput = searchDialog.locator('input');
  await searchDialog.waitFor();
  assert.equal(await searchDialog.getByRole('option').count(), 9, 'Blank Search stops at nine recent conversations');
  assert.ok(await searchDialog.locator('.quick-actions-results').evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'The nine-row desktop preview fits without clipping the final result');
  const searchPages = [];
  const collectSearch = response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/sessions/search' && response.status() === 200) searchPages.push(response.json().then(body => ({ query: url.searchParams.get('q'), ...body })));
  };
  page.on('response', collectSearch);
  await searchInput.fill('shared-content-marker');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.quick-actions-surface[data-mode="chat"]');
    return dialog?.querySelector('[role="option"] .quick-action-preview')?.textContent.includes('shared-content-marker') && !dialog.querySelector('footer [role="status"]');
  });
  assert.equal(await searchDialog.getByRole('option').count(), 9);
  const firstPage = await searchDialog.getByRole('option').allTextContents();
  await searchDialog.getByRole('button', { name: 'Next results', exact: true }).click();
  assert.equal(await searchDialog.getByRole('option').count(), 9);
  assert.notDeepEqual(await searchDialog.getByRole('option').allTextContents(), firstPage, 'Keyword hits beyond nine remain reachable');
  await searchInput.fill('deep-scan-marker');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.quick-actions-surface[data-mode="chat"]');
    return dialog?.querySelector('[role="option"] .quick-action-preview')?.textContent.includes('deep-scan-marker') && !dialog.querySelector('footer [role="status"]');
  });
  const pages = await Promise.all(searchPages);
  const shared = pages.filter(p => p.query === 'shared-content-marker').flatMap(p => p.results);
  assert.equal(new Set(shared.map(r => r.session.id)).size, 40);
  assert.ok(shared.some(r => r.session.id === 'sidebar-scale-2'), 'Archived conversation remains searchable');
  assert.ok(shared.some(r => r.session.id === 'sidebar-scale-25'), 'Other project remains searchable');
  const deep = pages.filter(p => p.query === 'deep-scan-marker');
  assert.ok(deep.length >= 2, 'Scanner continued beyond its first 500-file batch');
  assert.equal(deep.flatMap(p => p.results)[0].entryId, 'deep-answer');
  await page.screenshot({ path: `${outputDir}/sidebar-search-all.png`, style: 'nextjs-portal { display: none !important; }' });
  page.off('response', collectSearch);
  await page.keyboard.press('Escape');
  checks.push('Search: exactly nine recents; all 40 keyword matches paged, other projects/archives included; body hit beyond 500 files reached automatically');
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
