export async function runHistoryBrowserChecks(page, options) {
  const checks=[], errors=[];let prompts=0;
  const assert=(condition,message)=>{if(!condition)throw new Error(message);checks.push(message);};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/agent\/suggestions-[ab]$/.test(request.url())){const body=request.postDataJSON();if(body?.type==='prompt')prompts++;}});
  await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('pi-locale','zh-CN');});
  await page.route('**/api/agent/*/subagents**',route=>route.fulfill({json:{available:false}}));
  await page.setViewportSize({width:1280,height:900});
  await page.goto(`${options.baseURL}/?session=suggestions-a`,{waitUntil:'domcontentloaded'});
  const input=page.locator('.chat-content textarea.chat-input-textarea').first();
  const ghost=page.locator('textarea[data-prompt-suggestion]');
  const waitGhost=async text=>{await page.waitForFunction(text=>document.querySelector('textarea[data-prompt-suggestion]')?.getAttribute('placeholder')?.includes(text),text);};
  await waitGhost('说明A这轮结果的用法');
  assert(await input.inputValue()==='', 'Opening an old session generates a suggestion without entering a message');
  assert(prompts===0,'Opening never sends a main-agent prompt');
  await page.screenshot({path:`${options.outputDir}/history-open.png`,fullPage:true});
  await input.focus();await input.press('Tab');
  assert(await input.inputValue()==='说明A这轮结果的用法','History suggestion is accepted as an unsent draft');
  const select=async letter=>{await page.locator(`a.session-tree-main[href="?session=suggestions-${letter}"]`).click();};
  await select('b');await waitGhost('说明B这轮结果的用法');
  assert(!(await input.getAttribute('placeholder')).includes('说明A'),'Another session never displays the previous session suggestion');
  await select('a');await page.getByText('open-A answer-5',{exact:true}).waitFor();
  assert(await input.inputValue()==='说明A这轮结果的用法'&&await ghost.count()===0,'Reopening preserves a non-empty draft and hides suggestions');
  await input.fill('');await select('b');await waitGhost('说明B这轮结果的用法');
  await select('a');await waitGhost('说明A这轮结果的用法');
  assert(await input.inputValue()===''&&prompts===0,'Reopening an empty old session restores a cached suggestion without sending');
  assert(errors.length===0,'No browser runtime errors');
  return {passed:true,checks,pageErrors:errors,mainPrompts:prompts};
}
