import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const React = await jiti.import('react');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { ModelSelector } = await jiti.import('./ModelSelector.tsx');
const { I18nProvider } = await jiti.import('@/hooks/useI18n');
const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(ModelSelector, { options: [], onChange() {}, ...props })));

test('selected model button uses its maker icon in toolbar and field variants', () => {
  for (const variant of ['toolbar', 'field']) {
    for (const [provider, modelId, symbol] of [
      ['openai-codex', 'gpt-6.1-sol', 'openai'],
      ['openrouter', 'anthropic/claude-sonnet-4-6', 'anthropic'],
      ['google-vertex', 'gemini-3-pro', 'google'],
    ]) {
      const html = render({ value: { provider, modelId }, variant });
      assert.ok(html.includes('/provider-icons.svg#' + symbol));
      assert.ok(html.includes(modelId));
      assert.match(html, /data-model-selector-trigger/);
    }
  }
});

test('switching keeps the spinner rather than a stale model logo', () => {
  const html = render({ value: { provider: 'openai', modelId: 'gpt-6.1-sol' }, busy: true });
  assert.match(html, /spin 0.8s/);
  assert.doesNotMatch(html, /provider-icons\.svg/);
});

test('fast mode adds a small accessible lightning after the OpenAI model name only when enabled', () => {
  for (const provider of ['openai', 'openai-codex']) {
    const value = { provider, modelId: 'gpt-6.1-sol' };
    const enabled = render({ value, fastMode: true });
    assert.match(enabled, /data-model-fast-indicator/);
    assert.match(enabled, /aria-label="Fast mode"/);
    assert.ok(enabled.indexOf('gpt-6.1-sol</span>') < enabled.indexOf('data-model-fast-indicator'));
    assert.doesNotMatch(render({ value, fastMode: false }), /data-model-fast-indicator/);
    assert.doesNotMatch(render({ value }), /data-model-fast-indicator/);
  }
  assert.doesNotMatch(render({ value: null, fastMode: true }), /data-model-fast-indicator/);
  assert.doesNotMatch(render({ value: { provider: 'anthropic', modelId: 'claude' }, fastMode: true }), /data-model-fast-indicator/);
});

test('composer derives fast mode from the live extension status, not arbitrary status text', () => {
  const source = readFileSync(new URL('./ChatWindow.tsx', import.meta.url), 'utf8');
  const expression = source.match(/fastMode=\{(extensionStatuses\.some\([^\n]+)\}/)?.[1];
  assert.ok(expression, 'ChatWindow passes live fast status to ChatInput');
  const script = new Script(ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
  for (const [extensionStatuses, expected] of [
    [[], false],
    [[{ key: 'codex-speed', text: 'Codex fast' }], true],
    [[{ key: 'codex-speed', text: 'OpenAI fast' }], true],
    [[{ key: 'other', text: 'Codex fast' }], false],
    [[{ key: 'codex-speed', text: 'standard' }], false],
  ]) assert.equal(script.runInNewContext({ extensionStatuses }), expected);
  const input = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(input, /fastMode=\{fastMode\}/);
});

test('names a selected model outside the scope from the on-demand full list', () => {
  const html = render({
    options: [{ provider: 'anthropic', modelId: 'claude', name: 'Scoped Claude' }],
    allOptions: [{ provider: 'openai', modelId: 'gpt-6-luna', name: 'GPT-6 Luna' }],
    value: { provider: 'openai', modelId: 'gpt-6-luna' },
    onShowAll() {},
  });
  assert.match(html, /GPT-6 Luna/);
  assert.doesNotMatch(html, />gpt-6-luna</);
});

test('running GPT can open Fast without unlocking other model selectors', () => {
  const props = { modelSelectionDisabled: true, onFastModeChange() {} };
  const gpt = render({ ...props, value: { provider: 'openai-codex', modelId: 'gpt-fixture' } });
  assert.doesNotMatch(gpt, / disabled=""/);
  assert.match(gpt, /aria-haspopup="dialog"/);
  const other = render({ ...props, value: { provider: 'anthropic', modelId: 'claude' } });
  assert.match(other, / disabled=""/);
  assert.match(render({ ...props, disabled: true, value: { provider: 'openai', modelId: 'gpt-fixture' } }), / disabled=""/);
});

test('branch state preserves the Fast indicator before a new session connects SSE', () => {
  assert.match(render({ value: { provider: 'openai', modelId: 'gpt-fixture' },
    fastModeState: { available: true, supported: true, mode: 'fast' } }), /data-model-fast-indicator/);
});

test('no selected model keeps the generic icon and empty label', () => {
  const html = render({ value: null, emptyLabel: 'Select a model' });
  assert.ok(html.includes('Select a model'));
  assert.doesNotMatch(html, /provider-icons\.svg/);
});
