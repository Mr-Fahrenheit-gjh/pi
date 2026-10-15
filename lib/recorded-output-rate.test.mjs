import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { recordedOutputTokensPerSecond: rate } = await createJiti(import.meta.url).import('./stream-token-rate.ts');
test('completed speed uses only finite positive recorded output and duration', () => {
  assert.equal(rate(100, 4000), 25);
  for (const value of [null, undefined, 0, -1, NaN, Infinity, '100']) { assert.equal(rate(value, 4000), null); assert.equal(rate(100, value), null); }
  assert.equal(rate(1, 100000), null, 'never render a rounded zero');
});
