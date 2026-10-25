import { buildAtMentionText } from "./file-fuzzy";

export interface PresentedAttachment { token: string; name: string; path: string }

// Only private chat uploads are presentation metadata. Ordinary paths, code,
// URLs and project @mentions remain untouched.
const privateMention = /(^|\s)@(?:"([^"\n]+)"|([^\s"<>]+))/g;
function attachmentPath(value: string): boolean {
  return /^\/[^\n]*\/chat-attachments\/[a-f0-9]{64}\/[^/]+$/.test(value);
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
        file = { token, path, name: path.slice(path.lastIndexOf("/") + 1) };
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

export function presentAttachmentMessage(raw: string): { text: string; files: PresentedAttachment[] } {
  const presentation = new AttachmentPresentation();
  const compact = presentation.compact(raw);
  const files = presentation.files(compact);
  const text = compact.replace(/\[file\.\d+\]/g, (token) => files.some((file) => file.token === token) ? "" : token).trim();
  return { text, files };
}
