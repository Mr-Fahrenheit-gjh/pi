import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const source = await readFile(new URL('./ChatWindow.tsx', import.meta.url), 'utf8');
test('working indicator keeps the brand still and animates only readable label colors', () => {
  assert.match(css, /\.pi-working-mark\s*\{\s*flex: none;\s*\}/);
  assert.doesNotMatch(css, /pi-working-breathe/);
  assert.match(css, /\[data-process-details\]\[data-running\] \.process-toggle-label\s*\{[^}]*var\(--text-muted\)[^}]*var\(--text\)[^}]*animation: pi-working-shimmer 2s linear infinite/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\), \(forced-colors: active\)[\s\S]*?animation: none;\s*background: none;\s*color: inherit;/);
});
test('working disclosure retains size, explicit expansion and terminal hiding', () => {
  assert.match(source, /width=\{26\} height=\{26\} className="pi-working-mark"/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /if \(!running && !reveal\) return null/);
  assert.match(css, /\[data-process-details\]\[data-running\] \.process-toggle\s*\{[^}]*font-size: 14px;/s);
});
