import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, link, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_ENTRY_BYTES, RELEASE_ID, validateReleaseEntry } from "./pending-release-shared.mjs";

export const DEFAULT_RELEASE_DIRECTORY = "/Users/guojiahang/Documents/pi/工具/pi-web维护/待上线";
const MAX_ENTRIES = 1000;
export class ReleaseConflictError extends Error {}
export function releaseDirectory() {
  const directory = process.env.PI_PENDING_RELEASE_DIR ?? DEFAULT_RELEASE_DIRECTORY;
  if (!path.isAbsolute(directory) || directory.includes("\0")) throw new Error("PI_PENDING_RELEASE_DIR 必须是绝对目录");
  return path.normalize(directory);
}

// Check every existing component before creating the next one. Reads never mkdir.
async function checkDirectory(directory, create = false) {
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("清单目录不得包含符号链接或非目录路径");
  }
  return true;
}
async function readEntry(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) throw new Error("清单必须是有界普通文件");
    // Bounded even if an external writer grows a file after fstat.
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_ENTRY_BYTES) throw new Error("清单文件过大");
    return validateReleaseEntry(JSON.parse(buffer.subarray(0, size).toString("utf8")));
  } finally { await handle.close(); }
}
function entryPath(directory, id) {
  if (typeof id !== "string" || !RELEASE_ID.test(id)) throw new Error("条目 ID 必须是小写 UUID");
  return path.join(directory, `${id}.json`);
}
export async function readReleaseSnapshot() {
  const directory = releaseDirectory();
  if (!await checkDirectory(directory)) return { entries: [], warnings: [], pendingCount: 0 };
  const files = await readdir(directory);
  const names = files.filter((file) => file.endsWith(".json")).sort();
  if (names.length > MAX_ENTRIES) throw new Error("清单超过 1000 项，请人工整理历史；未读取部分清单");
  const entries = [], warnings = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!RELEASE_ID.test(id)) { warnings.push("有非 UUID 的 JSON 文件，未读取；请维护者检查共享目录。"); continue; }
    try {
      const entry = await readEntry(entryPath(directory, id));
      if (entry.id !== id) throw new Error("文件名与条目 ID 不一致");
      entries.push(entry);
    } catch {
      // Never expose parser errors (which may quote private file contents).
      warnings.push(`${id}.json 无法读取或校验失败，未计入数量；请维护者检查。`);
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { entries, warnings, pendingCount: entries.filter((entry) => entry.status === "pending").length };
}
async function withEntryLock(directory, id, work) {
  const lock = path.join(directory, `.${id}.lock`);
  const deadline = Date.now() + 3000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stat;
      try { stat = await lstat(lock); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("清单锁不是普通目录");
      if (Date.now() >= deadline) throw new ReleaseConflictError("登记锁被占用；重试或人工确认原写入进程已退出后清理锁");
      await delay(20);
    }
  }
  const identity = await lstat(lock);
  const assertOwned = async () => {
    await checkDirectory(directory);
    const stat = await lstat(lock);
    if (stat.isSymbolicLink() || stat.ino !== identity.ino || stat.dev !== identity.dev) throw new ReleaseConflictError("登记锁已失效，拒绝写入");
  };
  try { return await work(assertOwned); } finally {
    // Never remove a replacement lock owned by another writer.
    try { await assertOwned(); await rmdir(lock); } catch { /* Leave uncertain locks for an operator. */ }
  }
}
async function atomicEntry(directory, entry, create, assertOwned) {
  const target = entryPath(directory, entry.id);
  const temporary = path.join(directory, `.${entry.id}.${randomUUID()}.tmp`);
  let handle, temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    const bytes = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(bytes) > MAX_ENTRY_BYTES) throw new Error("序列化清单文件过大");
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await assertOwned();
    if (create) {
      // Exclusive publication: never overwrite an existing ID, even outside our lock protocol.
      try { await link(temporary, target); } catch (error) {
        if (error.code === "EEXIST") throw new ReleaseConflictError("条目 ID 已存在，未覆盖");
        throw error;
      }
    } else {
      // Refuse a symlink swapped in while preparing the update.
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("更新目标不是普通文件");
      await rename(temporary, target);
    }
  } finally {
    if (handle) await handle.close();
    if (temporaryCreated) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
export async function registerRelease(value) {
  const entry = validateReleaseEntry(value);
  if (entry.status !== "pending" || entry.revision !== 1) throw new Error("登记只接受 revision=1 的已完成已验证待上线条目");
  const directory = releaseDirectory();
  await checkDirectory(directory, true);
  return withEntryLock(directory, entry.id, async (assertOwned) => {
    const files = await readdir(directory);
    if (files.filter((file) => file.endsWith(".json")).length >= MAX_ENTRIES) throw new Error("清单已达容量上限");
    await atomicEntry(directory, entry, true, assertOwned);
    return entry;
  });
}
export async function updateRelease(id, expectedRevision, replacement) {
  return mutateRelease(id, expectedRevision, (current) => {
    const next = validateReleaseEntry(replacement);
    if (current.status !== "pending" || next.status !== "pending" || next.id !== id || next.createdAt !== current.createdAt || next.revision !== current.revision + 1) throw new ReleaseConflictError("更新必须保留身份和创建时间，只能更新待上线条目并递增修订");
    return next;
  });
}
export async function markReleaseDeployed(id, expectedRevision) {
  return mutateRelease(id, expectedRevision, (current) => {
    if (current.status !== "pending") throw new ReleaseConflictError("该条目已上线，未更改历史");
    return validateReleaseEntry({ ...current, revision: current.revision + 1, status: "deployed", deployedAt: new Date().toISOString() });
  });
}
async function mutateRelease(id, expectedRevision, change) {
  const directory = releaseDirectory();
  const target = entryPath(directory, id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("必须提供 expectedRevision 正整数");
  if (!await checkDirectory(directory)) throw new Error("清单目录不存在");
  return withEntryLock(directory, id, async (assertOwned) => {
    const current = await readEntry(target);
    if (current.id !== id || current.revision !== expectedRevision) throw new ReleaseConflictError("条目修订冲突；重新读取后再提交，不可覆盖旧快照");
    const next = change(current);
    await atomicEntry(directory, next, false, assertOwned);
    return next;
  });
}
