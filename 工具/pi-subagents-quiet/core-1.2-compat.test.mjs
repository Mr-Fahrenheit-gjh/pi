import test from 'node:test';
import assert from 'node:assert/strict';
import { MainWatchdogRuntime } from '/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/src/watchdog/runtime.js';
const ctx = {cwd:process.cwd()};
function runtime() { return new MainWatchdogRuntime({repoChangeSignature:()=>undefined}); }
test('custom continuations preserve the user task, not system instructions', () => {
  const r=runtime();
  try {
    r.handleBeforeAgentStart({messageType:'user',prompt:'Fix the CLI',systemPrompt:'SYSTEM RULES'},ctx);
    r.handleBeforeAgentStart({messageType:'custom',message:{content:'Resume'},systemPrompt:'SYSTEM RULES'},ctx);
    assert.equal(r.userPrompt,'Fix the CLI');
    r.handleBeforeAgentStart({messageType:'user',prompt:'New task',systemPrompt:'SYSTEM RULES'},ctx);
    assert.equal(r.userPrompt,'New task');
  } finally {r.dispose();}
});
test('custom startup without a user task does not invent one', () => {
  const r=runtime();
  try {
    r.handleBeforeAgentStart({messageType:'custom',message:{content:'Resume'},systemPrompt:'SYSTEM RULES'},ctx);
    assert.equal(r.userPrompt,undefined);
  } finally {r.dispose();}
});
test('Pi 1.1 events without messageType remain compatible', () => {
  const r=runtime();
  try {
    r.handleBeforeAgentStart({prompt:'Legacy task',systemPrompt:'SYSTEM RULES'},ctx);
    assert.equal(r.userPrompt,'Legacy task');
  } finally {r.dispose();}
});
