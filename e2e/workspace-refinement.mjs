// Isolated synthetic candidate acceptance only; no real sessions, prompts or service restart.
export async function runWorkspaceRefinementChecks(page, { baseURL, outputDir, project }) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw new Error('Candidate required');
  const checks = [];
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`${baseURL}/?cwd=${encodeURIComponent(project)}`, { waitUntil: 'networkidle' });
  const input = page.locator('.chat-input-textarea').first();
  await input.waitFor();
  check(await input.getAttribute('placeholder') === 'Reply', 'New input uses Reply');
  const footer = page.locator('.new-session-context-footer');
  await footer.waitFor();
  const box = await page.locator('.chat-input-shell').boundingBox();
  check((await footer.boundingBox()).y >= box.y + box.height - 1, 'Project and Git follow the entire composer');
  check(await input.evaluate(node => getComputedStyle(node, '::placeholder').fontFamily === getComputedStyle(document.body).fontFamily), 'Placeholder uses UI typography');
  check(await page.locator('.project-picker-name').first().evaluate(node => getComputedStyle(node).fontFamily === getComputedStyle(document.body).fontFamily), 'Project name uses UI typography, not monospace');
  await page.screenshot({ path: `${outputDir}/refinement-home.png` });
  checks.push('home: project/Git below composer; Reply and UI placeholder font');

  await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: 'networkidle' });
  await page.locator('.markdown-assistant-message').first().waitFor();
  check(await page.locator('[data-process-details]').count() === 0, 'Finished turns have no process row');
  check(await page.locator('[data-row-key="footer-archived"]').count() === 0, 'Archive entry hidden by default');
  check(await page.locator('.session-tree-folder-icon').count() > 0, 'Project folder icons');
  const top = await page.locator('.workspace-topbar').evaluate(node => ({ h: node.getBoundingClientRect().height, bg: getComputedStyle(node).backgroundColor, pointer: getComputedStyle(node).pointerEvents }));
  check(top.h === 0 && top.bg === 'rgba(0, 0, 0, 0)' && top.pointer === 'none', 'No header surface or hit target covers chat');
  for (const selector of ['[data-sidebar-toggle]', '[data-right-panel-toggle]']) check(await page.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)'), 'Corner icon has no background');
  const row = page.locator('[data-row-key="session:group:workspace-design-fixture"]');
  await row.hover();
  await row.getByRole('button', { name: '置顶', exact: true }).click();
  await page.locator('[data-row-key="session:pinned:workspace-design-fixture"]').waitFor();
  await page.locator('[data-row-key="session:pinned:workspace-design-fixture"]').getByRole('button', { name: '取消置顶', exact: true }).click();
  await row.waitFor();
  checks.push('history: completed process absent; transparent zero-height header; project icons; pin/unpin exact conversation');
  await page.locator('.workspace-settings-entry button').first().click();
  const archiveSwitch = page.getByRole('switch', { name: '在侧栏显示已归档对话', exact: true });
  await archiveSwitch.waitFor();
  check(!await archiveSwitch.isChecked(), 'Archive setting defaults off');
  await archiveSwitch.check();
  check(await page.evaluate(() => localStorage.getItem('pi-web:sidebar-show-archived')) === 'true', 'Archive visibility persisted');
  await page.keyboard.press('Escape');
  await page.locator('[data-row-key="footer-archived"]').waitFor();
  await page.locator('[data-row-key="footer-archived"] button').click();
  await page.getByText('仅供验证的已归档对话', { exact: true }).waitFor();
  await page.locator('.workspace-settings-entry button').first().click();
  await archiveSwitch.uncheck();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-row-key="footer-archived"]'));
  check(await page.getByText('仅供验证的已归档对话', { exact: true }).count() === 0, 'Hiding archive closes its view without changing stored history');
  checks.push('settings: archive visibility switch persists, immediate in-memory hide');

  await page.route('**/api/agent/*/subagents**', route => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id');
    return route.fulfill({ json: url.searchParams.get('view') === 'chat' ? { messages: [], text: `精确记录 ${id}` } : {
      available: true, asyncSnapshot: { runs: [
        { id: 'compact-a', label: 'reviewer · reviewer: 检查子代理与文件界面'.repeat(4), role: 'reviewer', state: 'complete' },
        { id: 'compact-b', label: 'reviewer · reviewer: 检查子代理与文件界面'.repeat(4), role: 'reviewer', state: 'running' },
        { id: 'compact-c', label: 'reviewer: You are reviving a previous subagent conversation. Origin...', role: 'reviewer', state: 'complete' },
      ] }, fleet: { entries: [] },
    } });
  });
  const right = page.locator('[data-right-panel-toggle]');
  if (await right.getAttribute('aria-expanded') !== 'true') await right.click();
  await page.locator('#file-panel [role="tab"]').filter({ hasText: '子代理' }).click();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const trigger = page.locator('.agent-picker-trigger');
  await trigger.click();
  await page.locator('[data-agent-id="package:compact-a"]').waitFor();
  check(await page.locator('.agent-picker-group').count() === 1, 'Duplicate summaries grouped without losing identity');
  await page.locator('.agent-picker-group summary').click();
  const pop = await page.locator('.agent-picker-popover').boundingBox();
  const panel = await page.locator('#file-panel').boundingBox();
  check(pop.x >= panel.x && pop.x + pop.width <= panel.x + panel.width + 1, 'Popup width bounded by right panel');
  check(!/You are reviving/.test(await page.locator('.agent-picker-popover').innerText()), 'No revival scaffolding in visible titles');
  await page.locator('[data-agent-id="package:compact-b"]').click();
  await page.getByText('精确记录 compact-b', { exact: true }).waitFor();
  check(await page.locator('.chat-input-textarea').count() === 1, 'No child composer');
  await trigger.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.locator('#file-panel .markdown-assistant-message').first().waitFor();
  await trigger.click(); await page.keyboard.press('Escape');
  check(await trigger.getAttribute('aria-expanded') === 'false', 'Escape closes picker');
  await page.screenshot({ path: `${outputDir}/refinement-agents.png` });
  checks.push('agents: bounded popup, grouping, clean titles/state, exact child routing, keyboard return and Escape');
  return { passed: true, mocked: true, realModelRequests: 0, checks };
}
