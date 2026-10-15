import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { validateUploadFileNames } from "./file-upload";

export const CHAT_ATTACHMENT_FILE_LIMIT = 25 * 1024 * 1024;
export const CHAT_ATTACHMENT_TOTAL_LIMIT = 100 * 1024 * 1024;
export type ChatAttachment = { name: string; path: string };

export function chatAttachmentRoot(agentDir = getAgentDir()): string {
  return path.join(agentDir, "chat-attachments");
}
export function existingChatAttachmentRoot(agentDir = getAgentDir()): string | null {
  const root = chatAttachmentRoot(agentDir);
  try { const stat = fs.lstatSync(root); return stat.isDirectory() && !stat.isSymbolicLink() ? root : null; }
  catch { return null; }
}
function privateDirectory(directory: string): boolean {
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Attachment directory must not be a symbolic link");
  return Boolean(created);
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Serialize whole batches, including reuse and rollback, across server processes. */
async function acquireAttachmentLock(root: string): Promise<() => void> {
  const lock = path.join(root, ".upload.lock");
  const token = randomUUID();
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(lock, "utf8")).token === token) fs.unlinkSync(lock);
        } catch { /* Never remove a lock now owned by another process. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = path.join(root, ".upload-recovery.lock");
      let recovering = false;
      try {
        // Only one stale-owner check may race with a fresh lock acquisition.
        fs.mkdirSync(recovery, { mode: 0o700 });
        recovering = true;
        const stat = fs.lstatSync(lock);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid attachment lock");
        const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number };
        if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
          try { process.kill(owner.pid!, 0); }
          catch (reason) {
            if ((reason as NodeJS.ErrnoException).code === "ESRCH") {
              const current = fs.lstatSync(lock);
              if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) fs.unlinkSync(lock);
              continue;
            }
          }
        }
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (reason instanceof Error && reason.message === "Invalid attachment lock") throw reason;
      } finally {
        if (recovering) fs.rmdirSync(recovery);
      }
      if (Date.now() >= deadline) throw new Error("Attachment storage is busy; retry later");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Never accepts a project cwd. Re-uploading identical content/name reuses the same private file. */
export async function saveChatAttachments(files: File[], agentDir = getAgentDir()): Promise<ChatAttachment[]> {
  const invalid = validateUploadFileNames(files.map((file) => file.name));
  if (invalid) throw new Error(invalid);
  if (files.some((file) => file.size > CHAT_ATTACHMENT_FILE_LIMIT) || files.reduce((total, file) => total + file.size, 0) > CHAT_ATTACHMENT_TOTAL_LIMIT) throw new Error("Attachment size limit exceeded");
  const root = chatAttachmentRoot(agentDir);
  privateDirectory(root);
  const release = await acquireAttachmentLock(root);
  const created: string[] = [];
  const directories: string[] = [];
  const results: ChatAttachment[] = [];
  try {
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length !== file.size) throw new Error("Attachment size changed during upload");
      const hash = digest(bytes);
      const directory = path.join(root, hash);
      if (privateDirectory(directory)) directories.push(directory);
      const destination = path.join(directory, file.name);
      try {
        const fd = fs.openSync(destination, "wx", 0o600);
        created.push(destination);
        try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = fs.lstatSync(destination);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || digest(fs.readFileSync(destination)) !== hash) throw new Error("Existing attachment is not a matching regular file");
      }
      results.push({ name: file.name, path: destination });
    }
    return results;
  } catch (error) {
    for (const file of created) {
      fs.unlinkSync(file);
    }
    for (const directory of directories.reverse()) {
      try { fs.rmdirSync(directory); } catch { /* Keep directories containing another existing attachment. */ }
    }
    throw error;
  } finally { release(); }
}
