import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

// ponytail: scan recent files without an index; add indexing if measured latency warrants it.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  for (const [index, session] of candidates.entries()) {
    if (index >= MAX_FILES || response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const stream = createReadStream(session.path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let found = false;
    try {
      for await (const line of lines) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        if (line.length > MAX_LINE_CHARS) {
          response.truncated = true;
          continue;
        }
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
        const content: unknown = entry.message.content;
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
        const text = textBlocks.map((block) => block.text).join("\n");
        const match = matcher.exec(text);
        if (!match) continue;
        const start = match.index;
        const end = start + match[0].length;
        let blockOffset = 0;
        const matchedBlock = textBlocks.find((block) => {
          const blockEnd = blockOffset + block.text.length;
          blockOffset = blockEnd + 1;
          return start <= blockEnd;
        });
        response.results.push({
          session,
          ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
          blockIndex: matchedBlock!.blockIndex,
          before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
          match: match[0].replace(/\s+/g, " "),
          after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
        });
        found = true;
        break;
      }
    } catch {
      // Missing/unreadable files and interrupted reads must not hide other results.
      response.truncated = true;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!found && stream.bytesRead >= MAX_FILE_BYTES) response.truncated = true;
  }
  return response;
}

export interface SessionSearchPageResponse extends SessionSearchResponse {
  nextCursor: string | null;
  /** Unreadable files/oversized lines, not simply another available page. */
  incomplete: boolean;
}

export class SessionSearchCursorError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "SessionSearchCursorError";
    this.status = status;
  }
}

type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number };
type SearchCursor = { v: 1; q: string; id: string; offset: number; skip: boolean; file?: FileIdentity };
const CHUNK_BYTES = 64 * 1024;

function decodeSearchCursor(value: string, queryHash: string): SearchCursor {
  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor.v !== 1 || cursor.q !== queryHash || typeof cursor.id !== "string" || cursor.id.length > 512
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.skip !== "boolean"
      || (cursor.offset > 0 && (!cursor.file || !["dev", "ino", "size", "mtimeMs"].every(key => Number.isFinite(cursor.file[key]) && cursor.file[key] >= 0)))) throw new Error();
    return cursor;
  } catch {
    throw new SessionSearchCursorError("Invalid conversation search cursor");
  }
}

function matchSearchEntry(line: Buffer, session: SessionInfo, matcher: RegExp): SessionSearchResult | undefined {
  let entry;
  try { entry = JSON.parse(line.toString("utf8")); } catch { return; }
  if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) return;
  const content: unknown = entry.message.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
  const text = textBlocks.map(block => block.text).join("\n");
  const match = matcher.exec(text);
  if (!match) return;
  const start = match.index, end = start + match[0].length;
  let offset = 0;
  const block = textBlocks.find(block => {
    const blockEnd = offset + block.text.length;
    offset = blockEnd + 1;
    return start <= blockEnd;
  });
  return { session, ...(typeof entry.id === "string" ? { entryId: entry.id } : {}), blockIndex: block!.blockIndex,
    before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
    match: match[0].replace(/\s+/g, " "),
    after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : "") };
}

/**
 * Bounded continuation over the entire catalog, independent of sidebar visibility.
 * IDs give a stable traversal even while modified timestamps/order change. A cursor
 * contains no path: only a catalog ID and a checked byte boundary in that file.
 * Each request keeps the existing file/result/time/byte budgets. The next request
 * resumes the remainder instead of silently dropping older conversations or tails.
 */
