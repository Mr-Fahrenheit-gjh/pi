import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareWorkspaceFixture } from './workspace-design.mjs';

export function prepareAnswerBubbleFixture(agentDir) {
  const fixture = prepareWorkspaceFixture(agentDir);
  const file = join(agentDir, 'sessions/design/workspace-design-fixture.jsonl');
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const answer = entries.find(entry => entry.id === 'answer').message;
  answer.durationMs = 4000;
  answer.usage.output = 100;
  answer.content[0].text += '\n\n```ts\nconst sample = "' + 'long-code-'.repeat(35) + '";\n```\n\n| 项目 | 描述 | 结果 |\n| --- | --- | --- |\n| 气泡 | ' + '宽表格内容'.repeat(40) + ' | 保持可读 |';
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const archive = entries.map(entry => structuredClone(entry));
  archive[0].id = 'workspace-archived-fixture'; archive[1].name = '仅供验证的已归档对话';
  writeFileSync(join(agentDir, 'sessions/design/workspace-archived-fixture.jsonl'), archive.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  writeFileSync(join(agentDir, 'pi-web-session-state.json'), JSON.stringify({ version: 1, revision: 1, sessions: { 'workspace-archived-fixture': { archivedAt: Date.now() + 3600000 } }, projects: {} }));
  return fixture;
}

export async function runAnswerBubbleChecks(page, { baseURL, outputDir }) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL)) throw Error('Candidate required');
  await page.setViewportSize({ width: 1280, height: 900 });
  const checks = [];
  for (const theme of ['claude-white', 'dark']) {
    await page.addInitScript(theme => { if (location.protocol === 'http:') localStorage.setItem('pi-theme', theme); }, theme);
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: 'networkidle' });
    const bubble = page.locator('.assistant-answer-bubble').last();
    await bubble.waitFor();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    check(await page.locator('.assistant-answer-bubble [data-model-label], .assistant-answer-bubble .message-footer').count() === 0, 'Identity/footer must stay outside answer');
    check(await page.locator('[data-model-label]').count() > 0, 'Model identity preserved outside bubble');
    check(await bubble.locator('.markdown-table-wrap, pre').count() >= 2, 'Rich content retained');
    const answer = bubble.locator('.markdown-assistant-message').first();
    check((await answer.evaluate(node => getComputedStyle(node).fontFamily)).includes('Georgia'), 'Answer serif font preserved');
    const parent = bubble.locator('xpath=..').locator('xpath=..');
    const footer = parent.locator('.assistant-message-footer');
    await page.mouse.move(1200, 30);
    await page.waitForFunction(() => [...document.querySelectorAll('.assistant-message-footer')].every(node => getComputedStyle(node).opacity === '0'));
    check(await footer.evaluate(node => getComputedStyle(node).opacity) === '0', 'Footer stays quiet at rest');
    await bubble.hover();
    await page.waitForFunction(() => [...document.querySelectorAll('.assistant-message-footer')].some(node => getComputedStyle(node).opacity === '1'));
    check(await footer.locator('.message-output-rate').innerText() === '25.0 t/s', 'Rate uses recorded output/duration');
    await footer.getByRole('button', { name: '复制', exact: true }).focus();
    await page.mouse.move(1200, 30);
    check(await footer.evaluate(node => getComputedStyle(node).opacity) === '1', 'Keyboard-focused copy keeps footer visible');
    const colors = await page.evaluate(() => ({ answer: getComputedStyle(document.querySelector('.assistant-answer-bubble')).backgroundColor, user: getComputedStyle(document.querySelector('.markdown-user-message').closest('[style*="background"]')).backgroundColor }));
    check(colors.answer !== colors.user, 'Assistant and user colors must differ');
    await page.screenshot({ path: `${outputDir}/answer-bubble-${theme}.png` });
    checks.push(`${theme}: answer-only bubble, distinct user color, preserved typography, hover/focus copy and recorded25t/s`);
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow ${theme}/${width}`);
      for (const node of await page.locator('.assistant-answer-bubble').all()) {
        check(await node.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `Bubble overflow ${theme}/${width}`);
      }
    }
  }
  return { passed: true, mocked: true, realModelRequests: 0, checks };
}
