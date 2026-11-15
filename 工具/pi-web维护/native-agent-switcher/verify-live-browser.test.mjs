import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyRealHistory} from './verify-live-browser.mjs';

test('read-only history acceptance suppresses only automatic suggestion generation before navigation', async () => {
  let handler;
  const stop = new Error('stop before real navigation');
  const page = {
    setViewportSize: async () => {}, addInitScript: async () => {}, setDefaultTimeout() {},
    route: async (pattern, callback) => { assert.equal(pattern, 'http://test/api/agent/*'); handler = callback; },
    goto: async () => { assert.equal(typeof handler, 'function'); throw stop; },
  };
  await assert.rejects(verifyRealHistory(page, {base:'http://test',sessionId:'fixture'}), error => error === stop);
  for (const [method, type, expected] of [
    ['POST','request_prompt_suggestion','fulfilled'], ['POST','get_commands','continued'],
    ['POST','navigate_tree','continued'], ['GET',null,'continued'],
  ]) {
    let actual;
    await handler({
      request: () => ({method: () => method,postDataJSON: () => ({type})}),
      fulfill: async body => { assert.deepEqual(body, {json:{success:true,data:{available:false}}}); actual='fulfilled'; },
      continue: async () => { actual='continued'; },
    });
    assert.equal(actual, expected);
  }
});
