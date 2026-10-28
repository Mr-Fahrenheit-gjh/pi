// Basic real-history acceptance, serialized into playwright-mcp's browser VM.
// Uses the current right workspace, never starts a browser or prompts a model.
export async function verifyRealHistory(page, { base, sessionId, here, smoke }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (actual, expected, message) => check(actual === expected, `${message}: ${actual} !== ${expected}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  // Mark the locale as an explicit choice; the English-default migration must not rewrite it.
  await page.addInitScript(() => { if (location.protocol === 'http:') { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-ui-language-version', 'english-interface-v1'); } });
  page.setDefaultTimeout(20000);
  // This read-only acceptance is not a user request for an extra model call.
  await page.route(`${base}/api/agent/*`, async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const command = request.postDataJSON();
      if (command?.type === "request_prompt_suggestion") {
        await route.fulfill({ json: { success: true, data: { available: false } } });
        return;
      }
    }
    await route.continue();
  });
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
  equal(await page.locator('[data-agent-switcher]').count(), 0, 'Top robot entry stays removed');
  equal(await page.getByRole('region', { name: '子代理切换与记录' }).count(), 0, 'No duplicate switcher');
  const answer = page.locator('.markdown-assistant-message').first();
  await answer.waitFor();
  // Approved contract: finished history no longer mounts a process disclosure.
  // This real-history gate proves the stronger default-hidden state, not a
  // nonexistent finished-turn toggle. Running/reveal interaction has separate candidate tests.
  equal(await page.locator('[data-process-details]').count(), 0, 'Finished history hides process rows');
  equal(await page.getByText('查看过程', { exact: true }).count(), 0, 'No permanent finished-process entry');
  equal(await page.getByText(/^工具执行失败/).count(), 0, 'No failure summaries outside hidden process');
  equal(await page.locator('.assistant-answer-bubble').count(), 0, 'Assistant bubbles stay removed');
  check(await answer.evaluate(el => {
    const body = el.closest('.assistant-response-content');
    if (!body) return false;
    const style = getComputedStyle(body);
    return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px' && style.paddingTop === '0px';
  }), 'Real answer is unframed without a background, border or extra padding');
  equal(await page.locator('.assistant-response-content [data-model-label], .assistant-response-content .message-footer').count(), 0, 'Identity and footer stay outside response content');
  const font = await answer.evaluate(el => getComputedStyle(el).fontFamily);
  check(font.includes('Georgia'), 'Preserve assistant typography');
  equal(await page.locator('.markdown-user-message').first().evaluate(el => getComputedStyle(el).fontFamily), font, 'Preserve user typography');
  await page.locator('[data-model-label] use[href="/provider-icons.svg#openai"]').first().waitFor();
  await page.locator('[data-model-selector-trigger] use[href="/provider-icons.svg#openai"]').waitFor();
  equal(await page.getByText('0.0 t/s', { exact: true }).count(), 0, 'No zero-speed badge');
  equal(await page.getByText(/^Error: (fetch failed|FETCH FAILED)$/).count(), 0, 'Fetch errors stay folded');
  equal(await page.getByRole('button', { name: '会话操作', exact: true }).count(), 0, 'Session menu stays removed');
  equal(await page.locator('.workspace-session-title, .message-usage, .extension-status-shelf').count(), 0, 'No title, accounting or bottom shelf');
  const ring = page.locator('.chat-input-controls [data-context-ring]');
  await ring.waitFor();
  equal(await ring.getAttribute('role'), 'meter', 'Context ring remains read-only');
  const send = page.locator('[data-composer-send]');
  await send.waitFor();
  equal((await send.innerText()).trim(), '', 'Send remains icon-only');
  check(!/\$\d/.test(await page.locator('.workspace-topbar').innerText()), 'Header billing stays hidden');
  equal(await page.locator('[data-right-panel-toggle]').evaluate(el => getComputedStyle(el).borderLeftWidth), '0px', 'No divider beside the right toggle');
  await page.screenshot({ path: `${here}live-main.png` });

  const right = page.locator('[data-right-panel-toggle]');
  if (await right.getAttribute('aria-expanded') !== 'true') await right.click();
  const panel = page.locator('#file-panel');
  await panel.locator('[role="tab"]').filter({ hasText: '待办' }).first().click();
  await panel.locator('.todo-workspace').waitFor();
  const todo = await page.request.get(`${base}/api/sessions/${encodeURIComponent(sessionId)}/todos`);
  equal(todo.status(), 200, 'Current branch tasks endpoint is readable');
  check(Array.isArray((await todo.json()).tasks), 'Tasks use a real persisted snapshot');
  await panel.locator('[role="tab"]').filter({ hasText: '子代理' }).first().click();
  const switcher = panel.locator('.agent-picker-trigger');
  await switcher.waitFor();
  await switcher.click();
  const options = panel.locator('[role="option"][data-agent-id]');
  await options.first().waitFor();
  const parentValue = await options.first().getAttribute('data-agent-id');
  equal(await page.getByRole('button', { name: '任务管理', exact: true }).count(), 0, 'Task management controls remain hidden');
  equal(await page.getByRole('dialog').count(), 0, 'No duplicate drawer');
  await panel.locator(`[data-agent-id^="package:${smoke.id}"]`).first().waitFor({ state: 'attached' });
  const values = await options.evaluateAll(options => options.map(option => option.getAttribute('data-agent-id')));
  const target = values.find(value => value === `package:${smoke.id}` || value?.startsWith(`package:${smoke.id}:`));
  check(target, 'The exact retained smoke run is selectable, not an identically named delegate');
  const exact = panel.locator(`[role="option"][data-agent-id="${target}"]`);
  const group = exact.locator('xpath=ancestor::details');
  if (await group.count() && await group.getAttribute('open') === null) await group.locator('summary').click();
  const loaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/subagents') && url.searchParams.get('view') === 'chat' && url.searchParams.get('id') === smoke.id;
  });
  await exact.click();
  const response = await loaded;
  equal(response.status(), 200, 'Exact real child transcript loaded');
  await panel.getByText(smoke.expectedText || 'SUBAGENT_UPDATE_SMOKE_OK', { exact: false }).first().waitFor();
  equal(await page.getByRole('button', { name: '返回主代理', exact: true }).count(), 0, 'No duplicate return bar');
  equal(await page.getByText(/输入仍发给主代理/).count(), 0, 'No redundant routing notice');
  equal(await page.locator('.chat-input-textarea').count(), 1, 'Main composer remains the only input');
  await page.screenshot({ path: `${here}live-child.png` });
  await switcher.click();
  await panel.locator(`[role="option"][data-agent-id="${parentValue}"]`).click();
  equal((await switcher.innerText()).replace('⌄', '').trim(), '主 Agent', 'Return to parent through the same right picker');
  return {
    quietToolsCollapsed: true, completedProcessHidden: true,
    suggestionGenerationSuppressed: true,
    quietToolsCoverage: 'Real completed history is hidden by default; no finished-toggle coverage claimed. Running/search-reveal behavior covered by candidate tests.',
    assistantAnswerUnframedVerified: true, toolFailureSummaryHidden: true,
    claudeStyleTypography: true, userBubbleTypography: true,
    modelManufacturerIcons: true, zeroSpeedBadgeAbsent: true,
    fetchErrorsCollapsed: true, switcherVisible: true, taskManagementHidden: true,
    realChildVerified: true, redundantChildBarAbsent: true,
    workspaceTitleMenuRemoved: true, contextRingVerified: true,
    iconOnlySendVerified: true, headerBillingHidden: true,
    rightWorkspaceSwitchingVerified: true, todoSnapshotVerified: true,
    topAgentIconAbsent: true, messageUsageRemoved: true, bottomStatusShelfHidden: true,
  };
}