export async function searchSessionContentsPage(
  sessions: readonly SessionInfo[], query: string, requestSignal?: AbortSignal, cursorValue?: string,
): Promise<SessionSearchPageResponse> {
  const response: SessionSearchPageResponse = { results: [], truncated: false, nextCursor: null, incomplete: false };
  const needle = query.trim();
  requestSignal?.throwIfAborted();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  const queryHash = createHash("sha256").update(needle.toLocaleLowerCase()).digest("hex").slice(0, 24);
  const cursor = cursorValue ? decodeSearchCursor(cursorValue, queryHash) : undefined;
  const candidates = sessions.filter(session => !session.transient && session.path).sort((a, b) => b.id.localeCompare(a.id));
  let index = cursor ? candidates.findIndex(session => session.id === cursor.id) : 0;
  if (index < 0) throw new SessionSearchCursorError("Conversation catalog changed; search again", 409);
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = Date.now() + TIME_BUDGET_MS;
  let files = 0, bytes = 0;
  const limited = () => files >= MAX_FILES || bytes >= MAX_FILE_BYTES || response.results.length >= MAX_RESULTS || Date.now() >= deadline;
  const resume = (session: SessionInfo, offset = 0, skip = false, file?: FileIdentity) => {
    const next: SearchCursor = { v: 1, q: queryHash, id: session.id, offset, skip, ...(file ? { file } : {}) };
    response.nextCursor = Buffer.from(JSON.stringify(next)).toString("base64url");
    response.truncated = true;
    return response;
  };

  for (; index < candidates.length; index++) {
    requestSignal?.throwIfAborted();
    const session = candidates[index];
    if (files > 0 && limited()) return resume(session);
    files++;
    const continuing = cursor?.id === session.id && cursor.offset > 0;
    // Metadata matches need no file I/O and remain available for unreadable files.
    if (!continuing && matcher.test(`${session.name ?? ""}\n${session.firstMessage}`)) {
      response.results.push({ session, blockIndex: 0, before: "", match: "", after: "" });
      continue;
    }
    const handle = await open(session.path, "r").catch(error => {
      requestSignal?.throwIfAborted();
      response.incomplete = true;
      // Missing files do not prevent searching the rest of the trusted catalog.
      if (error?.code === "ENOENT" && continuing) throw new SessionSearchCursorError("Conversation changed; search again", 409);
      return undefined;
    });
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) { response.incomplete = true; continue; }
      const identity: FileIdentity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
      if (continuing && (!cursor.file || Object.entries(identity).some(([key, value]) => cursor.file![key as keyof FileIdentity] !== value)
        || cursor.offset > stat.size)) throw new SessionSearchCursorError("Conversation changed; search again", 409);
      let position = continuing ? cursor.offset : 0;
      let skip = continuing && cursor.skip;
      response.incomplete ||= skip;
      let parts: Buffer[] = [], lineBytes = 0;
      let matched = false;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (position < stat.size && !matched) {
        requestSignal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, stat.size - position), position);
        if (!bytesRead) { response.incomplete = true; break; }
        let start = 0;
        while (start < bytesRead) {
          requestSignal?.throwIfAborted();
          const newline = buffer.indexOf(10, start);
          const end = newline >= start && newline < bytesRead ? newline + 1 : bytesRead;
          const length = end - start;
          position += length; bytes += length; lineBytes += length;
          if (!skip && lineBytes > MAX_LINE_CHARS) { skip = true; parts = []; response.incomplete = true; }
          if (!skip) parts.push(Buffer.from(buffer.subarray(start, end)));
          start = end;
          if (newline >= 0 && newline < bytesRead) {
            const hit = skip ? undefined : matchSearchEntry(Buffer.concat(parts), session, matcher);
            parts = []; lineBytes = 0; skip = false;
            if (hit) { response.results.push(hit); matched = true; break; }
            // Stop only at a committed line boundary (never stream read-ahead).
            if (limited() && position < stat.size) return resume(session, position, false, identity);
          } else if (skip && limited() && position < stat.size) {
            // An oversized line can be discarded across pages with bounded memory.
            return resume(session, position, true, identity);
          }
        }
      }
      if (!matched && parts.length) {
        const hit = matchSearchEntry(Buffer.concat(parts), session, matcher);
        if (hit) response.results.push(hit);
      }
    } catch (error) {
      requestSignal?.throwIfAborted();
      if (error instanceof SessionSearchCursorError) throw error;
      response.incomplete = true;
    } finally {
      await handle.close();
    }
  }
  response.truncated = response.incomplete;
  return response;
}
