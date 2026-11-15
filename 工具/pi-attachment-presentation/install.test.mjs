import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { attachmentKind, compactTypedFileReferences as compactFileReferences, compactFileReferences as legacyCompact, parseFileReferences, presentTypedFileReferences as presentFileReferences, presentFileReferences as legacyPresent } from './file-references.mjs';
import { plan, patchEditor, patchEditorV1, patchInteractive, applyPlannedWrites } from './install.mjs';

const sdk = process.env.PI_ATTACHMENT_TEST_SDK || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const helper = new URL('./file-references.mjs', import.meta.url).href;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-attachments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const image = join(root, '中文 photo.png'), document = join(root, 'report.pdf');
  writeFileSync(image, 'fixture'); writeFileSync(document, 'fixture');
  return { root, image, document };
}

test('file labels identify document, data, archive, media and code extensions', () => {
  for (const kind of ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'zip', 'mp3', 'mp4', 'ts', 'py', 'c']) {
    assert.equal(attachmentKind(`/tmp/report.${kind.toUpperCase()}`), kind);
  }
  for (const extension of ['png', 'JPG', 'heic', 'svg']) assert.equal(attachmentKind(`/tmp/photo.${extension}`), 'image');
  for (const path of ['/tmp/README', '/tmp/.bashrc', '/tmp/file.unknown']) assert.equal(attachmentKind(path), 'file');
});

test('shell quoting, escapes, unicode, multiple files and original separators', (t) => {
  const { image, document, root } = fixture(t);
  const raw = ` '${image}'  ${document}\n`;
  const refs = parseFileReferences(raw);
  assert.deepEqual(refs.map((item) => item.kind), ['image', 'pdf']);
  assert.equal(refs[0].raw, `'${image}'`);
  assert.equal(parseFileReferences(image.replaceAll(' ', '\\ '))[0].path, image);
  assert.equal(parseFileReferences(new URL(pathToFileURL(document)) + '')[0].path, document);
  assert.equal(parseFileReferences('./report.pdf', { cwd: root })[0].path, document);
  assert.equal(parseFileReferences('~/report.pdf', { home: root })[0].path, document);
  const registry = [];
  assert.equal(compactFileReferences(raw, (kind, value) => { registry.push(value); return `[${kind}.${registry.length}]`; }), ' [image.1]  [pdf.2]\n');
  assert.deepEqual(registry, [`'${image}'`, document]);
});
test('the new helper preserves its v1 exports until all editors are migrated', (t) => {
  const { document } = fixture(t);
  assert.equal(legacyCompact(document, (kind) => `[${kind}.1]`), '[file.1]');
  assert.equal(legacyPresent(`Read ${document}`), 'Read [file.1]');
  assert.equal(presentFileReferences(`Read ${document}`), 'Read [pdf.1]');
});

test('no shell execution, missing paths, directories or ordinary text', (t) => {
  const { root, document } = fixture(t);
  for (const raw of ['hello world', '/missing/pi-file.png', root, `cat ${document}`, `'${document}`, `$(touch ${document})`]) assert.equal(parseFileReferences(raw), null, raw);
  assert.equal(compactFileReferences(document, () => 'wrong', '!cat '), document);
});
test('sent-message display preserves commands, code fences and unknown markers', (t) => {
  const { document } = fixture(t);
  assert.equal(presentFileReferences(`Read ${document}`), 'Read [pdf.1]');
  assert.equal(presentFileReferences(`!cat ${document}`), `!cat ${document}`);
  const code = `\`\`\`sh\n${document}\n\`\`\``;
  assert.equal(presentFileReferences(code), code);
  assert.equal(presentFileReferences('[image.1]'), '[image.1]');
});

