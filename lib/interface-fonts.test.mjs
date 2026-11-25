import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../app/interface-fonts.css', import.meta.url), 'utf8');
const globals = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../app/workspace.css', import.meta.url), 'utf8');

test('authentic locally served reference font bytes are intact WOFF2 files', async () => {
  const hashes = {
    // Pinned provenance and hashes are documented in docs/interface-fonts.md.
    'claude-interface-sans-roman.woff2': '5161b683881e79149ff06ace3256e704b920839885032afba6b1a874895e1ced',
    'claude-interface-sans-italic.woff2': 'ad89863fd0eb36e001166ea2a51e5102d18ffbbe4a0b321291a94d3739a5696b',
    'claude-interface-serif-roman.woff2': 'ac9c19c70558c5152b92119f83ca37dded627b524d75552a26fcda015d4106be',
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const data = await readFile(new URL(`../public/fonts/${name}`, import.meta.url));
    assert.equal(data.subarray(0, 4).toString(), 'wOF2');
    assert.equal(createHash('sha256').update(data).digest('hex'), hash);
    assert.ok(css.includes(`/fonts/${name}`));
  }
  assert.equal((css.match(/font-weight: 300 800;/g) ?? []).length, 3);
  assert.doesNotMatch(css, /src:\s*url\(["']?https?:/);
});

test('global UI default changes without activating a new message or monospace font', () => {
  assert.match(globals, /@import "\.\/interface-fonts\.css"/);
  assert.match(globals, /--font-ui-default: 'Claude Interface Sans',/);
  assert.match(globals, /--font-answer-default: 'Anthropic Serif', Georgia, 'Songti SC', 'STSong', 'Noto Serif CJK SC', serif;/);
  assert.match(globals, /--font-answer: var\(--font-answer-default\);/);
  assert.match(globals, /--font-mono-default: var\(--font-noto-mono\), 'JetBrains Mono', 'Fira Code', 'Consolas', ui-monospace, 'PingFang SC', 'Microsoft YaHei', monospace;/);
  assert.doesNotMatch(css, /font-family:\s*["']Anthropic Serif["']/);
  assert.match(workspace, /\.new-session-greeting \{[^}]*font-family: 'Claude Interface Serif',/);
  assert.match(workspace, /\.attachment-dialog \{[^}]*font-family: var\(--font-ui\)/);
});
