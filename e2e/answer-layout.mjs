import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareWorkspaceFixture } from './workspace-design.mjs';

export function prepareAnswerLayoutFixture(agentDir) {
  const fixture = prepareWorkspaceFixture(agentDir);
  const file = join(agentDir, 'sessions/design/workspace-design-fixture.jsonl');
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const answer = entries.find(entry => entry.id === 'answer').message;
  answer.durationMs = 4000; answer.usage.output = 100;
  answer.content[0].text += '\n\n```ts\nconst sample = "' + 'long-code-'.repeat(35) + '";\n```\n\n| 项目 | 描述 | 结果 |\n| --- | --- | --- |\n| 正文 | ' + '宽表格内容'.repeat(40) + ' | 保持可读 |';
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const archive = entries.map(entry => structuredClone(entry));
  archive[0].id = 'workspace-archived-fixture'; archive[1].name = '仅供验证的已归档对话';
  writeFileSync(join(agentDir, 'sessions/design/workspace-archived-fixture.jsonl'), archive.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  writeFileSync(join(agentDir, 'pi-web-session-state.json'), JSON.stringify({ version: 1, revision: 1, sessions: { 'workspace-archived-fixture': { archivedAt: Date.now() + 3600000 } }, projects: {} }));
  return fixture;
}

export async function runAnswerLayoutChecks(page, { baseURL, outputDir }) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw Error('Candidate required');
  const checks = [];
  for (const theme of ['claude-white', 'dark']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(theme => { if (location.protocol === 'http:') localStorage.setItem('pi-theme', theme); }, theme);
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: 'networkidle' });
    const answer = page.locator('.assistant-response-content').last();
    await answer.waitFor();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    check(await page.locator('.assistant-answer-bubble').count() === 0, 'No assistant answer bubble');
    const paint = await answer.evaluate(node => { const s = getComputedStyle(node); return [s.backgroundColor, s.borderTopWidth, s.paddingTop, s.paddingLeft]; });
    check(paint.join('|') === 'rgba(0, 0, 0, 0)|0px|0px|0px', 'Answer has no surface, border or padding');
    check(await page.locator('[data-model-label]').count() > 0, 'Model identity preserved');
    check(await answer.locator('.markdown-table-wrap, pre').count() >= 2, 'Rich content retained');
    check((await answer.locator('.markdown-assistant-message').first().evaluate(node => getComputedStyle(node).fontFamily)).includes('Georgia'), 'Answer typography preserved');
    const user = page.locator('.markdown-user-message').first();
    check(await user.evaluate(node => getComputedStyle(node.closest('[style*="background"]')).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'User message bubble retained');
    const footer = answer.locator('xpath=..').locator('.assistant-message-footer');
    await page.mouse.move(1250, 30);
    await page.waitForFunction(() => [...document.querySelectorAll('.assistant-message-footer')].every(node => getComputedStyle(node).opacity === '0'));
    await answer.hover();
    await page.waitForFunction(() => [...document.querySelectorAll('.assistant-message-footer')].some(node => getComputedStyle(node).opacity === '1'));
    check(await footer.locator('.message-output-rate').innerText() === '25.0 t/s', 'Reliable speed retained');
    await footer.getByRole('button', { name: '复制', exact: true }).focus();
    await page.mouse.move(1250, 30);
    check(await footer.evaluate(node => getComputedStyle(node).opacity) === '1', 'Keyboard copy stays usable');
    await page.screenshot({ path: `${outputDir}/answer-unframed-${theme}.png` });
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow ${theme}/${width}`);
    }
    checks.push(`${theme}: unframed answer, user bubble and identity retained, copy/rate and 1280/820/390 layout preserved`);
  }
  return { passed: true, mocked: true, realModelRequests: 0, checks };
}
