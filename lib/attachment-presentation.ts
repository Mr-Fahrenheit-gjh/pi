import { buildAtMentionText } from "./file-fuzzy";
import { getFileName, normalizeFilePathSlashes } from "./file-paths";

export interface AttachmentReference { name: string; path: string }
export interface PresentedAttachment extends AttachmentReference { token: string }

// Only private chat uploads are presentation metadata. Ordinary paths, code,
// URLs and project @mentions remain untouched.
const privateMention = /(^|\s)@(?:"([^"\n]+)"|([^\s"<>]+))/g;
function attachmentPath(value: string): boolean {
  // Normalize only for recognition; drafts and requests retain the native path.
  return /^(?:\/|[a-zA-Z]:\/)[^\r\n]*\/chat-attachments\/[a-f0-9]{64}\/[^/]+$/.test(normalizeFilePathSlashes(value));
}

/** Per-composer registry: keeping removed tokens makes native undo lossless. */
export class AttachmentPresentation {
  private entries: PresentedAttachment[] = [];
  private nextId = 1;

  compact(text: string): string {
    return text.replace(privateMention, (match, space: string, quoted: string, plain: string) => {
      const path = quoted ?? plain;
      if (!attachmentPath(path)) return match;
      let file = this.entries.find((entry) => entry.path === path);
      if (!file) {
        let token: string;
        do { token = `[file.${this.nextId++}]`; } while (text.includes(token));
        file = { token, path, name: getFileName(path) };
        this.entries.push(file);
      }
      return space + file.token;
    });
  }

  expand(text: string): string {
    return text.replace(/\[file\.\d+\]/g, (token) => {
      const file = this.entries.find((entry) => entry.token === token);
      return file ? buildAtMentionText(file.path, false).trimEnd() : token;
    });
  }

  files(text: string): PresentedAttachment[] {
    return this.entries.filter((entry) => text.includes(entry.token));
  }
}

/** The composer keeps files outside editable text; drafts still store real @references. */
export function splitComposerAttachments(raw: string): { text: string; files: AttachmentReference[] } {
  const presentation = new AttachmentPresentation();
  const compact = presentation.compact(raw);
  const files = presentation.files(compact);
  if (!files.length) return { text: raw, files: [] };
  const removeTokens = (text: string) => text.replace(/\[file\.\d+\]/g, (token) => files.some((file) => file.token === token) ? "" : token);
  const first = Math.min(...files.map((file) => compact.indexOf(file.token)));
  const prefix = compact.slice(0, first);
  // Reverse our exact draft separator without trimming the user's trailing spaces.
  const text = !removeTokens(compact.slice(first)).trim() && prefix.endsWith("\n\n")
    ? prefix.slice(0, -2)
    : removeTokens(compact).trim();
  return { text, files: files.map(({ name, path }) => ({ name, path })) };
}

export function mergeComposerAttachments(...groups: AttachmentReference[][]): AttachmentReference[] {
  return [...new Map(groups.flat().map((file) => [file.path, file])).values()];
}

export function serializeComposerAttachments(text: string, files: AttachmentReference[]): string {
  const references = mergeComposerAttachments(files).map((file) => buildAtMentionText(file.path, false).trimEnd()).join(" ");
  return references ? text + (text ? "\n\n" : "") + references : text;
}

export function presentAttachmentMessage(raw: string): { text: string; files: PresentedAttachment[] } {
  const presentation = new AttachmentPresentation();
  const compact = presentation.compact(raw);
  const files = presentation.files(compact);
  const text = compact.replace(/\[file\.\d+\]/g, (token) => files.some((file) => file.token === token) ? "" : token).trim();
  return { text, files };
}
