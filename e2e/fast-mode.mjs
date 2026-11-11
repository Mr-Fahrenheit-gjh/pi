// Component-only browser check: mount the real ModelSelector with controlled
// props. No AgentSession, model request or real user data; backend has unit tests.
export async function runFastModeChecks(page, { baseURL, outputDir }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  check(/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL), 'Use an isolated preview port');
  const errors = [], onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  await page.setViewportSize({ width: 1100, height: 850 });
  const trigger = () => page.locator('[data-model-selector-trigger]');
  const menu = () => page.locator('[data-model-selector-menu]');
  const toggle = () => menu().getByRole('switch', { name: 'Fast mode' });
  const checked = () => toggle().getAttribute('aria-checked');
  try {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    check(await trigger().isEnabled(), 'Running GPT can open Fast');
    await trigger().click();
    check(!await menu().getByRole('option', { name: 'GPT fixture', exact: true }).isEnabled(), 'Model changes stay locked while running');
    await toggle().click();
    check(await checked() === 'true', 'Fast turns on');
    check(await page.locator('[data-model-fast-indicator]').count() === 1, 'Fast badge reflects saved branch state without SSE');
    await toggle().click();
    check(await checked() === 'false', 'Fast turns off');
    check(await page.evaluate(() => window.fastFixture.mode) === 'standard', 'Off is explicit standard mode');
    await menu().getByRole('button', { name: 'Use model settings', exact: true }).click();
    await menu().getByText('Using model settings (auto)', { exact: true }).waitFor();
    check(await page.evaluate(() => window.fastFixture.mode) === 'auto', 'Auto is preserved');
    await page.evaluate(() => window.fastFixture.set({ available: false }));
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.disabled === true);
    check(!await toggle().isEnabled(), 'Missing extension disables the control');
    await page.evaluate(() => window.fastFixture.set({ available: true, busy: true }));
    await menu().getByText('Loading Fast settings…', { exact: true }).waitFor();
    check(!await toggle().isEnabled(), 'Pending mutation disables duplicate clicks');
    await page.evaluate(() => window.fastFixture.set({ busy: false, running: false }));
    await page.waitForFunction(() => document.querySelector('fieldset[role=listbox]')?.disabled === false);
    check(await menu().getByRole('option', { name: 'GPT fixture', exact: true }).isEnabled(), 'Idle model selection is preserved');
    if (outputDir) await menu().screenshot({ path: `${outputDir}/fast-menu.png` });
    await page.keyboard.press('Escape');
    check(await menu().count() === 0, 'Escape dismisses the menu');
    await page.evaluate(() => window.fastFixture.set({ provider: 'anthropic', modelId: 'claude', running: true }));
    await page.waitForFunction(() => document.querySelector('[data-model-selector-trigger]')?.disabled === true);
    check(!await trigger().isEnabled(), 'Unsupported running models keep the original lock');
    check(await page.evaluate(() => window.fastFixture.modelChanges) === 0, 'Fast never changes the selected model');
    check(errors.length === 0, errors.join('\n'));
    return { passed: true, scope: 'real ModelSelector component with controlled props', checks: ['mid-run on/off/auto', 'model-row lock', 'unavailable/busy controls', 'idle model selection', 'Escape', 'unsupported provider lock'] };
  } finally {
    page.off('pageerror', onError);
  }
}

// Exercise the full app menu without credentials, model requests or config writes.
export async function checkModelMenuScrolling(page, { baseURL }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const catalogRoute = url => url.pathname === '/api/models';
  await page.route(catalogRoute, route => {
    const all = new URL(route.request().url()).searchParams.get('scope') === 'all';
    const modelList = Array.from({ length: all ? 72 : 48 }, (_, index) => ({
      provider: 'fixture', id: `catalog-${index + 1}`, name: `Catalog model ${index + 1}`,
    }));
    return route.fulfill({ json: {
      modelList, models: Object.fromEntries(modelList.map(model => [`${model.provider}:${model.id}`, model.name])),
      defaultModel: { provider: 'fixture', modelId: 'catalog-1' }, defaultThinkingLevel: null,
      savedDefaultThinkingLevel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {}, isScoped: !all,
    } });
  });
  try {
    await page.setViewportSize({ width: 1425, height: 793 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    const right = page.locator('[data-right-panel-toggle]').filter({ visible: true });
    await right.waitFor();
    const rightBox = await right.boundingBox();
    const leftBox = await page.locator('.workspace-sidebar-toggle').filter({ visible: true }).boundingBox();
    check(rightBox.x >= 1425 - 56 && rightBox.x + rightBox.width <= 1425, 'The right toggle stays at the right viewport corner');
    check(leftBox.x >= 0 && leftBox.x + leftBox.width <= 56, 'The left toggle stays at the left viewport corner');
    await page.locator('[data-model-selector-trigger]').filter({ visible: true }).first().click();
    const menu = page.locator('[data-model-selector-menu]');
    await menu.waitFor();
    const scroll = menu.locator('[data-model-selector-scroll]');
    const wheelToEnd = async () => {
      check(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), 'The long catalog needs scrolling');
      await scroll.hover();
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-model-selector-scroll]');
        return node && node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
      });
      const row = await menu.getByRole('option').last().boundingBox();
      const box = await scroll.boundingBox();
      check(row.y >= box.y && row.y + row.height <= box.y + box.height + 1, 'The last model stays reachable inside the menu');
    };
    await wheelToEnd();
    // Native fieldset locking must not disable its outer scroll container.
    await menu.locator('fieldset').evaluate(node => { node.disabled = true; });
    check(await menu.getByRole('option').first().isDisabled(), 'The native lock still prevents model changes');
    await scroll.evaluate(node => { node.scrollTop = 0; });
    await wheelToEnd();
    await menu.getByRole('button', { name: 'all', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-model-selector-menu] [role=option]').length >= 72);
    await wheelToEnd();
    await page.keyboard.press('Escape');
    console.log('PASS: fixed left/right corner controls and wheel access to the full scoped/all model catalogs');
  } finally {
    await page.unroute(catalogRoute);
  }
}
