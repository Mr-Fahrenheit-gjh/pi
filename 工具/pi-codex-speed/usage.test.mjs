import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsage, readUsage } from './usage.ts';

const cost = { input: 10, output: 20, cacheRead: 2, cacheWrite: 15 };
const model = { id: 'gpt-6-astra', baseUrl: 'https://api.openai.com/v1', cost, compat: { supportsExplicitPromptCacheMode: true } };
const usage = { input: 100, output: 30, cacheRead: 20, cacheWrite: 10, totalTokens: 160 };
const estimate = (tier = 'default', ttl = null, m = model, u = usage) => estimateUsage(m, u, tier, ttl);

test('catalog rates are authoritative with default, priority/fast, flex and ultrafast multipliers', () => {
  const standard = 1790 / 1e6;
  for (const [tier, multiplier] of [['default', 1], ['priority', 2], ['fast', 2], ['flex', 0.5], ['ultrafast', 6]]) {
    assert.deepEqual(estimate(tier), { estimatedCostUsd: standard * multiplier, costStatus: 'estimated' });
  }
  assert.equal(estimate('fast', null, { ...model, id: 'gpt-5.5' }).estimatedCostUsd, standard * 2.5);
  assert.equal(estimate('priority', null, { ...model, id: 'gpt-5.5' }).estimatedCostUsd, standard * 2.5);
  assert.equal(estimate('flex', null, { ...model, id: 'gpt-5.5' }).costStatus, 'unknown');
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) {
    assert.equal(estimate('priority', null, { ...model, id }).costStatus, 'estimated');
    assert.equal(estimate('flex', null, { ...model, id }).costStatus, 'estimated');
  }
  assert.equal(estimate('ultrafast', null, { ...model, id: 'gpt-6.1-sol' }).costStatus, 'estimated');
});

test('unknown/missing tiers or unverified model-tier combinations are unknown, never zero', () => {
  for (const tier of [null, 'auto', 'scale', 'mystery']) {
    assert.equal(estimate(tier).costStatus, 'unknown');
    assert.equal(estimate(tier).estimatedCostUsd, null);
  }
  for (const id of ['custom', 'gpt-6-astra-snapshot', 'gpt-6.1-sol-mini', 'gpt-6.1-terra', 'gpt-6-luna']) {
    assert.equal(estimate('ultrafast', null, { ...model, id }).estimatedCostUsd, null);
  }
  assert.equal(estimate('priority', null, { ...model, id: 'custom' }).estimatedCostUsd, null);
  assert.equal(estimate('default', null, { ...model, id: 'custom' }).costStatus, 'estimated');
});

test('highest strictly exceeded tier prices the whole request, including cached threshold input', () => {
  const m = { ...model, cost: { ...cost, tiers: [
    { inputTokensAbove: 120, input: 30, output: 60, cacheRead: 6, cacheWrite: 45 },
    { inputTokensAbove: 100, input: 20, output: 40, cacheRead: 4, cacheWrite: 30 },
    { inputTokensAbove: 130, input: 40, output: 80, cacheRead: 8, cacheWrite: 60 },
  ] } };
  assert.equal(estimate('default', null, m).estimatedCostUsd, 5370 / 1e6); // total input=130, not >130
  assert.equal(estimate('default', null, m, { ...usage, input: 101 }).estimatedCostUsd, 7200 / 1e6);
  assert.equal(estimate('default', null, m, { ...usage, input: 70 }).estimatedCostUsd, 1490 / 1e6); // ==100
  assert.equal(estimate('ultrafast', '12h', m).estimatedCostUsd, (5370 + 450) * 6 / 1e6);
});

test('12h doubles the catalog cache-write rate without adding ordinary input again', () => {
  assert.equal(estimate('default', '30m').estimatedCostUsd, 1790 / 1e6);
  assert.equal(estimate('default', '12h').estimatedCostUsd, 1940 / 1e6);
  const onlyWrite = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100, totalTokens: 100 };
  assert.equal(estimate('default', '12h', model, onlyWrite).estimatedCostUsd, 3000 / 1e6);
  for (const m of [{ ...model, compat: {} }, { ...model, id: 'gpt-5.5' }, { ...model, id: 'future-model' }]) {
    assert.equal(estimate('default', '12h', m).costStatus, 'unknown');
    assert.equal(estimate('default', '12h', m, { ...usage, cacheWrite: 0 }).costStatus, 'estimated');
  }
  assert.equal(estimate('default', '24h').costStatus, 'unknown');
});

test('incomplete/invalid catalog prices or tiers cannot silently become free', () => {
  for (const bad of [undefined, {}, { ...cost, input: undefined }, { ...cost, output: -1 },
    { ...cost, cacheRead: NaN }, { ...cost, cacheWrite: Infinity },
    { ...cost, tiers: {} }, { ...cost, tiers: [{ inputTokensAbove: '100' }] },
    { ...cost, tiers: [{ inputTokensAbove: 10, input: 20 }] }]) {
    assert.equal(estimate('default', null, { ...model, cost: bad }).estimatedCostUsd, null);
  }
  assert.equal(estimate('default', null, { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }).estimatedCostUsd, null);
  for (const baseUrl of [undefined,'https://proxy.invalid/v1','https://api.openai.com.evil/v1']) {
    for (const tier of ['default','priority','flex','ultrafast']) assert.equal(estimate(tier,null,{...model,baseUrl}).costStatus,'unknown');
  }
});

test('usage selection excludes extra fields and rejects missing/invalid/all-zero counts', () => {
  assert.deepEqual(readUsage({ ...usage, cost: { total: 999 }, content: 'private' }), usage);
  for (const value of [null, {}, { ...usage, input: NaN }, { ...usage, output: Infinity },
    { ...usage, cacheRead: -1 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }]) {
    assert.equal(readUsage(value), undefined);
  }
});
