import assert from 'node:assert/strict';
import test from 'node:test';
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

test('no selected model keeps the generic icon and empty label', () => {
  const html = render({ value: null, emptyLabel: 'Select a model' });
  assert.ok(html.includes('Select a model'));
  assert.doesNotMatch(html, /provider-icons\.svg/);
});
