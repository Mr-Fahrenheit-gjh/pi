// Focused desktop-only typography check. No user session, settings or model requests.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const source=dirname(dirname(fileURLToPath(import.meta.url)));
const root=resolve(process.env.PI_WEB_CHAT_PACKAGE_ROOT || source);
const out=resolve(process.env.PI_WEB_TEST_OUTPUT_DIR || join(source,'test-results/reply-emphasis'));
mkdirSync(out,{recursive:true});
const cssDir=join(root,'.next/static/css');
const css=readdirSync(cssDir).filter(n=>n.endsWith('.css')).map(n=>readFileSync(join(cssDir,n),'utf8')).join('\n');
const content=`<p><strong>已经足够开始估值。</strong> 现有资料可以支持现金流预测和可比公司分析。</p><ol><li><strong>修复折现率输入。</strong> 核对复权价格，再计算 Beta。</li><li><strong>明确可比倍数口径。</strong> 区分实际业绩和分析师预测。</li></ol><p>普通正文保持原有字体与字号。<b>重点只加粗短句。</b></p><p>Let’s plan the roadmap.</p><ol><li><strong>What are you building?</strong> A new app, feature or website.</li><li><strong>What’s your timeline?</strong> A couple of months or a year.</li></ol><p><strong>DCF</strong> is a valuation method, not a broker’s target price.</p>`;
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1440,height:950},deviceScaleFactor:1});
try {
 await page.setContent(`<html data-theme="claude-white"><head><meta charset="utf-8"><style>${css}</style><style>body{margin:0;padding:42px;background:var(--bg)}main{display:grid;grid-template-columns:1fr 1fr;gap:50px}.sample{padding:20px 24px;border:1px solid var(--border);border-radius:8px}.label{font:13px var(--font-ui);color:var(--text-muted);margin-bottom:24px}.chat-content{--chat-content-font-size:20px}.before .markdown-body :is(strong,b){font-weight:700;color:color-mix(in srgb,var(--text) 88%,var(--accent))}</style></head><body><main><section class="sample before"><div class="label">调整前 · 字重 700，偏灰褐</div><article class="chat-content markdown-assistant-message"><div class="markdown-body">${content}</div></article></section><section class="sample after"><div class="label">调整后 · 字重 800，深墨色</div><article class="chat-content markdown-assistant-message"><div class="markdown-body">${content}</div></article></section></main></body></html>`);
 await page.evaluate(()=>document.fonts.ready);
 const results=[];
 for(const theme of ['light','dark','claude','claude-white','mist','rose','pine']) {
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',['dark','pine'].includes(t));},theme);
  const style=await page.evaluate(()=>{
   const body=document.querySelector('.after .markdown-body');const bold=body.querySelector('strong');const old=document.querySelector('.before strong');
   const pick=el=>{const s=getComputedStyle(el);return {font:s.fontFamily,size:s.fontSize,lineHeight:s.lineHeight,color:s.color,weight:s.fontWeight};};
   return {body:pick(body),bold:pick(bold),old:pick(old),b:pick(body.querySelector('b')),overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(style.bold.weight,'800');assert.equal(style.b.weight,'800');assert.equal(style.old.weight,'700');
  assert.equal(style.bold.font,style.body.font);assert.equal(style.bold.size,style.body.size);assert.equal(style.bold.lineHeight,style.body.lineHeight);assert.equal(style.overflow,false);
  if(['claude','claude-white'].includes(theme))assert.equal(style.bold.color,'rgb(21, 21, 19)');
  if(theme==='dark')assert.equal(style.bold.color,'rgb(232, 232, 232)');
  results.push({theme,...style});
  if(['claude','claude-white','dark'].includes(theme))await page.screenshot({path:join(out,`${theme}-before-after.png`)});
 }
 const result={passed:true,desktopOnly:true,packageRoot:root,buildId:readFileSync(join(root,'.next/BUILD_ID'),'utf8').trim(),results};
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,buildId:result.buildId,checks:results.length,output:out}));
}finally{await browser.close();}
