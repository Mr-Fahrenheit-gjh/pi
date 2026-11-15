import {accountUsername,siteOf} from './accounts.mjs';
import {spawn} from 'node:child_process';
import {readFile, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const permissionPath = `${homedir()}/.pi-current-page-fill/permission.json`;
/** @returns {never} */
const refuse = () => {throw new Error('REFUSED');};
/** @param {unknown} expires */
export const validExpiry = expires => expires === null || (typeof expires === 'number' && Number.isFinite(expires) && expires*1000 > Date.now());
/** @returns {Promise<import('./cdp-types.js').Permission>} */
export async function permission() {
  for (const [path, mode] of /** @type {const} */ ([[`${homedir()}/.pi-current-page-fill`, 0o700], [permissionPath, 0o600]])) {
    const s = await lstat(path);
    if(s.isSymbolicLink() || s.uid !== /** @type {() => number} */ (process.getuid)() || (s.mode & 0o777) !== mode) refuse();
  }
  const p = JSON.parse(await readFile(permissionPath, 'utf8'));
  if(p.scope !== 'inventory-current-main-https-fill-only' || typeof p.revision !== 'string' || !validExpiry(p.expires)) refuse();
  return p;
}
/** @param {import('./cdp-types.js').ResolveRequest} req
 * @returns {Promise<import('./cdp-types.js').Credential>} */
async function resolve(req) {
  return new Promise((yes, no) => {
    const child = spawn('python3', ['-I', fileURLToPath(new URL('./permission.py', import.meta.url)), 'private-consume'], {stdio:['pipe','ignore','ignore','pipe'], env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin', HOME:homedir()}});
    let data = '', size = 0;
    const timer = setTimeout(()=>{child.kill();no(new Error('REFUSED'));}, 20000);
    /** @type {import('node:stream').Readable} */ (child.stdio[3]).on('data', b=>{size+=b.length;if(size>32768){child.kill();return;}data+=b.toString();});
    child.on('error', ()=>{clearTimeout(timer);no(new Error('REFUSED'));});
    child.on('close', code=>{clearTimeout(timer);try {if(size>32768) refuse();const parsed=JSON.parse(data);if(['CREDENTIAL_MISSING','SYSTEM_PERMISSION','ELEMENT_CHANGED_OR_UNSUPPORTED'].includes(parsed.failure)){no(new ConsumerFailure(parsed.failure));return;}if(code)refuse();yes(parsed);}catch {no(new Error('REFUSED'));}data='';});
    const stdin=/** @type {import('node:stream').Writable} */ (child.stdin);
    stdin.on('error', ()=>{});
    stdin.end(JSON.stringify(req));
  });
}
class ConsumerFailure extends Error {
  /** @param {string} category */
  constructor(category){super('REFUSED');this.category=category;}
}
export class CDP {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws=ws;
    /** @type {Map<number, {yes: (value: unknown) => void, no: (reason: Error) => void}>} */
    this.pending=new Map();
    this.id=0;
  }
  /** @type {((event: import('./cdp-types.js').CDPEvent) => void) | undefined} */ event;
  /** @param {string} endpoint
   * @returns {Promise<CDP>} */
  static async connect(endpoint) {
    // Literal loopback only, no DNS/proxy/HTTP discovery or arbitrary path/service API.
    if(!/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[a-f0-9-]{36}$/.test(endpoint)) refuse();
    const u=new URL(endpoint);if(Number(u.port)>65535) refuse();
    const c=new CDP(new WebSocket(endpoint));
    await new Promise(/** @param {(value?: void) => void} yes */ (yes,no)=>{const t=setTimeout(()=>{c.ws.close();no(new Error('REFUSED'));},3000);c.ws.onopen=()=>{clearTimeout(t);yes();};c.ws.onerror=()=>{clearTimeout(t);no(new Error('REFUSED'));};});
    c.ws.onmessage=e=>{try{const m=JSON.parse(String(e.data));if(m.id){const f=c.pending.get(m.id);if(f){c.pending.delete(m.id);m.error?f.no(new Error('REFUSED')):f.yes(m.result);}}else c.event?.(m);}catch{}};
    c.ws.onclose=()=>{for(const p of c.pending.values())p.no(new Error('REFUSED'));c.pending.clear();};
    try{const v=await c.send('Browser.getVersion');if(!/^(HeadlessChrome|Chrome)\//.test(v.product)||v.protocolVersion!=='1.3') refuse();return c;}catch{c.close();return refuse();}
  }
  /** @template {keyof import('./cdp-types.js').Results} M
   * @param {M} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<import('./cdp-types.js').Results[M]>} */
  send(method,params={},sessionId) {return new Promise((yes,no)=>{const id=++this.id;const t=setTimeout(()=>{this.pending.delete(id);no(new Error('REFUSED'));},5000);this.pending.set(id,{yes:v=>{clearTimeout(t);yes(/** @type {import('./cdp-types.js').Results[M]} */ (v));},no:e=>{clearTimeout(t);no(e);}});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  close(){this.ws.close();}
}

// Exact semantic tokens only; never infer identity from placeholder or surrounding form text.
const selectUser = `(users)=>{const tokens=e=>[e.name,e.id].flatMap(v=>String(v||'').toLowerCase().split(/[^a-z0-9]+/));const safe=users.filter(e=>!tokens(e).some(t=>['captcha','otp','code','verification','verify','token','totp','recaptcha','hcaptcha'].includes(t))&&!String(e.autocomplete).toLowerCase().split(/\\s+/).includes('one-time-code'));const marked=safe.filter(e=>e.autocomplete==='username');const choices=marked.length?marked:safe.filter(e=>tokens(e).some(t=>['username','user','login','email','account'].includes(t)));return choices.length===1?choices[0]:null;}`;

// Shared capture/setter preflight. Password-only requires current visible identity,
// never hidden input values, substring matches, or caller-asserted evidence.
const inspectForm = `(username,selection)=>{
  const shown=e=>e.getClientRects().length>0&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const inputs=[...document.querySelectorAll('input')];
  const passwords=inputs.filter(e=>e.type==='password'&&shown(e));
  if(passwords.length!==1)return null;
  const password=passwords[0];
  const unique=s=>{if(typeof s!=='string'||!s||s.length>1024)return null;const a=document.querySelectorAll(s);return a.length===1&&a[0] instanceof HTMLInputElement&&a[0].getRootNode()===document?a[0]:null;};
  if(selection&&unique(selection.passwordSelector)!==password)return null;
  if(password.disabled||password.readOnly||inputs.some(e=>e.type==='password'&&(String(e.autocomplete).toLowerCase().split(/\\s+/).includes('new-password')||[e.name,e.id].some(v=>/(^|[^a-z])(new|confirm|confirmation|change|reset)([^a-z]|$)/i.test(v)))))return null;
  const accounts=inputs.filter(e=>shown(e)&&['text','email','tel'].includes(e.type));
  const users=accounts.filter(e=>!e.disabled&&!e.readOnly&&e.form===password.form);
  const user=selection?.usernameSelector?unique(selection.usernameSelector):(${selectUser})(users);
  if(selection?.usernameSelector&&(!user||!users.includes(user)||!user.form||user.form!==password.form||[user.name,user.id].some(v=>/(^|[^a-z])(captcha|otp|code|verification|verify|token|totp|recaptcha|hcaptcha)([^a-z]|$)/i.test(v))||String(user.autocomplete).toLowerCase().split(/\\s+/).includes('one-time-code')))return null;
  if(user)return {user,password};
  // Do not turn ambiguous/unrecognized editable forms into password-only flows.
  if(accounts.some(e=>!e.readOnly))return null;
  if(accounts.length>1)return null;
  if(accounts.length===1){const account=accounts[0];if((${selectUser})(accounts)!==account||account.value!==username)return null;return {user:null,password};}
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let node, matches=0;
  while(node=walker.nextNode()){
    const parent=node.parentElement;
    if(!parent||['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','OPTION','TEXTAREA'].includes(parent.tagName)||!shown(parent)||node.textContent.trim()!==username)continue;
    const range=document.createRange();range.selectNodeContents(node);
    if([...range.getClientRects()].some(r=>r.width>0&&r.height>0))matches++;
  }
  return matches===1?{user:null,password}:null;
}`;

// Optional observed selectors are main-document-only and bound to the observed loader.
// No URL override, secret read, submission, browser launch, or navigation API.
/** @param {import('./cdp-types.js').FillRequest | (Omit<import('./cdp-types.js').FillRequest,'username'> & {accountId:string})} request
 * @param {import('./cdp-types.js').Dependencies} dependencies
 * @returns {Promise<import('./cdp-types.js').FillResult>} */
export async function fill(request, dependencies={permission, resolve}) {
  /** @type {CDP | undefined} */ let c;
  /** @type {string | undefined} */ let sid;
  /** @type {import('./cdp-types.js').Stage} */ let stage='target';
  let mayHaveFilled=false;
  try {
    if('accountId' in request&&('username' in request||typeof request.accountId!=='string'))refuse();
    const req='accountId' in request?await (async()=>{const {accountId,...rest}=request;return {...rest,username:await accountUsername(request.origin,accountId)};})():request;
    if(Object.keys(req).filter(k=>k!=='selection'&&k!=='credentialOrigin').sort().join(',')!=='endpoint,origin,targetId,username') refuse();
    if(req.selection&&(Object.keys(req.selection).some(k=>!['frameId','loaderId','usernameSelector','passwordSelector','usernameBackendNodeId','passwordBackendNodeId'].includes(k))||!req.selection.frameId||!req.selection.loaderId||typeof req.selection.passwordSelector!=='string'||(req.selection.usernameSelector!==undefined&&typeof req.selection.usernameSelector!=='string')))refuse();
    if(req.selection&&(!Number.isSafeInteger(req.selection.passwordBackendNodeId)||req.selection.passwordBackendNodeId<=0||(req.selection.usernameSelector!==undefined&&(!Number.isSafeInteger(req.selection.usernameBackendNodeId)||!req.selection.usernameBackendNodeId))))refuse();
    if(!/^[A-F0-9]{32}$/.test(req.targetId) || typeof req.username!=='string' || !req.username || req.username.length>4096) refuse();
    const origin=new URL(req.origin);
    if(origin.protocol!=='https:' || origin.origin!==req.origin || origin.username || origin.password) refuse();
    // A saved login for a sibling subdomain (e.g. www vs login) may fill only within the same registrable site.
    const credentialOrigin=req.credentialOrigin??req.origin;
    if(credentialOrigin!==req.origin){const u=new URL(credentialOrigin);const site=siteOf(req.origin);if(u.protocol!=='https:'||u.origin!==credentialOrigin||site===null||siteOf(credentialOrigin)!==site) refuse();}
    stage='permission';
    const p=await dependencies.permission();
    const authorized=async()=>{const now=await dependencies.permission();if(JSON.stringify(now)!==JSON.stringify(p)||!validExpiry(p.expires)) refuse();};
    stage='target';
    c=await CDP.connect(req.endpoint);
    const targets=await c.send('Target.getTargets');
    if(!targets.targetInfos.some(t=>t.targetId===req.targetId&&t.type==='page'&&new URL(t.url).origin===req.origin)) refuse();
    sid=(await c.send('Target.attachToTarget',{targetId:req.targetId,flatten:true})).sessionId;
    const connection=c;
    /** @template {keyof import('./cdp-types.js').Results} M
     * @param {M} m
     * @param {Record<string, unknown>} [p] */
    const send=(m,p={})=>connection.send(m,p,sid);
    let generation=0;
    /** @type {string | undefined} */ let boundFrame;
    /** @type {number | undefined} */ let boundContext;
    c.event=m=>{
      if(m.sessionId!==sid) return;
      if(m.method==='Runtime.executionContextsCleared'
        || (m.method==='Runtime.executionContextDestroyed' && m.params.executionContextId===boundContext)
        || (m.method==='Page.frameNavigated' && m.params.frame.id===boundFrame)
        || (m.method==='Page.frameDetached' && m.params.frameId===boundFrame)) generation++;
    };
    await send('Page.enable');await send('Runtime.enable');
    const tree=(await send('Page.getFrameTree')).frameTree;
    // Only the main document is queried; never traverse or select a child frame.
    if(tree.frame.parentId || new URL(tree.frame.url).origin!==req.origin) refuse();
    const loader=tree.frame.loaderId, frame=tree.frame.id;
    if(req.selection&&(req.selection.frameId!==frame||req.selection.loaderId!==loader))refuse();
    boundFrame=frame;
    const context=(await send('Page.createIsolatedWorld',{frameId:frame,worldName:'pi-current-fill',grantUniveralAccess:false})).executionContextId;
    boundContext=context;
    stage='form';
    const captured=await send('Runtime.evaluate',{contextId:context,expression:`(()=>{if(window!==top||location.origin!==${JSON.stringify(req.origin)})throw 0;const fields=(${inspectForm})(${JSON.stringify(req.username)},${JSON.stringify(req.selection??null)});if(!fields)throw 0;return {doc:document,...fields};})()`,returnByValue:false});
    if(captured.exceptionDetails || !captured.result.objectId) refuse();
    const objectId=captured.result.objectId, gen=generation, deadline=Date.now()+25000;
    if(req.selection){
      for(const [field,expected] of /** @type {const} */ ([['password',req.selection.passwordBackendNodeId],['user',req.selection.usernameBackendNodeId]])){
        if(expected===undefined)continue;
        const element=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:`function(){return this.${field};}`,returnByValue:false});
        if(element.exceptionDetails||!element.result.objectId)refuse();
        const described=await send('DOM.describeNode',{objectId:element.result.objectId});
        if(described.node.backendNodeId!==expected)refuse();
      }
    }
    stage='resolve';
    const credential=await dependencies.resolve({origin:credentialOrigin,username:req.username,revision:p.revision});
    if(credential.username!==req.username||typeof credential.password!=='string'||!credential.password||credential.password.length>65536) refuse();
    stage='permission';
    await authorized();
    stage='target';
    const current=(await send('Page.getFrameTree')).frameTree;
    if(Date.now()>deadline||generation!==gen||current.frame.id!==frame||current.frame.loaderId!==loader||new URL(current.frame.url).origin!==req.origin) refuse();
    stage='fill';
    // A lost CDP response may hide a setter invocation; default conservatively to true.
    mayHaveFilled=true;
    const result=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:`function(origin,username,password){const d=this.doc,u=this.user,p=this.password;if(document!==d||window!==top||location.origin!==origin)return {ok:false,started:false};const fields=(${inspectForm})(username,${JSON.stringify(req.selection??null)});if(!fields||fields.user!==u||fields.password!==p)return {ok:false,started:false};const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;try{if(u)set.call(u,username);set.call(p,password);if(u)u.dispatchEvent(new Event('input',{bubbles:true}));p.dispatchEvent(new Event('input',{bubbles:true}));if(u)u.dispatchEvent(new Event('change',{bubbles:true}));p.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,started:true};}catch{return {ok:false,started:true};}}`,arguments:[{value:req.origin},{value:credential.username},{value:credential.password}],returnByValue:true});
    credential.password='';
    const setterResult=/** @type {import('./cdp-types.js').SetterResult | undefined} */ (result.result.value);
    if(!result.exceptionDetails && setterResult?.started===false) mayHaveFilled=false;
    if(result.exceptionDetails||setterResult?.ok!==true) refuse();
    stage='permission';
    await authorized();
    stage='verify';
    const after=(await send('Page.getFrameTree')).frameTree;
    if(generation!==gen||after.frame.loaderId!==loader||new URL(after.frame.url).origin!==req.origin) refuse();
    return {status:'FILLED_NOT_SUBMITTED',loginVerified:false};
  } catch(error) {return {status:'REFUSED_OR_CHANGED',stage,category:error instanceof ConsumerFailure?error.category:stage==='permission'?'SYSTEM_PERMISSION':'ELEMENT_CHANGED_OR_UNSUPPORTED',mayHaveFilled,loginVerified:false};}
  finally {if(c){if(sid)await c.send('Target.detachFromTarget',{sessionId:sid}).catch(()=>{});c.close();}}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {let text='';for await(const b of process.stdin){text+=b;if(text.length>16384)refuse();}console.log(JSON.stringify(await fill(JSON.parse(text))));}
  catch {console.log('{"status":"REFUSED_OR_CHANGED","stage":"target","category":"ELEMENT_CHANGED_OR_UNSUPPORTED","mayHaveFilled":false,"loginVerified":false}');process.exitCode=1;}
}
