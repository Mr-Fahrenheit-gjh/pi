#!/usr/bin/env node
// Agent-facing entry point. Finds the agent-browser's current tab by itself, picks the saved
// account for that site, and fills it through fill.mjs. Never prints passwords.
//
//   node pw.mjs accounts [--session NAME]
//   node pw.mjs fill [--session NAME] [--account USERNAME] [--user-selector CSS] [--password-selector CSS]
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fill, CDP} from './fill.mjs';
import {candidates} from './accounts.mjs';

const HINTS = {
  CREDENTIAL_MISSING: '钥匙串里没有这个网站/账号的密码。请让用户手动登录，或先把密码导入钥匙串。',
  SYSTEM_PERMISSION: '没能读取钥匙串（可能已锁定、弹出了授权窗口，或用户关闭了填充开关）。请用户处理系统弹窗后再试一次；不要循环重试。',
  ELEMENT_CHANGED_OR_UNSUPPORTED: '没找到唯一的账号/密码输入框，或页面在填写过程中变化了。先 snapshot 看页面；必要时用 --user-selector/--password-selector 指定输入框。',
  NO_ACCOUNT: '钥匙串里没有这个网站的已保存账号。请让用户手动登录。',
  AMBIGUOUS: '这个网站保存了多个账号，请用 --account 指定其中一个。',
  NO_BROWSER: '当前任务的 agent-browser 页面不可用，停止填写。不要为填密码另开或切换浏览器会话。',
  NOT_HTTPS: '当前页不是 https 网站，不填写。',
};

/** @param {string[]} argv */
function parse(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string,string>} */ const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--session', '--account', '--user-selector', '--password-selector'].includes(key) || rest[i + 1] === undefined) throw new Error('USAGE');
    opts[key.slice(2)] = rest[i + 1];
  }
  return {command, opts};
}

/** Run agent-browser in JSON mode on the same session the agent uses.
 * @param {string|undefined} session @param {string[]} args @returns {Promise<any>} */
function browser(session, args) {
  return new Promise((yes, no) => {
    const p = spawn('agent-browser', [...(session ? ['--session', session] : []), '--json', ...args], {stdio: ['ignore', 'pipe', 'ignore']});
    let text = '';
    p.stdout.on('data', b => { text += b; });
    p.on('error', () => no(new Error('NO_BROWSER')));
    p.on('close', () => { try { const j = JSON.parse(text); if (!j.success) throw 0; yes(j.data); } catch { no(new Error('NO_BROWSER')); } });
  });
}

/** @param {string|undefined} session */
async function currentPage(session) {
  const tabs = (await browser(session, ['tab', 'list'])).tabs ?? [];
  const tab = tabs.find(/** @param {any} t */ t => t.active && t.type === 'page');
  if (!tab) throw new Error('NO_BROWSER');
  const data = await browser(session, ['get', 'cdp-url']);
  const endpoint = data.cdpUrl ?? data.url;
  let origin;
  try { origin = new URL(tab.url).origin; } catch { throw new Error('NOT_HTTPS'); }
  if (!origin.startsWith('https://')) throw new Error('NOT_HTTPS');
  return {endpoint, targetId: tab.targetId, origin, url: tab.url};
}

/** Resolve CSS selectors the agent saw in its snapshot to the exact main-document nodes fill.mjs binds to.
 * @param {string} endpoint @param {string} targetId @param {string|undefined} userSelector @param {string} passwordSelector */
