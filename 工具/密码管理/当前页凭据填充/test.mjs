import {fill,CDP,validExpiry} from './fill.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import https from 'node:https';
const root=await mkdtemp(join(tmpdir(),'fill-test-'));
const env={PATH:process.env.PATH,HOME:root,AGENT_BROWSER_SOCKET_DIR:root};
const session='synthetic-fill';let posts=0;
/** @type {https.Server | undefined} */ let server;
/** @type {CDP | undefined} */ let c;
/** @param {string[]} args
 * @returns {Promise<import('./cdp-types.js').FixtureData>} */
const run=(args)=>new Promise((yes,no)=>{const p=spawn('agent-browser',['--session',session,'--json',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.on('error',no);p.on('close',code=>{try{if(code)throw 0;const j=JSON.parse(text);if(!j.success)throw 0;yes(j.data);}catch{no(new Error('FIXTURE_CLI_FAILED'));}});});
const secret='SYNTHETIC-only-z91!';
assert.equal(validExpiry(null),true);
assert.equal(validExpiry(Date.now()/1000+365*86400),true);
for(const value of [undefined, false, 'forever', NaN, Infinity, 0, Date.now()/1000-1]) assert.equal(validExpiry(value),false);
try {
  const indexScript=`import assert from 'node:assert/strict';import {importMapping,lookup,accountUsername} from ${JSON.stringify(new URL('./accounts.mjs',import.meta.url).href)};await assert.rejects(lookup('https://synthetic.invalid'));await importMapping([{origin:'https://synthetic.invalid',username:'synthetic-用户'}]);const rows=await lookup('https://synthetic.invalid');assert.equal(rows.length,1);assert.equal(await accountUsername('https://synthetic.invalid',rows[0].accountId),'synthetic-用户');assert.equal((await lookup('https://other.invalid')).length,0);await assert.rejects(importMapping([]));await assert.rejects(lookup('http://synthetic.invalid'));`;
  execFileSync(process.execPath,['--input-type=module','-e',indexScript],{env,stdio:'pipe'});
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key'),'-out',join(root,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  server=https.createServer({key:await readFile(join(root,'key')),cert:await readFile(join(root,'cert'))},(req,res)=>{
    if(req.method==='POST')posts++;
    res.setHeader('Content-Type','text/html');res.end('<form method="POST"><input autocomplete="username"><input type="password"><button>Submit</button></form>');
  });
  const fixtureServer=server;
  await new Promise(/** @param {(value?: void) => void} r */ r=>fixtureServer.listen(0,'127.0.0.1',r));
  const port=/** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const origin=`https://localhost:${port}`;
  await run(['--ignore-https-errors','open',origin]);
  const endpointData=await run(['get','cdp-url']);
  const endpoint=endpointData.cdpUrl??endpointData.url;
  assert.ok(typeof endpoint==='string');
  c=await CDP.connect(endpoint);
  const target=(await c.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.startsWith(origin));
  assert.ok(target);
  const targetId=target.targetId;
  const sid=(await c.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  const connection=c;
  /** @param {string} expression */
  const evaluate=expression=>connection.send('Runtime.evaluate',{expression,returnByValue:true},sid);
  const req={endpoint,targetId,origin,username:'synthetic-user'};
  const p={revision:'synthetic',expires:null};let revoked=false,calls=0;
  const deps={permission:async()=>{if(revoked)throw 0;return p;},resolve:async()=>{calls++;return {username:req.username,password:secret};}};
  const ok=await fill(req,deps);assert.equal(ok.status,'FILLED_NOT_SUBMITTED');
  const check=await evaluate(`document.querySelector('input[type=password]').value===${JSON.stringify(secret)}`);assert.equal(check.result.value,true);
  assert.equal((await run(['get','url'])).url,origin+'/');assert.equal(posts,0);
  const failures=[];
  /** @param {string} html */
  const setForm=async html=>{const r=await evaluate(`document.body.innerHTML=${JSON.stringify(html)}`);assert.equal(r.exceptionDetails,undefined);};
  await setForm('<form><input id="el-id-734" placeholder="用户名/邮箱/手机号"><input type=password><input name=captcha value=keep></form>');
  const snapshot=await run(['snapshot','-i']);
  assert.ok(JSON.stringify(snapshot).includes('用户名/邮箱/手机号'));
  // Agent observes a unique placeholder in its snapshot; no @ref is passed to CDP.
  const observed=(await connection.send('Page.getFrameTree',{},sid)).frameTree.frame;
  /** @param {string} selector */
  const backend=async selector=>{const e=await connection.send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})`,returnByValue:false},sid);assert.ok(e.result.objectId);return (await connection.send('DOM.describeNode',{objectId:e.result.objectId},sid)).node.backendNodeId;};
  const selected={...req,selection:{frameId:observed.id,loaderId:observed.loaderId,usernameBackendNodeId:await backend('[placeholder]'),passwordBackendNodeId:await backend('input[type=password]'),usernameSelector:'input[placeholder="用户名/邮箱/手机号"]',passwordSelector:'input[type=password]'}};
  assert.equal((await fill(selected,deps)).status,'FILLED_NOT_SUBMITTED');
  assert.equal((await run(['get','url'])).url,origin+'/');
  assert.equal((await evaluate("document.querySelector('[name=captcha]').value==='keep'")).result.value,true);
  for(const selection of [{...selected.selection,passwordSelector:'input'}, {...selected.selection,usernameSelector:'input[type=password]'}, {...selected.selection,loaderId:'stale'}]){
    const before=calls;assert.equal((await fill({...req,selection},deps)).status,'REFUSED_OR_CHANGED');assert.equal(calls,before);
  }
  const replaced=await fill(selected,{...deps,resolve:async()=>{await evaluate("document.querySelector('[placeholder]').outerHTML=document.querySelector('[placeholder]').outerHTML");return {username:req.username,password:secret};}});
  assert.equal(replaced.status,'REFUSED_OR_CHANGED');assert.equal(replaced.mayHaveFilled,false);
  const beforeReplacement=calls;assert.equal((await fill(selected,deps)).status,'REFUSED_OR_CHANGED');assert.equal(calls,beforeReplacement);
  for(const html of [
    '<form><input placeholder="用户名/邮箱/手机号" readonly><input type=password></form>',
    '<form><input placeholder="用户名/邮箱/手机号" disabled><input type=password></form>',
    '<form><input placeholder="用户名/邮箱/手机号"><input placeholder="用户名/邮箱/手机号"><input type=password></form>',
    '<form><input placeholder="用户名/邮箱/手机号"></form><form><input type=password></form>',
    '<form><input placeholder="用户名/邮箱/手机号"><input type=password autocomplete=new-password></form>',
  ]){await setForm(html);const before=calls;assert.equal((await fill(selected,deps)).status,'REFUSED_OR_CHANGED');assert.equal(calls,before);}
  await run(['open',origin]);
  const beforeStale=calls;assert.equal((await fill(selected,deps)).status,'REFUSED_OR_CHANGED');assert.equal(calls,beforeStale);
  await setForm('<div>synthetic-user</div><form><input type=hidden name=j_username value=ignored><input type=hidden name=_csrf value=ignored><input type=password name=j_password></form>');
  assert.equal((await fill(req,deps)).status,'FILLED_NOT_SUBMITTED', 'visible-account password-only');
  assert.equal((await evaluate(`document.querySelector('input[type=password]').value===${JSON.stringify(secret)}`)).result.value,true);
  await setForm('<input readonly name=email value=synthetic-user><form><input type=password autocomplete=current-password></form>');
  assert.equal((await fill(req,deps)).status,'FILLED_NOT_SUBMITTED');
  for(const html of [
    '<form><input type=password></form>',
    '<div>other-synthetic-user</div><input type=password>',
    '<div style="visibility:hidden">synthetic-user</div><input type=password>',
    '<div style="display:none">synthetic-user</div><input type=password>',
    '<input type=hidden name=username value=synthetic-user><input type=password>',
    '<div>synthetic-user</div><input readonly name=email value=other-account><input type=password>',
    '<input readonly name=email value=synthetic-user><input readonly name=user value=other-account><input type=password>',
    '<div>synthetic-user</div><input type=password autocomplete=new-password>',
    '<div>synthetic-user</div><input type=password name=confirm_password>',
    '<div>synthetic-user</div><input type=password><input type=password>',
    '<div>synthetic-user</div><input name=user><input name=email><input type=password>',
    '<div>synthetic-user</div><div>synthetic-user</div><input type=password>',
  ]) {
    await setForm(html);const before=calls,result=await fill(req,deps);
    assert.equal(result.status,'REFUSED_OR_CHANGED');assert.equal(result.stage,'form');assert.equal(result.mayHaveFilled,false);assert.equal(calls,before);failures.push(result);
  }
  for(const change of ["document.querySelector('div').textContent='other-account'", "document.querySelector('div').style.display='none'"]) {
    await setForm('<div>synthetic-user</div><input type=password>');
    const result=await fill(req,{...deps,resolve:async()=>{await evaluate(change);return {username:req.username,password:secret};}});
    assert.equal(result.status,'REFUSED_OR_CHANGED');assert.equal(result.stage,'fill');assert.equal(result.mayHaveFilled,false);failures.push(result);
    assert.equal((await evaluate("document.querySelector('input').value===''")).result.value,true);
  }
  await setForm('<form><input type="text" name="user" id="input-login-user" placeholder="jAccount用户名" autocomplete="off"><input type="password" name="pass" autocomplete="off"><input type="text" name="captcha" id="input-login-captcha" placeholder="请输入验证码" autocomplete="off" value="keep-captcha"></form>');
  assert.equal((await fill(req,deps)).status,'FILLED_NOT_SUBMITTED');
  assert.equal((await evaluate(`document.querySelector('[name=user]').value===${JSON.stringify(req.username)}&&document.querySelector('[name=pass]').value===${JSON.stringify(secret)}&&document.querySelector('[name=captcha]').value==='keep-captcha'`)).result.value,true);
  for(const fields of [
    '<input name=user><input name=email>',
    '<input><input name=captcha>',
    '<input name=captcha autocomplete=username>',
    '<input name=login-code><input name=account_otp>',
    '<input name=superuser><input name=accounting>',
    '<input name=user autocomplete=one-time-code>',
  ]) {
    await setForm(`<form>${fields}<input type=password></form>`);
    const before=calls, refused=await fill(req,deps);
    assert.equal(calls,before);assert.equal(refused.status,'REFUSED_OR_CHANGED');assert.equal(refused.stage,'form');assert.equal(refused.mayHaveFilled,false);failures.push(refused);
    assert.equal((await evaluate("[...document.querySelectorAll('input')].every(e=>e.value==='')")).result.value,true);
  }
  await setForm('<form><input name=email><input name=identity autocomplete=username><input name=captcha autocomplete=username value=keep><input type=password></form>');
  assert.equal((await fill(req,deps)).status,'FILLED_NOT_SUBMITTED');
  assert.equal((await evaluate(`document.querySelector('[name=identity]').value===${JSON.stringify(req.username)}&&document.querySelector('[name=email]').value===''&&document.querySelector('[name=captcha]').value==='keep'`)).result.value,true);
  await run(['open',origin]);
  failures.push(await fill({...req,origin:'https://wrong.invalid'},deps));
  failures.push(await fill({...req,endpoint:'ws://example.com:99/devtools/browser/'+ 'a'.repeat(36)},deps));
  await evaluate("document.body.insertAdjacentHTML('beforeend','<iframe loading=lazy></iframe>')");
  const lazy=await fill(req,deps);assert.equal(lazy.status,'FILLED_NOT_SUBMITTED');
  // Same-origin child used only by fixture assertions; production never queries it.
  await evaluate("document.querySelector('iframe').contentDocument.body.innerHTML='<form><input autocomplete=username><input type=password></form>';document.querySelector('form').remove()");
  const before=calls;failures.push(await fill(req,deps));assert.equal(calls,before);
  await evaluate("document.body.insertAdjacentHTML('afterbegin','<form><input autocomplete=username><input type=password></form>')");
  const focus=await fill(req,{...deps,resolve:async()=>{
    const focused=await evaluate("document.querySelector('iframe').contentDocument.querySelector('input[type=password]').focus();document.activeElement===document.querySelector('iframe')");
    assert.equal(focused.result.value,true);return {username:req.username,password:secret};
  }});assert.equal(focus.status,'FILLED_NOT_SUBMITTED');
  const confined=await evaluate(`document.querySelector('input[type=password]').value===${JSON.stringify(secret)} && [...document.querySelector('iframe').contentDocument.querySelectorAll('input')].every(e=>e.value==='')`);
  assert.equal(confined.result.value,true);
  await evaluate("document.querySelector('iframe').remove();document.querySelector('form').insertAdjacentHTML('beforeend','<input autocomplete=username>')");failures.push(await fill(req,deps));
  await run(['open',origin]);
  failures.push(await fill(req,{...deps,resolve:async()=>{revoked=true;return {username:req.username,password:secret};}}));revoked=false;
  failures.push(await fill(req,{...deps,resolve:async()=>{await run(['open',origin+'/changed']);return {username:req.username,password:secret};}}));
  failures.push(await fill(req,{...deps,resolve:async()=>{await evaluate("document.querySelector('input[type=password]').outerHTML='<input type=password>'");return {username:req.username,password:secret};}}));
  failures.push(await fill(req,{...deps,resolve:async()=>{await evaluate("document.querySelector('form').insertAdjacentHTML('beforeend','<input autocomplete=username>')");return {username:req.username,password:secret};}}));
  await run(['open',origin]);
  failures.push(await fill(req,{...deps,resolve:async()=>{throw new Error(secret);}}));
  failures.push(await fill(req,{...deps,resolve:async()=>({username:'wrong-account',password:secret})}));
  failures.push(await fill(req,{...deps,resolve:async()=>{await run(['open',`https://127.0.0.1:${port}/cross-origin`]);return {username:req.username,password:secret};}}));
  const empty=await evaluate("[...document.querySelectorAll('input')].every(e=>e.value==='')");assert.equal(empty.result.value,true);
  for(const f of failures){assert.equal(f.status,'REFUSED_OR_CHANGED');assert.ok(['permission','target','form','resolve','fill','verify'].includes(f.stage));assert.equal(f.mayHaveFilled,false);assert.deepEqual(Object.keys(f).sort(),['category','loginVerified','mayHaveFilled','stage','status']);}
  await run(['open',origin]);
  let permissionReads=0;
  const postFillRevocation=await fill(req,{...deps,permission:async()=>{if(++permissionReads===3)throw new Error(secret);return p;}});
  assert.equal(postFillRevocation.status,'REFUSED_OR_CHANGED');
  assert.equal(postFillRevocation.stage,'permission');assert.equal(postFillRevocation.mayHaveFilled,true);
  assert.equal((await evaluate(`document.querySelector('input[type=password]').value===${JSON.stringify(secret)}`)).result.value,true);
  permissionReads=0;
  const postFillNavigation=await fill(req,{...deps,permission:async()=>{if(++permissionReads===3)await run(['open',origin+'/after-fill']);return p;}});
  assert.equal(postFillNavigation.status,'REFUSED_OR_CHANGED');assert.equal(postFillNavigation.stage,'verify');assert.equal(postFillNavigation.mayHaveFilled,true);
  assert.ok(!JSON.stringify([postFillRevocation,postFillNavigation]).includes(secret));
  const originalConnect=CDP.connect;
  try {
    CDP.connect=async endpoint=>{const connection=await originalConnect(endpoint),send=connection.send.bind(connection);connection.send=async(method,...args)=>{if(method==='Runtime.callFunctionOn'){await send(method,...args);throw new Error(secret);}return send(method,...args);};return connection;};
    const lostResponse=await fill(req,deps);assert.equal(lostResponse.status,'REFUSED_OR_CHANGED');assert.equal(lostResponse.stage,'fill');assert.equal(lostResponse.mayHaveFilled,true);assert.ok(!JSON.stringify(lostResponse).includes(secret));
  } finally {CDP.connect=originalConnect;}
  assert.ok(!JSON.stringify([ok,lazy,focus,...failures]).includes(secret));assert.equal(posts,0);
  console.log('PASS real agent-browser same-session fill/no-submit; wrong-origin, remote-endpoint, lazy-iframe-main-form, iframe-only-refused-before-resolve, iframe-focus-confined, semantic-user/pass/captcha, ambiguous/untrusted-fields-before-resolve, autocomplete-priority, post-fill-revoke, lost-setter-response, revoke, navigation, cross-origin-navigation, replaced-element, resolver-error, wrong-account; sanitized results');
}finally {c?.close();await run(['close']).catch(()=>{});if(server){const fixtureServer=server;await new Promise(r=>fixtureServer.close(r));}await rm(root,{recursive:true,force:true});}
