// Browser checks use the existing headless/independent-profile MCP service.
// No browser launch, browser installation, user Chrome connection or fallback.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseBrowserResult(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const text = result.content?.find(item => item.type === 'text' && item.text?.startsWith('### Result\n'))?.text;
  if (!text) throw new Error('playwright-mcp did not return structured browser evidence');
  const json = text.slice('### Result\n'.length).split('\n### Ran Playwright code')[0];
  return JSON.parse(json);
}

export async function runBrowserCheck(check, options) {
  const require = createRequire(join(homedir(), '.pi/agent/npm/package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
  const client = new Client({ name: 'pi-web-maintenance-check', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8931/mcp')));
    const available = new Set((await client.listTools()).tools.map(tool => tool.name));
    if (!available.has('browser_run_code_unsafe') || !available.has('browser_close')) {
      throw new Error('Required playwright-mcp tools are unavailable; no fallback');
    }
    // Use a new page in MCP's independent context; do not reuse or close an
    // unrelated tab another check may have opened through this service.
    const code = `async (page) => { const owned = await page.context().newPage(); try { return await (${check.toString()})(owned, ${JSON.stringify(options)}); } finally { await owned.close(); } }`;
    const result = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } }, undefined, { timeout: 240000 });
    return parseBrowserResult(result);
  } finally {
    // Do not close the supplied anchor: it may belong to another client.
    // The check's own page is always closed by the snippet's finally block.
    await client.close();
  }
}
