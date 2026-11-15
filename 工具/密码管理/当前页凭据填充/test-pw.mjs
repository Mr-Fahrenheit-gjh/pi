// Synthetic only: local HTTPS fixture, isolated agent-browser HOME, in-memory secret. No Keychain/real sites.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import {siteOf} from './accounts.mjs';

const root = await mkdtemp(join(tmpdir(), 'pw-test-'));
process.env.HOME = root;
process.env.AGENT_BROWSER_SOCKET_DIR = root;
const {main} = await import('./pw.mjs');
const {fill} = await import('./fill.mjs');
const session = 'synthetic-pw';
const secret = 'SYNTHETIC-pw-only-7#';
let posts = 0;
/** @type {https.Server|undefined} */ let server;
const ab = async (/** @type {string[]} */ ...args) => (await promisify(execFile)('agent-browser', ['--session', session, ...args], {env: process.env})).stdout;

// Same-site rules.
assert.equal(siteOf('https://jaccount.sjtu.edu.cn'), 'sjtu.edu.cn');
assert.equal(siteOf('https://www.github.com'), 'github.com');
assert.equal(siteOf('https://alice.github.io'), null);
assert.equal(siteOf('https://a.b.co.uk'), 'b.co.uk');

// Pure selection logic with stubbed page/inventory.
const page = {endpoint: 'ws://x', targetId: 'T', origin: 'https://login.example.com', url: 'https://login.example.com/'};
/** @type {any[]} */ let calls = [];
const stubs = (/** @type {any[]} */ list) => ({currentPage: async () => page, candidates: async () => list,
  fill: async (/** @type {any} */ req) => { calls.push(req); return {status: 'FILLED_NOT_SUBMITTED', loginVerified: false}; }});
const one = [{origin: 'https://www.example.com', username: 'me@x.com', match: 'same-site'}];
let out = await main(['fill'], stubs(one));
assert.equal(out.status, 'FILLED');
assert.equal(calls[0].credentialOrigin, 'https://www.example.com');
assert.equal(calls[0].username, 'me@x.com');
calls = [];
out = await main(['fill'], stubs([...one, {origin: 'https://login.example.com', username: 'b', match: 'exact'}, {origin: 'https://login.example.com', username: 'c', match: 'exact'}]));
assert.equal(out.status, 'NEED_ACCOUNT');
assert.deepEqual(out.accounts, ['b', 'c']);
assert.equal(calls.length, 0);
out = await main(['fill', '--account', 'c'], stubs([{origin: 'https://login.example.com', username: 'c', match: 'exact'}, ...one]));
assert.equal(out.status, 'FILLED');
assert.equal(calls[0].credentialOrigin, undefined);
out = await main(['fill', '--account', 'nobody'], stubs(one));
assert.equal(out.reason, 'NO_ACCOUNT');
out = await main(['fill', '--bogus', 'x'], stubs(one));
assert.equal(out.status, 'USAGE');
out = await main(['fill'], {...stubs(one), currentPage: async () => { throw new Error('NOT_HTTPS'); }});
assert.equal(out.reason, 'NOT_HTTPS');
out = await main(['fill'], {...stubs(one), fill: async () => ({status: 'REFUSED_OR_CHANGED', stage: 'resolve', category: 'CREDENTIAL_MISSING', mayHaveFilled: false, loginVerified: false})});
assert.equal(out.reason, 'CREDENTIAL_MISSING');
assert.ok(!JSON.stringify(out).includes(secret));

// fill.mjs refuses a credential from a different site before touching the browser or Keychain.
let resolved = 0;
const deps = {permission: async () => ({scope: 'x', revision: 'r', expires: null}), resolve: async (/** @type {any} */ r) => { resolved++; return {username: r.username, password: secret}; }};
const refused = await fill({endpoint: 'ws://127.0.0.1:1/devtools/browser/00000000-0000-0000-0000-000000000000', targetId: '0'.repeat(32), origin: 'https://login.example.com', username: 'u', credentialOrigin: 'https://evil.com'}, deps);
assert.equal(refused.status, 'REFUSED_OR_CHANGED');
assert.equal(refused.stage, 'target');
const shared = await fill({endpoint: 'ws://127.0.0.1:1/devtools/browser/00000000-0000-0000-0000-000000000000', targetId: '0'.repeat(32), origin: 'https://bob.github.io', username: 'u', credentialOrigin: 'https://alice.github.io'}, deps);
assert.equal(shared.stage, 'target');
assert.equal(resolved, 0);

// Real agent-browser: pw.mjs discovers the active tab and resolves observed selectors.
try {
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key'), '-out', join(root, 'cert'), '-days', '1', '-subj', '/CN=localhost'], {stdio: 'ignore'});
  server = https.createServer({key: await readFile(join(root, 'key')), cert: await readFile(join(root, 'cert'))}, (req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<form method="POST"><input id="el-id-91" placeholder="用户名/邮箱"><input id="pw" type="password"><input name="captcha"><button>Go</button></form>');
  });
  const srv = server;
  await new Promise(r => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const origin = `https://localhost:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  await ab('--ignore-https-errors', 'open', origin);
  // Inventory lookup is stubbed (fixture has a port); fill is real with an in-memory secret.
  const real = {candidates: async () => [{origin, username: 'synthetic-user', match: 'exact'}], fill: (/** @type {any} */ req) => fill(req, deps)};
  out = await main(['accounts', '--session', session], real);
  assert.equal(out.status, 'OK');
  assert.equal(out.page, origin);
  // No trusted username field (placeholder only) → automatic detection refuses before reading the secret.
  out = await main(['fill', '--session', session], real);
  assert.equal(out.reason, 'ELEMENT_CHANGED_OR_UNSUPPORTED');
  assert.equal(resolved, 0);
  out = await main(['fill', '--session', session, '--user-selector', '#el-id-91', '--password-selector', '#pw'], real);
  assert.equal(out.status, 'FILLED', JSON.stringify(out));
  assert.equal(resolved, 1);
  assert.equal(JSON.parse(await ab('--json', 'eval', 'document.querySelector("#el-id-91").value')).data.result, 'synthetic-user');
  assert.equal(JSON.parse(await ab('--json', 'eval', 'document.querySelector("[name=captcha]").value')).data.result, '');
  out = await main(['fill', '--session', session, '--user-selector', '#missing', '--password-selector', '#pw'], real);
  assert.equal(out.reason, 'ELEMENT_CHANGED_OR_UNSUPPORTED');
  assert.equal(posts, 0);
  assert.ok(!JSON.stringify(out).includes(secret));
  console.log('PASS pw.mjs: same-site rules, account choice, refusals, real-browser tab discovery + observed selectors, no submit');
} finally {
  try { await ab('close'); } catch {}
  server?.close();
  await rm(root, {recursive: true, force: true});
}
