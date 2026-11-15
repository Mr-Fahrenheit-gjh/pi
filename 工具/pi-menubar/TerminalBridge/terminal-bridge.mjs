import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FRAME = 1024 * 1024;
const MAX_PROMPT = 128 * 1024;
const MAX_PENDING = 32;
const text = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function bridgeDirectory() {
  return process.env.PI_MENUBAR_BRIDGE_DIR || `/tmp/pi-menubar-${process.getuid()}`;
}

function ensurePrivateDirectory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("unsafe terminal bridge directory");
  }
}

function copyQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined;
  const questions = [];
  for (const question of value) {
    if (!record(question) || typeof question.question !== "string" || typeof question.header !== "string" ||
        typeof question.multiSelect !== "boolean" || !Array.isArray(question.options) ||
        question.options.length < 2 || question.options.length > 4) return undefined;
    const options = [];
    for (const option of question.options) {
      if (!record(option) || typeof option.label !== "string" || typeof option.description !== "string" ||
          typeof option.hasPreview !== "boolean") return undefined;
      options.push({ label: option.label, description: option.description, hasPreview: option.hasPreview });
    }
    questions.push({ question: question.question, header: question.header, multiSelect: question.multiSelect, options });
  }
  return Buffer.byteLength(JSON.stringify(questions)) <= MAX_PROMPT ? questions : undefined;
}

/** Start only inside an interactive terminal session. All question data remains in memory. */
export async function startTerminalBridge(pi, ctx, directory = bridgeDirectory()) {
  ensurePrivateDirectory(directory);
  const instanceId = randomUUID();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!text(sessionId)) throw new Error("invalid session id");
  const socketPath = path.join(directory, `t-${instanceId}.sock`);
  // sockaddr_un.sun_path is shorter on macOS than on Linux.
  if (Buffer.byteLength(socketPath) >= 104) throw new Error("terminal bridge path too long");
  const pending = new Map();
  const prompts = new Map();
  const attempts = new Map();
  const sockets = new Set();
  let closing = false;
  const server = net.createServer();

  function snapshot() {
    const name = ctx.sessionManager.getSessionName?.();
    return {
      type: "snapshot", version: 1, instanceId, sessionId,
      title: typeof name === "string" && name.trim() ? Array.from(name).slice(0, 500).join("") : "终端对话",
      project: Array.from(path.basename(ctx.cwd || "") || "终端").slice(0, 500).join(""),
      prompts: [...pending.entries()].map(([toolCallId, item]) => ({
        toolCallId, ...(item.questions ? { questions: item.questions } : { unavailable: true }),
        canRespond: !item.locked && !!item.questions && !item.questions.some((q) => q.options.some((o) => o.hasPreview)),
      })),
    };
  }
  function send(socket, value) {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`);
  }
  function publish() {
    const value = snapshot();
    for (const socket of sockets) send(socket, value);
  }
  function answer(socket, message) {
    if (!record(message) || message.type !== "answer" || message.instanceId !== instanceId ||
        message.sessionId !== sessionId || !text(message.toolCallId, 512) || !text(message.requestId, 200)) return;
    const item = pending.get(message.toolCallId);
    if (!item || item.locked || !item.questions || item.questions.some((q) => q.options.some((o) => o.hasPreview)) ||
        attempts.has(message.requestId)) {
      send(socket, { type: "verdict", requestId: message.requestId, toolCallId: message.toolCallId, ok: false, code: "not_available" });
      return;
    }
    // The menu sends only after an explicit user action; same-UID processes are trusted.
    item.locked = true;
    attempts.set(message.requestId, { socket, toolCallId: message.toolCallId });
    publish();
    pi.events.emit("rpiv:ask-user:answer", {
      toolCallId: message.toolCallId, requestId: message.requestId,
      ...(message.cancel === true ? { cancel: true } : { answers: message.answers }),
    });
    // The installed event bus and answer channel emit the verdict synchronously. If a
    // different host does not, keep the item locked rather than risk a duplicate answer.
    if (attempts.has(message.requestId)) {
      send(socket, { type: "verdict", requestId: message.requestId, toolCallId: message.toolCallId, ok: false, code: "uncertain" });
    }
  }

  server.on("connection", (socket) => {
    if (closing || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        try { answer(socket, JSON.parse(line.toString("utf8"))); } catch { socket.destroy(); return; }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    send(socket, snapshot());
  });
  server.on("error", () => {});
  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once("error", fail);
    server.listen(socketPath, () => {
      server.off("error", fail);
      try { fs.chmodSync(socketPath, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });

  return {
    socketPath, instanceId,
    prompt(event) {
      if (!record(event) || !text(event.toolCallId, 512)) return;
      // Keep only bounded, explicitly supported data; previews themselves are not exposed by the API.
      if (prompts.size >= MAX_PENDING && !prompts.has(event.toolCallId)) return;
      prompts.set(event.toolCallId, copyQuestions(event.questions));
      if (pending.has(event.toolCallId)) {
        pending.get(event.toolCallId).questions = prompts.get(event.toolCallId);
        publish();
      }
    },
    blocked(event) {
      if (!record(event) || !text(event.toolCallId, 512) || typeof event.active !== "boolean") return;
      if (event.active) {
        if (pending.size >= MAX_PENDING && !pending.has(event.toolCallId)) return;
        if (!pending.has(event.toolCallId)) pending.set(event.toolCallId, { questions: prompts.get(event.toolCallId), locked: false });
      } else {
        pending.delete(event.toolCallId);
        prompts.delete(event.toolCallId);
      }
      publish();
    },
    verdict(event) {
      if (!record(event) || !text(event.requestId, 200) || typeof event.ok !== "boolean") return;
      const attempt = attempts.get(event.requestId);
      if (!attempt || event.toolCallId !== attempt.toolCallId) return;
      attempts.delete(event.requestId);
      const item = pending.get(attempt.toolCallId);
      if (event.ok || event.code === "not_found") {
        pending.delete(attempt.toolCallId);
        prompts.delete(attempt.toolCallId);
      } else if (item && ["invalid_payload", "invalid_answer", "unsupported_host"].includes(event.code)) {
        item.locked = false; // A definite rejection did not apply an answer.
      }
      send(attempt.socket, { type: "verdict", requestId: event.requestId, toolCallId: attempt.toolCallId,
        ok: event.ok, ...(typeof event.code === "string" ? { code: event.code } : {}) });
      publish();
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.end(`${JSON.stringify({ type: "session-closed", version: 1, instanceId, sessionId })}\n`);
      const closed = new Promise((resolve) => server.close(resolve));
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 200);
      timer.unref?.();
      await closed;
      clearTimeout(timer);
      pending.clear(); prompts.clear(); attempts.clear();
    },
  };
}
