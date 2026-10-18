import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
test('only the selected old-session mount requests a suggestion, not generic background history reads',()=>{
  const loader=source.slice(source.indexOf('  const loadSession ='),source.indexOf('  const loadContext ='));
  assert.doesNotMatch(loader,/requestOpenedPromptSuggestion/);
  const mount=source.slice(source.indexOf('  // Load session on mount'),source.indexOf('    onSystemPromptChange?.(systemPrompt)'));
  assert.match(mount,/loadedLeafId/);assert.match(mount,/pageRuntime\(\) === "pi"/);
  assert.match(mount,/disposed \|\| sessionPropIdRef/);assert.match(mount,/ensureConnected: ensureEventsConnected/);
  assert.match(mount,/getDraft\(session.id\)/);assert.match(mount,/disposed = true/);
  assert.match(mount,/!agentState.state\?\.isStreaming/);assert.match(mount,/!agentState.state\?\.isPromptRunning/);
  assert.doesNotMatch(mount,/loadedLeafId && !agentState.running/);
  assert.match(mount,/activeLeafIdRef.current === agentState.loadedLeafId/);
  assert.equal((source.match(/void requestOpenedPromptSuggestion\(/g)||[]).length,1);
});
