import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, extname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff', '.svg']);
export const ATTACHMENT_KINDS = ['image', 'file', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'log', 'rtf', 'tex', 'epub', 'pages', 'numbers', 'key', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'mp3', 'wav', 'm4a', 'flac', 'ogg', 'mp4', 'mov', 'webm', 'mkv', 'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'zsh', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'go', 'java', 'kt', 'swift', 'rb', 'php', 'vue', 'svelte', 'css', 'scss', 'html', 'xml', 'sql', 'yaml', 'yml', 'toml', 'ini', 'ipynb'];
const documentExtensions = new Set(ATTACHMENT_KINDS.slice(2));
export function attachmentKind(path) {
  const extension = extname(path).toLowerCase();
  if (imageExtensions.has(extension)) return 'image';
  const kind = extension.slice(1);
  return documentExtensions.has(kind) ? kind : 'file';
}

export function isRegisteredAttachmentMarker(marker, content) {
  if (typeof content === 'string') return marker.startsWith('[paste #');
  return Boolean(content && typeof content.kind === 'string' && marker.startsWith('[' + content.kind + '.'));
}

const pathPrefix = /^(?:\/|~\/|\.\.?\/|file:\/\/|[a-z]:[\\/]|\\\\[^\\]+\\)/i;
const windowsPath = /^(?:[a-z]:[\\/]|\\\\[^\\]+\\)/i;

/** Small shell-word reader, not a shell: no expansion or command execution. */
export function parseFileReferences(text, { allowText = false, cwd = process.cwd(), home = homedir(), isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } } } = {}) {
  const words = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/.test(text[at])) { at++; continue; }
    const unquotedStart = text.slice(at).replace(/^@?["']?/, '');
    if (allowText && !pathPrefix.test(unquotedStart)) {
      while (at < text.length && !/\s/.test(text[at])) at++;
      continue;
    }
    const start = at;
    const nativeWindows = windowsPath.test(unquotedStart);
    let value = '', quote = null;
    while (at < text.length) {
      const char = text[at];
      if (!quote && /\s/.test(char)) break;
      if (char === '\\' && quote !== "'" && !nativeWindows) {
        if (++at >= text.length) return null;
        value += text[at++];
      } else if (quote && char === quote) { quote = null; at++; }
      else if (!quote && (char === '"' || char === "'")) { quote = char; at++; }
      else { value += char; at++; }
    }
    if (quote) return null;
    if (value.startsWith('@')) value = value.slice(1);
    if (!pathPrefix.test(value)) return null;
    let path;
    try {
      if (/^file:\/\//i.test(value)) {
        const url = new URL(value);
        // Node's URL conversion validates encoded separators and UNC hosts too.
        const windows = (url.hostname && url.hostname !== 'localhost') || /^\/[a-z]:\//i.test(url.pathname);
        path = fileURLToPath(url, { windows: Boolean(windows) || process.platform === 'win32' });
      } else if (nativeWindows) path = win32.normalize(value);
      else path = resolve(cwd, value.startsWith('~/') ? home + value.slice(1) : value);
    }
    catch { return null; }
    if (!isFile(path)) { if (allowText) continue; return null; }
    words.push({ start, end: at, raw: text.slice(start, at), path, kind: attachmentKind(path) });
  }
  return words.length ? words : null;
}

/** Preserve every separator and original quoting for expansion at submission. */
// Keep v1 callers safe while a migration is interrupted between module writes.
export function compactFileReferences(text, register, currentText = '', options) {
  return compactTypedFileReferences(text, (kind, raw) => register(kind === 'image' ? 'image' : 'file', raw), currentText, options);
}

export function compactTypedFileReferences(text, register, currentText = '', options) {
  if (currentText.trimStart().startsWith('!')) return text;
  const files = parseFileReferences(text, options);
  if (!files) return text;
  let result = '', at = 0;
  for (const file of files) {
    result += text.slice(at, file.start) + register(file.kind, file.raw);
    at = file.end;
  }
  return result + text.slice(at);
}

/** Display only: session storage and model input are never rewritten. */
export function presentFileReferences(text) { return presentReferences(text, compactFileReferences); }
export function presentTypedFileReferences(text) { return presentReferences(text, compactTypedFileReferences); }
function presentReferences(text, compact) {
  if (text.trimStart().startsWith('!')) return text;
  let counter = 0, fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return compact(line, (kind) => `[${kind}.${++counter}]`, '', { allowText: true });
  }).join('\n');
}
