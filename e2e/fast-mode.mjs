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
