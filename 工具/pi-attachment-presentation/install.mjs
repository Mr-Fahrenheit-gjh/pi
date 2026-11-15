import { readFileSync, writeFileSync, realpathSync, existsSync, readdirSync, mkdirSync, renameSync, unlinkSync, statSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ATTACHMENT_KINDS } from './file-references.mjs';
import { patch as patchTuiBackground } from '../pi-tui-session-background/install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stamp = '// pi-attachment-presentation-v1';
const editorStamp = '// pi-attachment-presentation-v2';
const legacyHelperHash = 'f1fb93d7561d422058b464872af46c0068cc39805cfc90fd8c7a7230a479ef1c';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const backupName = (path) => hash(path).slice(0, 16) + '.js';
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported attachment patch anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
function imported(source, specifier, names) { return `${stamp}\nimport { ${names} } from ${JSON.stringify(specifier)};\n${source}`; }
function assertContained(root, path) {
  const actual = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), path.slice(path.lastIndexOf('/') + 1));
  const location = relative(root, actual);
  if (location.startsWith('..') || isAbsolute(location)) throw new Error(`Attachment target escapes SDK root: ${path}`);
}

export function patchEditorV1(source, specifier, bundled = false) {
  if (source.startsWith(stamp)) return source;
  source = once(source, String.raw`/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g`, String.raw`/\[(?:paste #|image\.|file\.)(\d+)( (\+\d+ lines|\d+ chars))?\]/g`);
  source = once(source, String.raw`/^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/`, String.raw`/^\[(?:paste #|image\.|file\.)(\d+)( (\+\d+ lines|\d+ chars))?\]$/`);
  source = once(source, bundled ? 'segment.length>=10' : 'segment.length >= 10', bundled ? 'segment.length>=8' : 'segment.length >= 8');
  source = once(source, '!text.includes("[paste #")', '!text.includes("[")');
  const pasteId = '${pasteId}';
  source = once(source, String.raw`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, String.raw`\\[(?:paste #|image\\.|file\\.)${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`);
  const method = `compactFileReferences(text, allowText = false) {
    return compactFileReferences(text, (kind, raw) => {
      let id;
      do { id = ++this.pasteCounter; } while (['file.', 'image.', 'paste #'].some((prefix) => (text + (allowText ? '' : this.getText())).includes('[' + prefix + id + ']')));
      this.pastes.set(id, { kind, text: raw });
      return '[' + kind + '.' + id + ']';
    }, allowText ? text : this.getExpandedText(), { allowText });
  }
  `;
  source = once(source, bundled ? '()=>pasteContent' : '() => pasteContent', '(marker) => typeof pasteContent === "string" ? (marker.startsWith("[paste #") ? pasteContent : marker) : (marker.startsWith("[" + pasteContent.kind + ".") ? pasteContent.text : marker)');
  source = once(source, bundled ? 'expandPasteMarkers(text){' : 'expandPasteMarkers(text) {', method + (bundled ? 'expandPasteMarkers(text){' : 'expandPasteMarkers(text) {'));
  source = once(source, bundled ? 'this.pasteCounter=0,this.setTextInternal(normalized)' : 'this.pasteCounter = 0;\n        this.setTextInternal(normalized);', bundled ? 'this.pasteCounter=0,this.setTextInternal(this.compactFileReferences(normalized, true))' : 'this.pasteCounter = 0;\n        this.setTextInternal(this.compactFileReferences(normalized, true));');
  source = once(source, bundled ? 'this.exitHistoryBrowsing(),this.insertTextAtCursorInternal(text))' : 'this.exitHistoryBrowsing();\n        this.insertTextAtCursorInternal(text);', bundled ? 'this.exitHistoryBrowsing(),this.insertTextAtCursorInternal(this.compactFileReferences(text)))' : 'this.exitHistoryBrowsing();\n        this.insertTextAtCursorInternal(this.compactFileReferences(text));');
  source = once(source, bundled ? 'let pastedLines=filteredText.split(' : 'const pastedLines = filteredText.split(', (bundled ? 'filteredText=this.compactFileReferences(filteredText);let pastedLines=filteredText.split(' : 'filteredText = this.compactFileReferences(filteredText);\n        const pastedLines = filteredText.split('));
  source = once(source, bundled ? 'this.setTextInternal(this.history[this.historyIndex]||"",direction===-1?"start":"end")' : 'this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");', bundled ? 'this.setTextInternal(this.compactFileReferences(this.history[this.historyIndex]||"",true),direction===-1?"start":"end")' : 'this.setTextInternal(this.compactFileReferences(this.history[this.historyIndex] || "", true), direction === -1 ? "start" : "end");');
  // Keep IDs stable after deletion. Renumbering can retarget a literal label or
  // an existing attachment; undo already snapshots the registry and counter.
  const deleteStart = bundled ? 'this.pastes.delete(targetId),this.pasteCounter--;' : 'this.pastes.delete(targetId);\n                this.pasteCounter--;';
  const deleteEnd = bundled ? '}line=this.state.lines[this.state.cursorLine]||""' : '}\n            line = this.state.lines[this.state.cursorLine] || "";';
  const start = source.indexOf(deleteStart), end = source.indexOf(deleteEnd, start);
  if (start < 0 || end < start || !source.slice(start, end).includes('higherIds')) throw new Error('Unsupported editor marker deletion block');
  source = source.slice(0, start) + 'this.pastes.delete(targetId);' + (bundled ? '' : '\n            ') + source.slice(end);
  source = once(source, bundled ? 'let printable=decodePrintableKey(data)' : 'const printable = decodePrintableKey(data);', (bundled ? 'if(data.length>1&&parseFileReferences(data)){this.insertTextAtCursor(data);return}let printable=decodePrintableKey(data)' : 'if (data.length > 1 && parseFileReferences(data)) { this.insertTextAtCursor(data); return; }\n        const printable = decodePrintableKey(data);'));
  return imported(source, specifier, 'compactFileReferences, parseFileReferences');
}

export function patchEditor(source, specifier, bundled = false, original = source) {
  if (original.includes('// pi-attachment-presentation-v')) throw new Error('Original editor backup is required to verify a patched editor');
  const legacy = patchEditorV1(original, specifier, bundled);
  const kinds = ATTACHMENT_KINDS.join('|');
  const oldPrefix = String.raw`(?:paste #|image\.|file\.)`;
  const prefix = String.raw`(?:paste #|(?:${kinds})\.)`;
  let after = once(legacy, stamp, editorStamp);
  after = once(after, String.raw`/\[${oldPrefix}(\d+)( (\+\d+ lines|\d+ chars))?\]/g`, String.raw`/\[${prefix}(\d+)( (\+\d+ lines|\d+ chars))?\]/g`);
  after = once(after, String.raw`/^\[${oldPrefix}(\d+)( (\+\d+ lines|\d+ chars))?\]$/`, String.raw`/^\[${prefix}(\d+)( (\+\d+ lines|\d+ chars))?\]$/`);
  const pasteId = '${pasteId}';
  after = once(after, String.raw`\\[(?:paste #|image\\.|file\\.)${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, String.raw`\\[(?:paste #|(?:${kinds})\\.)${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`);
  after = once(after, bundled ? 'segment.length>=8' : 'segment.length >= 8', bundled ? 'segment.length>=5' : 'segment.length >= 5');
  after = once(after, "['file.', 'image.', 'paste #'].some((prefix) => (text + (allowText ? '' : this.getText())).includes('[' + prefix + id + ']'))", "[...(text + (allowText ? '' : this.getText())).matchAll(PASTE_MARKER_REGEX)].some((match) => Number(match[1]) === id)");
  after = once(after, 'compactFileReferences, parseFileReferences } from', 'compactTypedFileReferences as compactFileReferences, parseFileReferences, isRegisteredAttachmentMarker } from');
  after = once(after, 'new Set(this.pastes.keys())', 'new Map(this.pastes)');
  after = once(after, 'validIds.has(id)', bundled ? 'isRegisteredAttachmentMarker(m2[0], validIds.get(id))' : 'isRegisteredAttachmentMarker(m[0], validIds.get(id))');
  if (source !== original && source !== legacy && source !== after) throw new Error('Unknown or modified attachment editor; refusing migration');
  return after;
}

export function patchInteractiveV1(source, specifier, bundled = false) {
  if (source.startsWith(stamp)) return source;
  for (const name of ['currentText', 'savedText']) {
    const before = bundled ? `${name}=this.editor.getText()` : `const ${name} = this.editor.getText();`;
    const after = bundled ? `${name}=(this.editor.getExpandedText?.()??this.editor.getText())` : `const ${name} = this.editor.getExpandedText?.() ?? this.editor.getText();`;
    source = once(source, before, after);
  }
  source = once(source, bundled ? 'currentText=options?.currentText??this.editor.getText()' : 'const currentText = options?.currentText ?? this.editor.getText();', bundled ? 'currentText=options?.currentText??this.editor.getExpandedText?.()??this.editor.getText()' : 'const currentText = options?.currentText ?? this.editor.getExpandedText?.() ?? this.editor.getText();');
  // The bundled interactive chunk also owns the sent-message and dialog editors.
  if (bundled) {
    source = once(source, 'new Markdown(this.text,this.outputPad', 'new Markdown(presentFileReferences(this.text),this.outputPad');
    source = once(source, 'content=this.editor.getText();this.tui.stop()', 'content=this.editor.getExpandedText?.()??this.editor.getText();this.tui.stop()');
  }
  return imported(source, specifier, 'presentFileReferences');
}
export function patchUserMessageV1(source, specifier) {
  if (source.startsWith(stamp)) return source;
  return imported(once(source, 'new Markdown(this.text, this.outputPad', 'new Markdown(presentFileReferences(this.text), this.outputPad'), specifier, 'presentFileReferences');
}

function patchTypedRenderer(source, specifier, bundled, original, legacyPatch) {
  if (original.includes('// pi-attachment-presentation-v')) throw new Error('Original renderer backup is required');
  const legacy = legacyPatch(original, specifier, bundled);
  let after = once(legacy, stamp, editorStamp);
  after = once(after, '{ presentFileReferences } from', '{ presentTypedFileReferences as presentFileReferences } from');
  // run() is shared with the TUI background adapter. Verify its complete,
  // deterministic output against our original rather than stripping markers.
  if (legacyPatch === patchInteractiveV1 && source.includes('// pi-tui-session-background:1') && !original.includes('// pi-tui-session-background:1')) {
    const composed = patchTuiBackground(after, bundled);
    if (source !== composed) throw new Error('Unknown attachment/background composition');
    return composed;
  }
  if (source !== original && source !== legacy && source !== after) throw new Error('Unknown or modified attachment renderer');
  return after;
}
export function patchInteractive(source, specifier, bundled = false, original = source) {
  return patchTypedRenderer(source, specifier, bundled, original, patchInteractiveV1);
}
export function patchUserMessage(source, specifier, bundled = false, original = source) {
  return patchTypedRenderer(source, specifier, bundled, original, patchUserMessageV1);
}

export function patchDialogEditor(source) {
  if (source.startsWith(stamp)) return source;
  return stamp + '\n' + once(source, 'const content = this.editor.getText();', 'const content = this.editor.getExpandedText?.() ?? this.editor.getText();');
}

export function plan(sdkRoot) {
  const root = realpathSync(sdkRoot);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || !['1.4.0', '1.5.0'].includes(pkg.version)) throw new Error(`Unsupported SDK ${pkg.name}@${pkg.version}`);
  const helper = join(root, 'dist/pi-file-references.mjs');
  assertContained(root, helper);
  const chunks = join(root, 'dist/bundle/chunks');
  const js = readdirSync(chunks).filter((file) => file.endsWith('.js')).map((file) => join(chunks, file));
  const find = (anchor) => {
    const matches = js.filter((file) => readFileSync(file, 'utf8').includes(anchor));
    if (matches.length !== 1) throw new Error(`Expected one bundle for ${anchor}`);
    return matches[0];
  };
  const editorBundle = find('expandPasteMarkers(text){');
  const interactiveBundle = find('setCustomEditorComponent(factory){');
  const editor = join(root, 'node_modules/@earendil-works/pi-tui/dist/components/editor.js');
  if (!existsSync(editor)) throw new Error('Expected nested pi-tui package; resolve the actual installed layout before applying');
  const targets = [
    [editor, patchEditor, patchEditorV1, false], [editorBundle, patchEditor, patchEditorV1, true],
    [join(root, 'dist/modes/interactive/interactive-mode.js'), patchInteractive, patchInteractiveV1, false],
    [interactiveBundle, patchInteractive, patchInteractiveV1, true],
    [join(root, 'dist/modes/interactive/components/user-message.js'), patchUserMessage, patchUserMessageV1, false],
    [join(root, 'dist/modes/interactive/components/extension-editor.js'), patchDialogEditor, patchDialogEditor, false],
  ];
  const changes = targets.map(([path, patch, legacyPatch, bundled]) => {
    assertContained(root, path);
    const before = readFileSync(path, 'utf8');
    let specifier = relative(dirname(path), helper).split('\\').join('/');
    if (!specifier.startsWith('.')) specifier = './' + specifier;
    const saved = join(root, 'dist/pi-attachment-presentation-backup', backupName(path));
    assertContained(root, existsSync(saved) ? saved : dirname(saved));
    if (before.includes('// pi-attachment-presentation-v') && !existsSync(saved)) throw new Error('Missing original attachment backup: ' + path);
    const original = existsSync(saved) ? readFileSync(saved, 'utf8') : before;
    if (original.includes('// pi-attachment-presentation-v')) throw new Error('Original attachment backup is already patched: ' + path);
    const legacy = legacyPatch(original, specifier, bundled);
    const after = patch === patchDialogEditor ? legacy : patch(before, specifier, bundled, original);
    if (before !== original && before !== legacy && before !== after) throw new Error('Unknown attachment target changes: ' + path);
    return { path, before, after, original, legacy, specifier };
  });
  const before = existsSync(helper) ? readFileSync(helper, 'utf8') : null;
  const after = readFileSync(join(here, 'file-references.mjs'), 'utf8');
  if (before !== null && before !== after && hash(before) !== legacyHelperHash) throw new Error('Unknown attachment helper changes');
  changes.push({ path: helper, before, after, original: null });
  return changes;
}

function atomicWrite(path, content) {
  const temporary = path + '.pi-attachment-' + randomUUID();
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

const diskIO = {
  read: (path) => existsSync(path) ? readFileSync(path, 'utf8') : null,
  write: atomicWrite,
  remove: unlinkSync,
  log: (path) => console.log('Patched', path),
};

export function applyPlannedWrites(files, io = diskIO) {
  const written = [];
  try {
    for (const file of files) {
      if (io.read(file.path) !== file.before) throw new Error('Attachment target changed before write: ' + file.path);
      io.write(file.path, file.after);
      written.push(file);
      io.log?.(file.path);
    }
  } catch (error) {
    const failures = [];
    for (const file of written.reverse()) {
      try {
        if (file.keepOnRollbackFailure && failures.length) throw new Error('Kept compatibility helper for incomplete rollback: ' + file.path);
        if (io.read(file.path) !== file.after) throw new Error('Rollback conflict; not overwriting: ' + file.path);
        if (file.before === null) io.remove(file.path); else io.write(file.path, file.before);
      } catch (recoveryError) { failures.push(recoveryError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Attachment update failed; rollback incomplete: ' + failures.map((failure) => failure.message).join('; '));
    throw error;
  }
}

export function applyChanges(sdkRoot) {
  const root = realpathSync(sdkRoot);
  const lock = join(root, 'dist/.pi-attachment-presentation-lock');
  assertContained(root, lock);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Attachment migration is locked; inspect the recorded owner before retrying'); throw error; }
  const owner = join(lock, 'owner.json');
  try {
    writeFileSync(owner, JSON.stringify({ pid: process.pid, token: randomUUID() }), { flag: 'wx', mode: 0o600 });
    // Replan under the lock, not from a stale pre-lock snapshot.
    const changes = plan(root);
    const helper = join(root, 'dist/pi-file-references.mjs');
    const pending = changes.filter((file) => file.before !== file.after)
      .map((file) => ({ ...file, keepOnRollbackFailure: file.path === helper }))
      .sort((a, b) => a.path === helper ? -1 : b.path === helper ? 1 : 0);
    if (!pending.length) return;
    const originalBackup = join(root, 'dist/pi-attachment-presentation-backup');
    const backup = join(root, 'dist/pi-attachment-presentation-v2-backup');
    assertContained(root, originalBackup); assertContained(root, backup);
    mkdirSync(originalBackup, { recursive: true, mode: 0o700 });
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    const manifestPath = join(backup, 'manifest.json'); assertContained(root, manifestPath);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {
      schemaVersion: 1, sdkRoot: root, files: pending.map((file) => ({ path: relative(root, file.path), backup: backupName(file.path), before: file.before === null ? null : hash(file.before), after: hash(file.after) })),
    };
    if (manifest.schemaVersion !== 1 || manifest.sdkRoot !== root || !Array.isArray(manifest.files) || !manifest.files.length || new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) throw new Error('Invalid v2 migration manifest');
    // An interrupted update may contain both before and after files. Validate
    // the original full unit, then write only the still-pending members.
    for (const record of manifest.files) {
      const file = changes.find((entry) => relative(root, entry.path) === record.path);
      if (!file || record.backup !== backupName(file.path) || record.after !== hash(file.after) || (record.before !== null && !/^[a-f0-9]{64}$/.test(record.before))) throw new Error('Existing v2 backup belongs to a different migration');
      const currentHash = file.before === null ? null : hash(file.before);
      if (currentHash !== record.before && currentHash !== record.after) throw new Error('Interrupted migration has unknown target bytes: ' + file.path);
      if (record.before !== null) {
        const saved = join(backup, record.backup); assertContained(root, saved);
        if (existsSync(saved)) { if (hash(readFileSync(saved, 'utf8')) !== record.before) throw new Error('Unexpected v2 backup bytes'); }
        else if (currentHash === record.before) writeFileSync(saved, file.before, { flag: 'wx', mode: 0o600 });
        else throw new Error('Missing pre-update backup: ' + file.path);
      }
      const original = join(originalBackup, backupName(file.path)); assertContained(root, original);
      if (file.original !== null && !existsSync(original)) writeFileSync(original, file.original, { flag: 'wx', mode: 0o600 });
    }
    if (pending.some((file) => !manifest.files.some((record) => record.path === relative(root, file.path)))) throw new Error('Pending file is outside the recorded migration');
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    applyPlannedWrites(pending);
  } finally {
    if (existsSync(owner)) unlinkSync(owner);
    rmdirSync(lock);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), root = args[args.indexOf('--sdk') + 1];
  if (!args.includes('--sdk') || !root || args.includes('--apply') === args.includes('--check')) throw new Error('Usage: node install.mjs --sdk <root> --check|--apply [--allow-external]');
  const changes = plan(root);
  if (args.includes('--check')) {
    console.log(JSON.stringify({ compatible: true, pending: changes.filter((file) => file.before !== file.after).map((file) => file.path) }, null, 2));
  } else {
    const outside = relative(realpathSync(process.cwd()), realpathSync(root));
    if ((outside.startsWith('..') || isAbsolute(outside)) && !args.includes('--allow-external')) throw new Error('External activation requires explicit approval and --allow-external');
    applyChanges(root);
  }
}
