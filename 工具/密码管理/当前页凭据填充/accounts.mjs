import {createHash} from 'node:crypto';
import {open,lstat,mkdir,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=`${homedir()}/.pi-current-page-fill`;
const path=`${root}/accounts.json`;
/** @returns {never} */
const fail=()=>{throw Error('DIRECTORY_UNAVAILABLE');};
/** @param {string} origin */
const exact=origin=>{const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:'||u.port||!/^[a-z0-9.-]+$/.test(u.hostname))fail();return origin;};
// Match importer's ensure_ascii=True JSON encoding, including non-ASCII usernames.
/** @param {string} origin @param {string} username */
const identity=(origin,username)=>createHash('sha256').update(JSON.stringify([origin,username]).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).digest('hex');
const uid=()=>{if(!process.getuid)fail();return /** @type {() => number} */ (process.getuid)();};
async function checkRoot(){const s=await lstat(root);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid()||(s.mode&0o777)!==0o700)fail();}
/** @param {{origin:string,username:string}[]} items */
function rows(items){if(!Array.isArray(items)||items.length>10000)fail();const seen=new Set();return items.map(x=>{if(!x||Object.keys(x).some(k=>!['origin','username','accountId'].includes(k))||typeof x.username!=='string'||!x.username||x.username.length>4096)fail();const origin=exact(x.origin),accountId=identity(origin,x.username);if(seen.has(accountId))fail();seen.add(accountId);return {accountId,origin,username:x.username};});}
/** @param {{origin:string,username:string}[]} items */
export async function importMapping(items){const accounts=rows(items);await mkdir(root,{mode:0o700,recursive:true});await checkRoot();const temp=`${root}/.accounts-${process.pid}-${Date.now()}`;const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify({schema:1,accounts}));await f.sync();await f.close();await link(temp,path);}finally{await f.close();await unlink(temp);}return {status:'DIRECTORY_CREATED',count:accounts.length};}
/** @param {string} origin */
export async function lookup(origin){exact(origin);await checkRoot();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.uid!==uid()||(s.mode&0o777)!==0o600||s.size>8000000)fail();const j=JSON.parse(await f.readFile('utf8'));if(j.schema!==1)fail();const accounts=rows(j.accounts);if(accounts.some((a,i)=>a.accountId!==j.accounts[i].accountId))fail();return accounts.filter(a=>a.origin===origin);}finally{await f.close();}}
/** @param {string} origin @param {string} accountId */
export async function accountUsername(origin,accountId){const matches=(await lookup(origin)).filter(a=>a.accountId===accountId);if(matches.length!==1)fail();return matches[0].username;}
if(process.argv[1]===fileURLToPath(import.meta.url)){try{if(process.argv[2]==='import'){let text='';for await(const b of process.stdin){text+=b;if(text.length>8000000)fail();}console.log(JSON.stringify(await importMapping(JSON.parse(text))));}else if(process.argv[2]==='lookup'){console.log(JSON.stringify({status:'KNOWN_ACCOUNTS',accounts:(await lookup(process.argv[3])).map(a=>({accountId:a.accountId,usernameHint:'***'}))}));}else fail();}catch{console.log('{"status":"DIRECTORY_UNAVAILABLE"}');process.exitCode=1;}}

// Second-level public suffixes seen in this inventory/region, plus multi-tenant hosting
// suffixes where sibling subdomains belong to different people and must never share logins.
const MULTI_PART=new Set(['edu.cn','com.cn','net.cn','org.cn','gov.cn','ac.cn','co.uk','ac.uk','org.uk','com.hk','edu.hk','co.jp','ac.jp','com.au','edu.au','com.tw','edu.tw','co.kr','com.sg','edu.sg']);
const SHARED_HOSTS=new Set(['github.io','gitlab.io','gitee.io','vercel.app','netlify.app','pages.dev','workers.dev','herokuapp.com','web.app','firebaseapp.com','blogspot.com','azurewebsites.net','cloudfront.net','appspot.com','glitch.me','repl.co','onrender.com','fly.dev','notion.site','wordpress.com','substack.com']);
/** Registrable site of an https origin, or null when sibling subdomains must not share credentials.
 * @param {string} origin */
export function siteOf(origin){
  const labels=new URL(origin).hostname.split('.');
  if(labels.length<2)return null;
  const two=labels.slice(-2).join('.');
  if(SHARED_HOSTS.has(two))return null;
  const n=MULTI_PART.has(two)?3:2;
  return labels.length>=n?labels.slice(-n).join('.'):null;
}
/** Accounts usable on a page: exact origin first, then same registrable site (like Chrome's matching).
 * @param {string} pageOrigin */
export async function candidates(pageOrigin){
  exact(pageOrigin);await checkRoot();
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let all;try{const s=await f.stat();if(!s.isFile()||s.uid!==uid()||(s.mode&0o777)!==0o600||s.size>8000000)fail();const j=JSON.parse(await f.readFile('utf8'));if(j.schema!==1)fail();all=rows(j.accounts);}finally{await f.close();}
  const site=siteOf(pageOrigin);
  return all.filter(a=>a.origin===pageOrigin||(site!==null&&siteOf(a.origin)===site))
    .map(a=>({origin:a.origin,username:a.username,match:a.origin===pageOrigin?'exact':'same-site'}))
    .sort((a,b)=>(a.match==='exact'?0:1)-(b.match==='exact'?0:1));
}