// Load the actual installed source and actual CLI chunk into temporary modules;
// resolve their existing imports in-place without touching global files.
function absoluteImports(source, original) {
  return source.replace(/(from\s*|import\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, prefix, quote, specifier) => prefix + quote + new URL(specifier, pathToFileURL(original)).href + quote);
}
for (const bundled of [false, true]) {
  test(`${bundled ? 'actual bundled CLI' : 'unbundled SDK'} editor: paste, clipboard insert, history, undo, delete and submit`, async (t) => {
    const { root, image, document } = fixture(t);
    const changes = plan(sdk);
    const file = changes.find((item) => bundled ? item.path.includes('/bundle/') && item.before.includes('expandPasteMarkers(text){') : item.path.endsWith('/components/editor.js'));
    assert.ok(file);
    const patched = patchEditor(file.original, helper, bundled);
    assert.equal(patchEditor(patched, helper, bundled, file.original), patched);
    assert.throws(() => patchEditor(patched + '\n// unexpected local modification', helper, bundled, file.original), /Unknown or modified/);
    const modulePath = join(root, bundled ? 'bundle.mjs' : 'editor.mjs');
    writeFileSync(modulePath, absoluteImports(patched, file.path) + '\nexport { isPasteMarker as attachmentMarkerForTest };');
    const { Editor, attachmentMarkerForTest } = await import(pathToFileURL(modulePath).href);
    const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme = { borderColor: (text) => text };
    const legacyPath = join(root, 'legacy-' + (bundled ? 'bundle.mjs' : 'editor.mjs'));
    writeFileSync(legacyPath, absoluteImports(patchEditorV1(file.original, helper, bundled), file.path));
    const { Editor: LegacyEditor } = await import(pathToFileURL(legacyPath).href);
    const legacyEditor = new LegacyEditor(tui, theme);
    legacyEditor.insertTextAtCursor(document);
    assert.equal(legacyEditor.getText(), '[file.1]', 'v1 editors remain compatible while the new helper is installed first');
    assert.equal(legacyEditor.getExpandedText(), document);
    const editor = new Editor(tui, theme);
    const raw = `'${image}' ${document}`;
    editor.handleInput(`\x1b[200~${raw}\x1b[201~`);
    assert.equal(editor.getText(), '[image.1] [pdf.2]');
    assert.equal(editor.getExpandedText(), raw);
    assert.equal(editor.segment(editor.getText(), 'grapheme').length, 3);
    assert.ok(editor.render(18).length > 0);
    editor.handleBackspace();
    assert.equal(editor.getText(), '[image.1] ');
    assert.equal(editor.getExpandedText(), `'${image}' `);
    editor.undo();
    assert.equal(editor.getExpandedText(), raw);
    editor.setText('');
    editor.handleInput(document);
    assert.equal(editor.getText(), '[pdf.1]');
    assert.equal(editor.getExpandedText(), document);
    editor.setText(`Read @"${image}" ${document}`);
    assert.equal(editor.getText(), 'Read [image.1] [pdf.2]');
    assert.equal(editor.getExpandedText(), `Read @"${image}" ${document}`);
    editor.setText('');
    editor.addToHistory(document);
    editor.navigateHistory(-1);
    assert.match(editor.getText(), /^\[pdf\.\d+\]$/);
    assert.equal(editor.getExpandedText(), document);
    editor.navigateHistory(1);
    assert.equal(editor.getText(), '');
    editor.setText('');
    editor.insertTextAtCursor(`'${image}'`);
    assert.equal(editor.getText(), '[image.1]');
    editor.insertTextAtCursor(' [file.1]');
    assert.equal(editor.getExpandedText(), `'${image}' [file.1]`, 'a different marker kind cannot alias an attachment');
    editor.handleBackspace();
    assert.equal(editor.getExpandedText(), `'${image}' [file.1`, 'deleting an unregistered alias must not delete the real image mapping');
    editor.undo();
    editor.undo();
    let submitted;
    editor.onSubmit = (value) => { submitted = value; };
    editor.submitValue();
    assert.equal(submitted, `'${image}'`);
    assert.equal(editor.getText(), '');
    editor.setText('!cat ');
    editor.insertTextAtCursor(document);
    assert.equal(editor.getText(), '!cat ' + document);
    editor.setText('[file.999]');
    assert.equal(editor.getExpandedText(), '[file.999]');
    editor.setText('');
    const large = 'Long pasted text\n'.repeat(20);
    editor.handlePaste(large);
    assert.match(editor.getText(), /^\[paste #1/);
    assert.equal(editor.getExpandedText(), large);
    editor.insertTextAtCursor(' [file.1]');
    assert.equal(editor.getExpandedText(), large + ' [file.1]', 'typed file labels cannot alias a text paste');
    editor.setText('[pdf.1] ');
    editor.insertTextAtCursor(document);
    assert.equal(editor.getText(), '[pdf.1] [pdf.2]');
    assert.equal(editor.getExpandedText(), '[pdf.1] ' + document);
    for (const kind of ['c', 'md', 'txt', 'docx', 'xlsx', 'csv', 'json', 'zip', 'ts']) {
      const path = join(root, `sample.${kind}`); writeFileSync(path, 'fixture');
      editor.setText(''); editor.insertTextAtCursor(path);
      assert.equal(editor.getText(), `[${kind}.1]`);
      assert.equal(attachmentMarkerForTest(editor.getText()), true);
      assert.equal(editor.segment(editor.getText(), 'grapheme').length, 1);
      assert.ok(editor.render(8).length > 0);
      assert.equal(editor.getExpandedText(), path);
      editor.handleBackspace(); assert.equal(editor.getText(), '');
      editor.undo(); assert.equal(editor.getExpandedText(), path);
    }
  });
}
test('temporary SDK replay validates syntax, backups, idempotence and symlink boundaries', (t) => {
  const { root } = fixture(t);
  const temporarySdk = join(root, 'sdk');
  mkdirSync(temporarySdk);
  writeFileSync(join(temporarySdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' }));
  const changes = plan(sdk);
  for (const [index, file] of changes.entries()) {
    const syntaxFile = join(root, `syntax-${index}.mjs`);
    writeFileSync(syntaxFile, file.after);
    execFileSync(process.execPath, ['--check', syntaxFile]);
    if (file.original === null) continue;
    const target = join(temporarySdk, relative(realpathSync(sdk), file.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.original);
  }
  const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
  execFileSync(process.execPath, [installer, '--sdk', temporarySdk, '--apply'], { cwd: temporarySdk });
  assert.ok(plan(temporarySdk).every((file) => file.before === file.after));
  assert.ok(existsSync(join(temporarySdk, 'dist/pi-attachment-presentation-backup')));
  const helperPath = join(temporarySdk, 'dist/pi-file-references.mjs');
  rmSync(helperPath);
  symlinkSync(join(root, 'report.pdf'), helperPath);
  assert.throws(() => plan(temporarySdk), /escapes SDK root/);
});

test('installed v1 migrates as a verified unit, preserves backups, and can roll back then replay', (t) => {
  const { root } = fixture(t);
  const temporarySdk = join(realpathSync(root), 'sdk'); mkdirSync(temporarySdk);
  writeFileSync(join(temporarySdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' }));
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const name = (path) => sha(path).slice(0, 16) + '.js';
  const baseline = join(temporarySdk, 'dist/pi-attachment-presentation-backup');
  mkdirSync(baseline, { recursive: true });
  const originals = [];
  for (const file of plan(sdk).filter((file) => file.original !== null)) {
    const target = join(temporarySdk, relative(realpathSync(sdk), file.path));
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.legacy);
    const saved = join(baseline, name(target)); writeFileSync(saved, file.original);
    originals.push([saved, file.original]);
  }
  const legacyHelper = execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'show', '425c049:工具/pi-attachment-presentation/file-references.mjs'], { encoding: 'utf8' });
  const helperPath = join(temporarySdk, 'dist/pi-file-references.mjs'); writeFileSync(helperPath, legacyHelper);
  assert.equal(plan(temporarySdk).filter((file) => file.before !== file.after).length, 6);
  const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
  const apply = () => execFileSync(process.execPath, [installer, '--sdk', temporarySdk, '--apply'], { cwd: temporarySdk, stdio: 'pipe' });
  execFileSync(process.execPath, [installer, '--sdk', temporarySdk, '--check'], { cwd: temporarySdk, stdio: 'pipe' });
  assert.equal(existsSync(join(temporarySdk, 'dist/pi-attachment-presentation-v2-backup')), false, 'check must not create migration backups');
  apply();
  assert.ok(plan(temporarySdk).every((file) => file.before === file.after));
  const backup = join(temporarySdk, 'dist/pi-attachment-presentation-v2-backup');
  const manifestPath = join(backup, 'manifest.json');
  const manifestBytes = readFileSync(manifestPath, 'utf8');
  apply(); assert.equal(readFileSync(manifestPath, 'utf8'), manifestBytes);
  for (const [saved, original] of originals) assert.equal(readFileSync(saved, 'utf8'), original);
  const manifest = JSON.parse(manifestBytes);
  for (const file of manifest.files.slice().reverse()) {
    const target = join(temporarySdk, file.path);
    assert.equal(sha(readFileSync(target, 'utf8')), file.after);
    const previous = readFileSync(join(backup, file.backup), 'utf8');
    assert.equal(sha(previous), file.before);
    writeFileSync(target, previous);
  }
  assert.equal(readFileSync(helperPath, 'utf8'), legacyHelper);
  const interrupted = plan(temporarySdk).filter((file) => file.before !== file.after);
  for (const file of [interrupted.find((file) => file.path === helperPath), interrupted.find((file) => file.path.endsWith('/components/editor.js'))]) writeFileSync(file.path, file.after);
  assert.ok(plan(temporarySdk).some((file) => file.before === file.after), 'interrupted update has already-written members');
  apply(); assert.ok(plan(temporarySdk).every((file) => file.before === file.after));
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBytes, 'resume preserves the original full manifest');
  const lock = join(temporarySdk, 'dist/.pi-attachment-presentation-lock');
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), '{"pid":123,"token":"another-owner"}');
  assert.throws(apply);
  assert.match(readFileSync(join(lock, 'owner.json'), 'utf8'), /another-owner/);
  rmSync(lock, { recursive: true });
  const stable = plan(temporarySdk).map((file) => [file.path, file.before]);
  const currentHelper = readFileSync(helperPath, 'utf8');
  writeFileSync(helperPath, currentHelper + '\n// unknown helper edit');
  assert.throws(apply);
  for (const [path, before] of stable) if (path !== helperPath) assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(helperPath, currentHelper);
  const editorPath = stable.find(([path]) => path.endsWith('/components/editor.js'))[0];
  writeFileSync(editorPath, readFileSync(editorPath, 'utf8') + '\n// unexpected local edit');
  assert.throws(apply);
  for (const [path, before] of stable) if (path !== editorPath) assert.equal(readFileSync(path, 'utf8'), before);
  for (const [saved, original] of originals) assert.equal(readFileSync(saved, 'utf8'), original);
});

test('write-time conflicts preserve the other writer and roll back earlier files', () => {
  const state = new Map([['a', 'a0'], ['b', 'b0']]);
  const files = ['a', 'b'].map((path) => ({ path, before: path + '0', after: path + '1' }));
  const io = { read: (path) => state.get(path) ?? null, remove: (path) => state.delete(path), write(path, text) {
    state.set(path, text); if (path === 'a' && text === 'a1') state.set('b', 'external');
  } };
  assert.throws(() => applyPlannedWrites(files, io), /changed before write/);
  assert.equal(state.get('a'), 'a0'); assert.equal(state.get('b'), 'external');
});

test('rollback continues after errors, preserves conflicts and retains the compatibility helper', () => {
  const names = ['helper', 'a', 'b', 'c', 'd'];
  const state = new Map(names.map((path) => [path, path + '0']));
  const files = names.map((path) => ({ path, before: path + '0', after: path + '1', keepOnRollbackFailure: path === 'helper' }));
  const io = { read: (path) => state.get(path) ?? null, remove: (path) => state.delete(path), write(path, text) {
    if (path === 'd' && text === 'd1') { state.set('a', 'external'); throw new Error('d write failed'); }
    if (path === 'c' && text === 'c0') throw new Error('c recovery failed');
    state.set(path, text);
  } };
  assert.throws(() => applyPlannedWrites(files, io), (error) => error instanceof AggregateError && error.errors.length === 4);
  assert.equal(state.get('b'), 'b0', 'an earlier failed recovery must not stop later recovery');
  assert.equal(state.get('a'), 'external', 'rollback must not overwrite a concurrent change');
  assert.equal(state.get('c'), 'c1'); assert.equal(state.get('helper'), 'helper1'); assert.equal(state.get('d'), 'd0');
});

test('all live anchors validate before writes, idempotence and unknown shape fails closed', () => {
  const changes = plan(sdk);
  assert.equal(changes.length, 7);
  assert.ok(changes.every((file) => typeof file.after === 'string' && file.after.length > 0));
  assert.ok(changes.slice(0, -1).every((file) => /^\/\/ pi-attachment-presentation-v[12]/.test(file.after)));
  for (const file of changes.filter((file) => file.path.includes('interactive-mode.js') || file.before?.includes('setCustomEditorComponent(factory){'))) {
    assert.ok(file.after.includes('getExpandedText?.()'));
    assert.equal(patchInteractive(file.after, file.specifier, file.path.includes('/bundle/'), file.original), file.after);
  }
  assert.throws(() => patchEditor('changed upstream source', helper), /Unsupported attachment patch anchor/);
});
