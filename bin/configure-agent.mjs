#!/usr/bin/env node
import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const portable = path => path.replaceAll("\\", "/");

export function renderTemplate(text, { repoRoot, agentDir }) {
  return text.replaceAll("{{REPO_ROOT}}", portable(repoRoot)).replaceAll("{{AGENT_DIR}}", portable(agentDir));
}

function renderJson(value, context) {
  if (typeof value === "string") return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map(entry => renderJson(entry, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderJson(entry, context)]));
  return value;
}

function stat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function files(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`配置源不是普通目录：${directory}`);
  const result = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`配置源不允许符号链接：${path}`);
    if (info.isDirectory()) result.push(...files(path));
    else if (info.isFile()) result.push(path);
    else throw new Error(`配置源不是普通文件：${path}`);
  }
  return result;
}

function checkScope(root, path) {
  const name = relative(root, path);
  if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error("配置路径超出目标目录");
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

function inDirectory(directory, create, action) {
  // A kernel-bound cwd is a portable directory anchor (Node has no openat).
  // All operations are synchronous; never yield while changing process cwd.
  // Check each directory AFTER chdir, then use only a single relative leaf.
  // Renaming/replacing an ancestor cannot redirect the subsequent open.
  const previous = process.cwd();
  const anchor = parse(directory).root;
  try {
    process.chdir(anchor);
    for (const part of relative(anchor, directory).split(sep).filter(Boolean)) {
      let info;
      try { info = lstatSync(part, { bigint: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!info && !create) return undefined;
      if (!info) {
        mkdirSync(part, { mode: 0o700 });
        info = lstatSync(part, { bigint: true });
      }
      if (info.isSymbolicLink()) throw new Error(`拒绝通过符号链接导入：${directory}`);
      if (!info.isDirectory()) throw new Error(`目标父路径不是目录：${directory}`);
      process.chdir(part);
      if (!sameIdentity(info, statSync(".", { bigint: true }))) throw new Error(`目标目录已变化：${directory}`);
    }
    return action();
  } finally { process.chdir(previous); }
}

function targetBytes(path) {
  return inDirectory(dirname(path), false, () => {
    let info;
    try { info = lstatSync(basename(path), { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (info.isSymbolicLink()) throw new Error(`拒绝通过符号链接导入：${path}`);
    if (!info.isFile()) throw new Error(`目标不是普通文件：${path}`);
    const descriptor = openSync(basename(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameIdentity(info, fstatSync(descriptor, { bigint: true }))) throw new Error(`目标文件已变化：${path}`);
      return readFileSync(descriptor);
    } finally { closeSync(descriptor); }
  });
}

function canonicalTarget(path) {
  const absolute = resolve(path);
  const info = stat(absolute);
  if (info?.isSymbolicLink()) throw new Error(`目标目录不能是符号链接：${absolute}`);
  if (info && !info.isDirectory()) throw new Error(`目标不是目录：${absolute}`);
  // Resolve existing ancestors (including the operating system's /tmp alias).
  if (info) return realpathSync(absolute);
  return join(canonicalTarget(dirname(absolute)), relative(dirname(absolute), absolute));
}

export function planConfiguration({ repoRoot = repository, target, workspace, withExtensions = false }) {
  if (!target) throw new Error("必须显式指定 --target <agent目录>；不会默认改写 ~/.pi/agent");
  repoRoot = realpathSync(resolve(repoRoot));
  const agentDir = canonicalTarget(target);
  const source = join(repoRoot, "public-config");
  for (const directory of [source, join(source, "agent"), ...(workspace ? [join(source, "workspace")] : [])]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`配置源不是普通目录：${directory}`);
  }
  const context = { repoRoot, agentDir };
  const plan = [];
  function add(from, root, name, json = false) {
    const info = lstatSync(from);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`配置源不是普通文件：${from}`);
    const raw = readFileSync(from);
    const binary = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip)$/i.test(from);
    let bytes = raw;
    if (!binary) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const rendered = json ? JSON.stringify(renderJson(JSON.parse(text), context), null, 2) + "\n" : renderTemplate(text, context);
      if (/\{\{(?:REPO_ROOT|AGENT_DIR)\}\}/.test(rendered)) throw new Error(`模板路径未展开：${from}`);
      bytes = Buffer.from(rendered);
    }
    const path = join(root, name);
    checkScope(root, path);
    const previous = targetBytes(path);
    const status = previous === undefined ? "create" : previous.equals(bytes) ? "unchanged" : "conflict";
    plan.push({ path, root, bytes, mode: (info.mode & 0o111) | 0o600, status });
  }
  add(join(source, "agent/APPEND_SYSTEM.md"), agentDir, "APPEND_SYSTEM.md");
  for (const directory of ["rules", "agents", "skills", ...(withExtensions ? ["extensions"] : [])]) {
    const from = join(source, "agent", directory);
    for (const file of files(from)) add(file, agentDir, join(directory, relative(from, file)), file.endsWith(".json"));
  }
  if (withExtensions) add(join(source, "agent/settings.template.json"), agentDir, "settings.json", true);
  if (workspace) add(join(source, "workspace/AGENTS.md"), canonicalTarget(workspace), "AGENTS.md");
  return plan;
}

export function applyConfiguration(plan) {
  const conflicts = plan.filter(file => file.status === "conflict");
  if (conflicts.length) throw new Error(`未修改任何配置；以下文件与现有内容不同，请选择新目录或手工合并：\n${conflicts.map(file => file.path).join("\n")}`);
  // Recheck the complete plan before the first write. Never overwrite a file,
  // including one created by another process after the dry run.
  for (const file of plan) {
    checkScope(file.root, file.path);
    const previous = targetBytes(file.path);
    if (file.status === "unchanged" && !previous?.equals(file.bytes)) throw new Error(`目标已变化：${file.path}`);
    if (file.status === "create" && previous !== undefined) throw new Error(`目标已变化：${file.path}`);
  }
  for (const file of plan.filter(file => file.status === "create")) {
    inDirectory(dirname(file.path), true, () => {
      const descriptor = openSync(basename(file.path), "wx", file.mode);
      try { writeFileSync(descriptor, file.bytes); } finally { closeSync(descriptor); }
    });
  }
}

function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (["--target", "--workspace"].includes(value)) {
      const next = args[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} 需要目录参数`);
      options[value === "--target" ? "target" : "workspace"] = next;
    } else if (value === "--with-extensions") options.withExtensions = true;
    else if (value === "--apply") options.apply = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  const options = argumentsFor(args);
  if (options.help) {
    console.log("公开配置导入（默认只预览，不安装、不联网、不启动服务）\n\nnode bin/configure-agent.mjs --target <agent目录> [--workspace <项目目录>] [--with-extensions] [--apply]\n\n--apply             明确执行；已有不同内容时拒绝覆盖\n--with-extensions   同时导入插件声明与本地扩展；下次启动SDK可能联网安装声明的npm包\n--workspace         将工作区规则导入该项目；不替换本仓库开发AGENTS.md\n\n不复制账号、模型授权、个人记忆、聊天或缓存。现有实例需 /reload 或新建会话。外部服务仍需自行配置。");
    return;
  }
  const plan = planConfiguration(options);
  if (options.apply) applyConfiguration(plan);
  console.log(JSON.stringify({ applied: Boolean(options.apply), withExtensions: Boolean(options.withExtensions), counts: Object.fromEntries(["create", "unchanged", "conflict"].map(status => [status, plan.filter(file => file.status === status).length])), files: plan.map(({ path, status }) => ({ path, status })) }, null, 2));
  if (plan.some(file => file.status === "conflict")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[Pi 配置] ${error.message}`); process.exitCode = 1; }
}
