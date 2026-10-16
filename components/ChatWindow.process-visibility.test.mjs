import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const text = readFileSync(new URL('./ChatWindow.tsx', import.meta.url), 'utf8');
const source = text.slice(text.indexOf('function ProcessDetailsGroup('), text.indexOf('export function ChatWindow('));
const scope = { React, Image: () => null, useState: value => [value, () => {}], useLayoutEffect: () => {} };
vm.runInNewContext(ts.transpileModule(source + '\nglobalThis.Group = ProcessDetailsGroup;', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText, scope);
function render(props = {}) { return renderToStaticMarkup(React.createElement(scope.Group, { messageCount: 2, toolCallCount: 1, t: key => key, ...props }, 'PRIVATE_PROCESS')); }
test('completed history has no permanent view-process row, even if previously expanded', () => {
  assert.equal(render(), ''); assert.equal(render({ defaultExpanded: true }), '');
});
test('running process stays collapsed by default and can be rendered expanded', () => {
  assert.match(render({ running: true }), /chat.working/); assert.match(render({ running: true }), /aria-expanded="false"/);
  assert.doesNotMatch(render({ running: true }), /PRIVATE_PROCESS/);
  assert.match(render({ running: true, defaultExpanded: true }), /PRIVATE_PROCESS/);
});
test('explicit historical search reveal still has an accessible disclosure', () => {
  assert.match(render({ reveal: true, defaultExpanded: true }), /PRIVATE_PROCESS/);
});
