import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileReferences, compactTypedFileReferences } from './file-references.mjs';

const options = { isFile: () => true };
test('drive, UNC and quoted Windows paths preserve separators and raw text', () => {
  const cases = [
    [String.raw`C:\Users\Alice\report.pdf`, String.raw`C:\Users\Alice\report.pdf`],
    [String.raw`"D:\Work Files\report.pdf"`, String.raw`D:\Work Files\report.pdf`],
    [String.raw`'D:\Work Files\report.pdf'`, String.raw`D:\Work Files\report.pdf`],
    [String.raw`\\server\share\report.pdf`, String.raw`\\server\share\report.pdf`],
    [String.raw`@"\\server\share files\report.pdf"`, String.raw`\\server\share files\report.pdf`],
    ['C:/Users/Alice/report.pdf', String.raw`C:\Users\Alice\report.pdf`],
  ];
  for (const [raw, expected] of cases) {
    const [ref] = parseFileReferences(raw, options);
    assert.equal(ref.path, expected, raw);
    assert.equal(ref.raw, raw);
    assert.equal(ref.kind, 'pdf');
    assert.equal(parseFileReferences('see ' + raw + ' please', { ...options, allowText: true })[0].path, expected);
  }
  const raw = String.raw`"C:\Work Files\report.pdf"`;
  assert.equal(compactTypedFileReferences(raw, (kind, original) => { assert.equal(original, raw); return `[${kind}.1]`; }, '', options), '[pdf.1]');
});

test('Windows drive and UNC file URIs decode spaces without accepting encoded separators', () => {
  assert.equal(parseFileReferences('file:///C:/Work%20Files/report.pdf', options)[0].path, String.raw`C:\Work Files\report.pdf`);
  assert.equal(parseFileReferences('file://server/share/Work%20Files/report.pdf', options)[0].path, String.raw`\\server\share\Work Files\report.pdf`);
  for (const raw of ['file:///C:/bad%2Fname.pdf', 'file://server/share/bad%5Cname.pdf', 'file:///C:/bad%ZZ.pdf']) assert.equal(parseFileReferences(raw, options), null);
});

test('POSIX escaping, quotes, relative/home paths and file URIs keep existing semantics', () => {
  if (process.platform !== 'win32') {
    for (const raw of [String.raw`/tmp/work\ files/report.pdf`, '"/tmp/work files/report.pdf"', 'file:///tmp/work%20files/report.pdf']) {
      assert.equal(parseFileReferences(raw, options)[0].path, '/tmp/work files/report.pdf');
    }
    assert.equal(parseFileReferences('./report.pdf', { ...options, cwd: '/tmp' })[0].path, '/tmp/report.pdf');
    assert.equal(parseFileReferences('~/report.pdf', { ...options, home: '/tmp' })[0].path, '/tmp/report.pdf');
  }
  for (const raw of ['C:relative.pdf', String.raw`"C:\unclosed.pdf`, 'ordinary text', '/tmp/trailing\\']) assert.equal(parseFileReferences(raw, options), null);
  assert.equal(parseFileReferences(String.raw`C:\missing.pdf`, { isFile: () => false }), null);
});
