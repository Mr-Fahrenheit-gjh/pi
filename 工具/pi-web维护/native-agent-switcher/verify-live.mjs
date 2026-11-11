// Real-service acceptance: reads history; the optional UI bundle creates/closes one test PTY. No model requests.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHistoryFixture } from './history-fixture.mjs';
import { execFileSync } from 'node:child_process';
const here = process.env.PI_WEB_VERIFY_OUTPUT_DIR || fileURLToPath(new URL('.', import.meta.url));
const packageRoot = process.env.PI_WEB_VERIFY_PACKAGE_ROOT || '/opt/homebrew/lib/node_modules/@agegr/pi-web';
const [sessionId, expectedBuild, expectedVersion, bundleMode = process.env.PI_WEB_VERIFY_BUNDLE, uiMode = ''] = process.argv.slice(2);
assert.ok(sessionId && expectedBuild, 'session ID and expected build required');
const base = process.env.PI_WEB_VERIFY_BASE || 'http://127.0.0.1:30141';
assert.equal((await readFile(`${packageRoot}/.next/BUILD_ID`, 'utf8')).trim(), expectedBuild);
const installedVersion = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8')).version;
if (expectedVersion) assert.equal(installedVersion, expectedVersion);
const coreVersion = ({ 'pi-core-1.3.0': '1.3.0', 'pi-core-1.4.0': '1.4.0', 'pi-core-1.5.0': '1.5.0', 'web-security-0.14.2': '1.5.0' })[bundleMode];
const basicHistoryMode = !bundleMode || Boolean(coreVersion);
const historyFixture = loadHistoryFixture(sessionId);
// GET /subagents binds the parent runtime in every browser mode. Prove offline
// that it is settled and the exact real run survives BEFORE that first request.
execFileSync('python3', [fileURLToPath(new URL('./history_fixture.py', import.meta.url)), 'check'], { timeout: 20000, stdio: 'pipe' });
const response = await fetch(`${base}/api/agent/${sessionId}/subagents`, { signal: AbortSignal.timeout(60000) });
const fleet = await response.json();
assert.equal(response.status, 200, JSON.stringify(fleet));
assert.equal(fleet.available, true);
const runs = fleet.asyncSnapshot?.runs ?? [];
if (basicHistoryMode) {
  // Same basic release assertions, through the approved existing MCP browser.
  // Dependency/UI-bundle migration remains a separate explicit release mode.
  const { runBrowserCheck } = await import('./playwright-mcp-client.mjs');
  const { verifyRealHistory } = await import('./verify-live-browser.mjs');
  try {
    const icon = await fetch(`${base}/icons/pi-mark.svg`);
    assert.equal(icon.status, 200);
    const svg = await icon.text();
    for (const color of ['#F09082', '#4D9ABF', '#F1BE58']) assert.ok(svg.includes(color));
    const smoke = runs.find(run => run.id === historyFixture.runId);
    assert.ok(smoke, 'Persisted exact real history run must survive restart and be listed');
    smoke.expectedText = historyFixture.expectedText;
    const childResponse = await fetch(`${base}/api/agent/${sessionId}/subagents?id=${smoke.id}&view=chat`, { signal: AbortSignal.timeout(60000) });
    const child = await childResponse.json();
    assert.equal(childResponse.status, 200, JSON.stringify(child));
    assert.ok(child.messages?.some(message => JSON.stringify(message.content).includes(historyFixture.expectedText)), 'Real child output must be readable');
    const acceptance = await runBrowserCheck(verifyRealHistory, { base, sessionId, here, smoke });
    assert.equal(acceptance.realChildVerified, true);
    if (coreVersion) {
      const { verifyCoreRuntime } = await import('./verify-core-runtime.mjs');
      Object.assign(acceptance, await verifyCoreRuntime(packageRoot, coreVersion));
    }
    const evidence = { ...acceptance, realHistoryRunId: historyFixture.runId, expectedChildText: historyFixture.expectedText, passed: true, at: new Date().toISOString(), buildId: expectedBuild, version: installedVersion, sessionId, base, packageRoot, mocked: false, browserBackend: 'playwright-mcp', realModelRequests: 0, officialPiMarkServed: true, packageRpcAvailable: true, retainedRuns: runs.length };
    await writeFile(`${here}live-result.json`, JSON.stringify(evidence, null, 2) + '\n');
    if (process.env.PI_WEB_VERIFY_SMOKE_OUTPUT) await writeFile(process.env.PI_WEB_VERIFY_SMOKE_OUTPUT, JSON.stringify(evidence, null, 2) + '\n');
  } catch (error) {
    const failed = { passed: false, at: new Date().toISOString(), buildId: expectedBuild, packageRoot, sessionId, error: String(error) };
    await writeFile(`${here}live-result.json`, JSON.stringify(failed, null, 2) + '\n');
    if (process.env.PI_WEB_VERIFY_SMOKE_OUTPUT) await writeFile(process.env.PI_WEB_VERIFY_SMOKE_OUTPUT, JSON.stringify(failed, null, 2) + '\n');
    throw error;
  }
  // MCP's HTTP pool can retain an idle socket after client.close(). Evidence
  // is fully written above; this CLI must terminate for the deployment gate.
  process.exit(0);
} else {
const { verifyUnifiedUi } = await import('./verify-live-ui.mjs');
const { chromium } = await import('../pi-web-source-0.12.1-custom/node_modules/playwright/index.mjs');
const { expect } = await import('../pi-web-source-0.12.1-custom/node_modules/playwright/test.mjs');
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
  const switcher = page.getByRole('button', { name: '代理切换', exact: true });
  const returnToParent = async () => {
    await switcher.click();
    await page.getByRole('option').filter({ has: page.getByText('主 Agent', { exact: true }) }).click();
  };
  await switcher.waitFor();
  assert.equal(await page.getByRole('region', { name: '子代理切换与记录' }).count(), 0);
  await page.locator('[data-process-details]').first().waitFor();
  assert.equal(await page.locator('[data-process-details] > button[aria-expanded="true"]').count(), 0);
  assert.equal(await page.locator('[data-process-details] > [role="status"]').filter({ hasText: '工具执行失败' }).count(), 0);
  // Scrolling to the first turn loads older history and changes what first() targets.
  // This inactive real session's tail stays stable when history is prepended.
  const process = page.locator('[data-process-details] > button').last();
  for (let attempt = 0; attempt < 3; attempt++) {
    await process.click(); await expect(process).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 });
    await process.click(); await expect(process).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 });
  }
  await page.locator('.markdown-assistant-message').first().waitFor();
  const answerFont = await page.locator('.markdown-assistant-message').first().evaluate(el => getComputedStyle(el).fontFamily);
  assert.ok(answerFont.includes('Georgia'));
  assert.equal(await page.locator('.markdown-user-message').first().evaluate(el => getComputedStyle(el).fontFamily), answerFont);
  const icon = await fetch(`${base}/icons/pi-mark.svg`);
  assert.equal(icon.status, 200);
  const svg = await icon.text();
  for (const color of ['#F09082', '#4D9ABF', '#F1BE58']) assert.ok(svg.includes(color));
  await page.locator('[data-model-label] use[href="/provider-icons.svg#openai"]').first().waitFor();
  await page.locator('[data-model-selector-trigger] use[href="/provider-icons.svg#openai"]').waitFor();
  assert.equal(await page.getByText('0.0 t/s', { exact: true }).count(), 0);
  assert.equal(await page.getByText(/^Error: (fetch failed|FETCH FAILED)$/).count(), 0);
  await page.screenshot({ path: `${here}live-main.png` });
  await switcher.click();
  assert.equal(await page.getByRole('button', { name: '任务管理', exact: true }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  // The native agent popover is toggled by its toolbar button, not Escape.
  // Keep it open for the child selection below.
  await page.getByRole('listbox').waitFor();
  let childVerified = false;
  const smoke = runs.find(run => run.id === '184ba6e2-ce63-48db-b4eb-8b205a05bc41');
  assert.ok(smoke, 'Persisted real smoke run must survive restart and be listed');
  if (smoke) {
    const childResponse = await fetch(`${base}/api/agent/${sessionId}/subagents?id=${smoke.id}&view=chat`, { signal: AbortSignal.timeout(60000) });
    const child = await childResponse.json();
    assert.equal(childResponse.status, 200, JSON.stringify(child));
    assert.ok(child.messages?.some(message => JSON.stringify(message.content).includes('SUBAGENT_UPDATE_SMOKE_OK')), 'Real child output must be readable');
    const candidates = page.getByRole('option').filter({ hasText: smoke.label });
    // Opening the popover does not synchronously commit the async fleet rows.
    await candidates.first().waitFor();
    const count = await candidates.count();
    let selectedSmoke = false;
    for (let index = 0; index < count; index++) {
      const loaded = page.waitForResponse(response => response.url().includes('/subagents?view=chat'));
      await candidates.nth(index).click();
      const recordResponse = await loaded;
      const selectedId = new URL(recordResponse.url()).searchParams.get('id');
      await recordResponse.finished();
      if (selectedId === smoke.id) { selectedSmoke = true; break; }
      await returnToParent();
      await switcher.click();
    }
    assert.ok(selectedSmoke, 'Selected the exact retained smoke run, not another identically named delegate');
    await page.getByText('SUBAGENT_UPDATE_SMOKE_OK', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '返回主代理', exact: true }).count(), 0);
    assert.equal(await page.getByText(/输入仍发给主代理/).count(), 0);
    await page.screenshot({ path: `${here}live-child.png` });
    await returnToParent();
    childVerified = true;
  }
  const bundleAcceptance = bundleMode === 'ghostty-0.4.0'
    ? await verifyUnifiedUi({ page, context, base, packageRoot, here, sessionId, uiPolish: uiMode === 'sidebar-browser' })
    : {};
  await writeFile(`${here}live-result.json`, JSON.stringify({ ...bundleAcceptance, passed: true, at: new Date().toISOString(), buildId: expectedBuild, version: installedVersion, sessionId, base, packageRoot, mocked: false, realModelRequests: 0, quietToolsCollapsed: true, toolFailureSummaryHidden: true, claudeStyleTypography: true, userBubbleTypography: true, modelManufacturerIcons: true, officialPiMarkServed: true, zeroSpeedBadgeAbsent: true, fetchErrorsCollapsed: true, switcherVisible: true, taskManagementHidden: true, packageRpcAvailable: true, retainedRuns: runs.length, realChildVerified: childVerified, redundantChildBarAbsent: childVerified }, null, 2) + '\n');
} catch (error) {
  await writeFile(`${here}live-result.json`, JSON.stringify({ passed: false, at: new Date().toISOString(), buildId: expectedBuild, error: String(error) }, null, 2) + '\n');
  throw error;
} finally { await browser?.close(); }
}
