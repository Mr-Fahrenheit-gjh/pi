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

/** A + C: targeted dev/candidate checks; use prepareWorkspaceFixture in an isolated agentDir. */
export async function runWorkflowPolishChecks(page, { baseURL, outputDir, project }) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw new Error('Isolated preview required');
  const commands = [], errors = [], checks = [], finderRequests = [];
  let running = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.addInitScript(() => {
    localStorage.setItem('pi-locale', 'en');
    localStorage.setItem('pi-ui-language-version', 'english-interface-v1');
    localStorage.setItem('pi-theme', 'claude-white');
    localStorage.setItem('pi-sidebar-open', 'true');
    window.__polishSources = [];
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) { super(); this.url = url; window.__polishSources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connected', isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
    window.__polishFeed = event => window.__polishSources.filter(source => source.readyState === 1).forEach(source => source.onmessage?.({ data: JSON.stringify(event) }));
  });
  const state = () => ({ model: { provider: 'openai', id: 'design-fixture' }, thinkingLevel: 'medium', isStreaming: running, isPromptRunning: running, messages: [], extensionStatuses: [], extensionWidgets: [] });
  await page.route('**/api/agent/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/running')) return route.fulfill({ json: { running: [], awaitingInput: [] } });
    if (path.includes('/subagents')) return route.fulfill({ json: { available: false } });
    if (route.request().method() !== 'POST') return route.fulfill({ json: { running, state: state() } });
    const command = route.request().postDataJSON(); commands.push(command);
    if (command.type === 'get_state') return route.fulfill({ json: { success: true, data: state() } });
    if (command.type === 'get_commands') return route.fulfill({ json: { success: true, data: { commands: [] } } });
    if (command.type === 'get_tools') return route.fulfill({ json: { success: true, data: [] } });
    return route.fulfill({ json: { success: true, data: {} } });
  });
  await page.route('**/api/models?**', route => route.fulfill({ json: { models: { 'openai/design-fixture': 'Design fixture' }, modelList: [{ provider: 'openai', id: 'design-fixture', name: 'Design fixture' }], defaultModel: { provider: 'openai', modelId: 'design-fixture' }, defaultThinkingLevel: 'medium' } }));
  // Never launch a real OS window during the isolated command check.
  await page.route('**/api/open-in-explorer', route => {
    if (route.request().method() === 'POST') finderRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { supported: true, platform: 'darwin' } });
  });
  const visit = id => page.goto(`${baseURL}/?session=${id}`, { waitUntil: 'networkidle' });
  await visit('workspace-design-fixture');
  const composer = page.locator('.chat-input-textarea').first();
  await composer.waitFor(); await composer.fill('KEEP_POLISH_DRAFT');
  running = true;
  await page.evaluate(() => window.__polishFeed({ type: 'agent_start' }));
  await page.keyboard.press('Meta+k');
  const dialog = page.getByRole('dialog', { name: 'Search', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  check(await composer.inputValue() === 'KEEP_POLISH_DRAFT', 'Quick actions must preserve the draft');
  check(await composer.evaluate(node => document.activeElement === node), 'Escape restores the composer focus');
  check(!commands.some(command => command.type === 'abort'), 'Closing quick actions must not stop an agent');
  await page.keyboard.press('Meta+k'); await dialog.waitFor();
  await page.getByRole('combobox', { name: 'Search conversations and files…' }).dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
  check(await dialog.isVisible(), 'IME Escape keeps the menu open');
  await page.keyboard.press('Escape');
  running = false; await page.evaluate(() => window.__polishFeed({ type: 'agent_end', messages: [] }));
  checks.push('shortcut: IME, Escape, focus and draft preserved; no abort');

  check(await page.locator('.sidebar-quick-search button').count() === 0, 'The sidebar search has no shortcut button taking input space');
  const openMenu = async query => {
    await page.keyboard.press('Meta+k');
    await dialog.waitFor();
    await dialog.getByRole('combobox').fill(query);
  };
  await openMenu('');
  const topCommands = ['New conversation in this project', 'Open project terminal', 'Files from this conversation', 'Rename this conversation', 'Fork this conversation', 'Open conversation folder in Finder'];
  for (const [index, label] of topCommands.entries()) check((await dialog.getByRole('option').nth(index).textContent()).startsWith(label), `Command ${index + 1} stays ahead of conversation results: ${label}`);
  check(await dialog.getByRole('option').filter({ hasText: 'Polish second conversation' }).count() === 1, 'Recent conversations follow the commands');
  check(await dialog.getByRole('option').filter({ hasText: /Focus message|Show sidebar|Hide sidebar|Settings|Pin file/ }).count() === 0, 'No low-value focus/sidebar/settings/pin placeholders');
  check(await dialog.getByRole('option').filter({ hasText: 'Open project terminal' }).count() === 1, 'Project terminal is a useful explicit action');
  await dialog.getByRole('combobox').fill('DELIVERABLE_SEARCH_NEEDLE');
  const bodyHit = dialog.getByRole('option').filter({ hasText: 'DELIVERABLE_SEARCH_NEEDLE' });
  await bodyHit.waitFor(); await bodyHit.click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push('search: recent conversations, useful project actions, full-body match and exact message navigation');
  await openMenu('工作约定');
  await dialog.getByRole('option').filter({ hasText: '工作约定 notes.md' }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.file-viewer-toolbar').waitFor();
  await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
  await page.locator('.output-file').filter({ hasText: '工作约定 notes.md' }).waitFor();
  await page.locator('.output-file').filter({ hasText: 'diagram.svg' }).waitFor();
  check(await page.locator('.output-file').count() === 2, 'Only this conversation’s written/delivered files appear, not every project file');
  check(await page.locator('.chat-input-textarea').count() === 1, 'Outputs must not add a composer');
  check(await page.locator('.outputs-pin-row, .output-pin-button').count() === 0, 'Files require no manual pin or chooser');
  await page.screenshot({ path: `${outputDir}/workflow-outputs.png` });
  await page.locator('.output-file').filter({ hasText: '工作约定 notes.md' }).click();
  await page.locator('.file-viewer-toolbar').waitFor();
  checks.push('outputs: automatically reads write records and delivery links; one-click existing file preview');

  await visit('workspace-design-fixture');
  const toggle = page.locator('[data-right-panel-toggle]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
  await page.locator('.output-file').filter({ hasText: '工作约定 notes.md' }).waitFor();
  await openMenu('Polish second conversation');
  await dialog.getByRole('option').filter({ hasText: 'Polish second conversation' }).click();
  await page.locator('.outputs-empty').waitFor();
  check(await page.locator('.output-file').count() === 0, 'Another conversation must not inherit outputs');
  checks.push('outputs: derived again after reload, isolated by conversation without browser-local pins');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMenu('');
  check(await page.locator('.quick-actions-surface').evaluate(node => getComputedStyle(node).animationName) === 'none', 'Reduced motion removes popover animation');
  await page.screenshot({ path: `${outputDir}/workflow-quick-actions.png` });
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
  checks.push('native polish: reduced motion and bounded layout; no model requests or page errors');

  const renameRequests = [];
  const collectRename = request => {
    if (new URL(request.url()).pathname === '/api/sessions/workspace-other-fixture' && request.method() === 'PATCH') renameRequests.push(request.postDataJSON());
  };
  page.on('request', collectRename);
  await openMenu('rename');
  await dialog.getByRole('option').filter({ hasText: 'Rename this conversation' }).click();
  const renameInput = page.locator('.session-tree-rename');
  await renameInput.waitFor();
  check(await renameInput.evaluate(node => document.activeElement === node), 'Rename focuses the existing sidebar editor');
  await renameInput.fill('CANCELLED_RENAME'); await renameInput.press('Escape');
  await renameInput.waitFor({ state: 'hidden' });
  check(renameRequests.length === 0, 'Escape cancels Rename without writing');
  await openMenu('rename');
  await dialog.getByRole('option').filter({ hasText: 'Rename this conversation' }).click();
  await renameInput.waitFor(); await renameInput.fill('Renamed polish conversation');
  const renameResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/workspace-other-fixture' && response.request().method() === 'PATCH');
  await renameInput.press('Enter');
  check((await renameResponse).ok(), 'Rename saves through the existing session API');
  await page.locator('[data-row-key$=":workspace-other-fixture"] a.session-tree-main').filter({ hasText: 'Renamed polish conversation' }).waitFor();
  check(renameRequests.length === 1 && renameRequests[0].name === 'Renamed polish conversation', 'Rename writes once to the current conversation');
  page.off('request', collectRename);
  checks.push('rename: existing inline editor, Escape cancels, Enter saves the exact current conversation');

  await openMenu('Finder');
  const finderResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/open-in-explorer' && response.request().method() === 'POST');
  await dialog.getByRole('option').filter({ hasText: 'Open conversation folder in Finder' }).click();
  await finderResponse;
  check(finderRequests.length === 1 && finderRequests[0].cwd === project, 'Finder uses the current conversation working directory, with OS launch intercepted');
  await openMenu('Fork');
  const forkResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/workspace-other-fixture/fork' && response.request().method() === 'POST');
  await dialog.getByRole('option').filter({ hasText: 'Fork this conversation' }).click();
  const forkReply = await (await forkResponse).json();
  check(forkReply.session?.relation?.originSessionId === 'workspace-other-fixture', 'Fork copies the current conversation, not another search result');
  await page.locator(`[data-row-key$=":${forkReply.session.id}"] a.session-tree-main[aria-current="true"]`).waitFor();
  check(!commands.some(command => ['prompt', 'steer', 'follow_up', 'abort', 'fork', 'fork_branch', 'clone'].includes(command.type)), 'No model prompts, stops or in-place agent forks');
  check(errors.length === 0, errors.join('\n'));
  checks.push('commands: six actions first, Finder cwd through existing API, current-conversation disk Fork opens the copy without agent mutation');
  return { passed: true, mocked: true, realModelRequests: 0, checks };
}
