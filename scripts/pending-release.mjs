#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_ENTRY_BYTES } from "../lib/pending-release-shared.mjs";
import { readReleaseSnapshot, registerRelease, updateRelease, markReleaseDeployed, ReleaseConflictError } from "../lib/pending-release-store.mjs";

const help = `Pi 待上线清单（只登记，不执行上线）
  node scripts/pending-release.mjs list
  node scripts/pending-release.mjs register --file ENTRY.json --completed-and-verified
  node scripts/pending-release.mjs update --id UUID --expected-revision N --file ENTRY.json --completed-and-verified
  node scripts/pending-release.mjs mark-deployed --id UUID --expected-revision N --confirm-deployed

目录：PI_PENDING_RELEASE_DIR（仅进程环境覆盖，必须绝对路径且无符号链接）
register 的完整条目须含 schemaVersion:1、调用方保留的 UUID、revision:1、status:pending。
update 须提供完整条目、revision:N+1；修订冲突退出码3，其他错误退出码1。
标记上线仅记录人工已完成的上线；不发送消息、不运行上线步骤、不重启服务。
禁止直接改写 JSON 文件。登记前移除凭据及真实记忆正文。`;

async function inputFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) throw new Error("输入必须是最多 64KiB 的普通 JSON 文件");
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_ENTRY_BYTES) throw new Error("输入文件过大");
    try { return JSON.parse(buffer.subarray(0, size).toString("utf8")); } catch { throw new Error("输入 JSON 无效（未展示源内容）"); }
  } finally { await handle.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) { console.log(help); return; }
  const allowed = {
    list: [], register: ["file", "completed-and-verified"],
    update: ["id", "expected-revision", "file", "completed-and-verified"],
    "mark-deployed": ["id", "expected-revision", "confirm-deployed"],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error("未知操作，使用 --help 查看协议");
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index].slice(2);
    if (!args[index].startsWith("--") || !allowed[command].includes(key) || Object.hasOwn(flags, key)) throw new Error("无效或重复参数");
    if (key === "completed-and-verified" || key === "confirm-deployed") { flags[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`缺少参数值：${key}`);
    flags[key] = value;
  }
  for (const key of allowed[command]) if (!flags[key]) throw new Error(`必须提供 --${key}`);
  const expected = Number(flags["expected-revision"]);
  if (flags["expected-revision"] && (!/^[1-9]\d*$/.test(flags["expected-revision"]) || !Number.isSafeInteger(expected))) throw new Error("expected-revision 必须是正整数");
  let result;
  if (command === "list") result = await readReleaseSnapshot();
  if (command === "register") result = await registerRelease(await inputFile(flags.file));
  if (command === "update") result = await updateRelease(flags.id, expected, await inputFile(flags.file));
  if (command === "mark-deployed") result = await markReleaseDeployed(flags.id, expected);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error instanceof ReleaseConflictError ? `冲突：${error.message}` : `失败：${error.code ?? error.message}`);
  process.exitCode = error instanceof ReleaseConflictError ? 3 : 1;
});