async function observeSelection(endpoint, targetId, userSelector, passwordSelector) {
  const c = await CDP.connect(endpoint);
  let sid;
  try {
    sid = (await c.send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
    const s = sid;
    /** @template {keyof import('./cdp-types.js').Results} M @param {M} m @param {Record<string,unknown>} [p] */
    const send = (m, p = {}) => c.send(m, p, s);
    const before = (await send('Page.getFrameTree')).frameTree.frame;
    /** @param {string} selector */
    const node = async selector => {
      const r = await send('Runtime.evaluate', {expression: `(()=>{const a=document.querySelectorAll(${JSON.stringify(selector)});if(a.length!==1||!(a[0] instanceof HTMLInputElement))throw 0;return a[0];})()`, returnByValue: false});
      if (r.exceptionDetails || !r.result.objectId) throw new Error('ELEMENT_CHANGED_OR_UNSUPPORTED');
      return (await send('DOM.describeNode', {objectId: r.result.objectId})).node.backendNodeId;
    };
    const selection = {frameId: before.id, loaderId: before.loaderId, passwordSelector, passwordBackendNodeId: await node(passwordSelector),
      ...(userSelector ? {usernameSelector: userSelector, usernameBackendNodeId: await node(userSelector)} : {})};
    const after = (await send('Page.getFrameTree')).frameTree.frame;
    if (after.loaderId !== before.loaderId) throw new Error('ELEMENT_CHANGED_OR_UNSUPPORTED');
    return selection;
  } catch (e) {
    throw e instanceof Error && e.message in HINTS ? e : new Error('ELEMENT_CHANGED_OR_UNSUPPORTED');
  } finally {
    if (sid) await c.send('Target.detachFromTarget', {sessionId: sid}).catch(() => {});
    c.close();
  }
}

/** @param {string[]} argv @param {{fill?: typeof fill, candidates?: typeof candidates, currentPage?: typeof currentPage, observeSelection?: typeof observeSelection}} [deps] */
export async function main(argv, deps = {}) {
  const d = {fill, candidates, currentPage, observeSelection, ...deps};
  let parsed;
  try { parsed = parse(argv); } catch { return {status: 'USAGE', hint: 'node pw.mjs accounts|fill [--session NAME] [--account USERNAME] [--user-selector CSS --password-selector CSS]'}; }
  const {command, opts} = parsed;
  if (!['accounts', 'fill'].includes(command)) return {status: 'USAGE', hint: 'command 必须是 accounts 或 fill'};
  try {
    const page = await d.currentPage(opts.session);
    /** @type {{origin:string,username:string,match:string}[]} */ let list;
    try { list = await d.candidates(page.origin); } catch { list = []; }
    if (command === 'accounts') return {status: 'OK', page: page.origin, accounts: list};
    if ((opts['user-selector'] && !opts['password-selector'])) return {status: 'USAGE', hint: '--user-selector 需要同时给出 --password-selector'};
    let chosen = opts.account ? list.filter(a => a.username === opts.account) : list;
    if (chosen.length > 1 && chosen.some(a => a.match === 'exact')) chosen = chosen.filter(a => a.match === 'exact');
    if (!chosen.length) return {status: 'FAILED', reason: 'NO_ACCOUNT', page: page.origin, hint: HINTS.NO_ACCOUNT, available: list.map(a => a.username)};
    if (chosen.length > 1) return {status: 'NEED_ACCOUNT', page: page.origin, hint: HINTS.AMBIGUOUS, accounts: chosen.map(a => a.username)};
    const account = chosen[0];
    const selection = opts['password-selector'] ? await d.observeSelection(page.endpoint, page.targetId, opts['user-selector'], opts['password-selector']) : undefined;
    const result = await d.fill({endpoint: page.endpoint, targetId: page.targetId, origin: page.origin, username: account.username,
      ...(account.origin !== page.origin ? {credentialOrigin: account.origin} : {}), ...(selection ? {selection} : {})});
    if (result.status === 'FILLED_NOT_SUBMITTED') return {status: 'FILLED', account: account.username, page: page.origin, hint: '已填写，未提交。处理验证码（如有）后点击登录，再确认是否登录成功。'};
    return {status: 'FAILED', reason: result.category, page: page.origin, account: account.username, mayHaveFilled: result.mayHaveFilled, hint: HINTS[/** @type {keyof typeof HINTS} */ (result.category)] ?? HINTS.ELEMENT_CHANGED_OR_UNSUPPORTED};
  } catch (e) {
    const reason = e instanceof Error && e.message in HINTS ? e.message : 'NO_BROWSER';
    return {status: 'FAILED', reason, hint: HINTS[/** @type {keyof typeof HINTS} */ (reason)]};
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await main(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 1));
  process.exitCode = out.status === 'OK' || out.status === 'FILLED' ? 0 : 1;
}
