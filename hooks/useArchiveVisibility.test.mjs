import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import ts from 'typescript';
const script = new Script(ts.transpileModule(readFileSync(new URL('./useArchiveVisibility.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText);
const KEY = 'pi-web:sidebar-show-archived';
function fixture(initial, blocked = false, server = false) {
  const stored = new Map(initial === undefined ? [] : [[KEY, initial]]); const events = new Map(); const exports = {}; let cleanup;
  script.runInNewContext({ exports, require: () => ({ useSyncExternalStore(subscribe, get, ssr) { if (server) return ssr(); cleanup ??= subscribe(() => {}); return get(); } }), ...(!server && { window: { localStorage: { getItem(key) { if (blocked) throw Error(); return stored.get(key) ?? null; }, setItem(key, value) { if (blocked) throw Error(); stored.set(key, value); } }, addEventListener: (k, f) => events.set(k, f), removeEventListener: k => events.delete(k) } }) });
  return { ...exports, stored, events, close: () => cleanup?.() };
}
test('archive entry is hidden by default and during SSR', () => {
  const f = fixture(); assert.equal(f.useArchiveVisibility(), false);
  assert.equal(f.parseArchiveVisibility('invalid'), false);
  assert.equal(fixture('true', false, true).useArchiveVisibility(), false);
});
test('settings changes persist immediately and other tabs follow', () => {
  const f = fixture('true'); assert.equal(f.useArchiveVisibility(), true);
  f.setArchiveVisibility(false); assert.equal(f.useArchiveVisibility(), false); assert.equal(f.stored.get(KEY), 'false');
  f.stored.set(KEY, 'true'); f.events.get('storage')({ key: KEY }); assert.equal(f.useArchiveVisibility(), true);
  f.stored.clear(); f.events.get('storage')({ key: null }); assert.equal(f.useArchiveVisibility(), false);
  f.close(); assert.equal(f.events.size, 0);
});
test('blocked storage still allows in-memory settings', () => {
  const f = fixture(undefined, true); assert.equal(f.useArchiveVisibility(), false); f.setArchiveVisibility(true); assert.equal(f.useArchiveVisibility(), true);
});
