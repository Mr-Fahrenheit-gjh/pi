#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { isNodeVersionSupported, getUnsupportedNodeVersionMessage } = require("./node-version");
const { parseCommandLine, getHelpText } = require("./pi-web-options");

const ROOT = path.resolve(__dirname, "..");
const STATE = ".pi-web-start.json";
const LOCK = ".pi-web-setup.lock";
const BUILD_INPUTS = ["app", "components", "hooks", "lib", "bin", "public", "scripts", "package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts", "instrumentation.ts", "instrumentation-node.ts", "proxy.ts", "local-customizations.json"];
const digest = value => createHash("sha256").update(value).digest("hex");

function sourceFingerprint(root) {
  const hash = createHash("sha256");
  function visit(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`源码包含链接，请改用独立检出目录：${relative}`);
    if (info.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(relative, entry));
    } else if (!/\.(?:test|spec)\.[^.]+$/.test(relative) && path.basename(file) !== ".DS_Store") {
      hash.update(relative).update("\0").update(fs.readFileSync(file)).update("\0");
    }
  }
  for (const input of BUILD_INPUTS) visit(input);
  return hash.digest("hex");
}

function readState(root) {
  try {
    const file = path.join(root, STATE);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Startup state cannot be a link");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state.version === 1 ? state : {};
  } catch { return {}; }
}
function writeState(root, state) {
  const file = path.join(root, STATE);
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...state, version: 1 }, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function hasBuild(root) {
  try { return Boolean(fs.readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim()); }
  catch { return false; }
}
function getPlan(root, forceBuild = false) {
  const state = readState(root);
  const installKey = digest(`${process.platform}:${process.arch}:${process.versions.modules}:` + fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const buildKey = sourceFingerprint(root);
  const install = !fs.existsSync(path.join(root, "node_modules")) || state.install !== installKey;
  return { install, build: install || forceBuild || state.build !== buildKey || !hasBuild(root), installKey, buildKey };
}

function resolveNpmCli(env = process.env, executable = process.execPath, directories = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
  const bin = path.dirname(executable);
  const candidates = [env.npm_execpath, path.join(bin, "node_modules/npm/bin/npm-cli.js"), path.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"), path.resolve(bin, "../share/nodejs/npm/bin/npm-cli.js")];
  for (const directory of directories) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* Not a POSIX npm link. */ }
  }
  for (const file of candidates) {
    if (file && path.basename(file) === "npm-cli.js" && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error("找不到 npm。请安装包含 npm 的 Node.js 22 LTS，重新打开终端后再试：https://nodejs.org/");
}
function runNpm(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveNpmCli(), ...args], { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} 未完成（${signal || code}），修复上方错误后重新启动即可。`)));
  });
}
function setupLock(root) {
  const file = path.join(root, LOCK);
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`另一个初始化尚未结束。若此前异常退出，请先确认安装/构建进程已停止，再删除 ${LOCK} 后重试。`);
    throw error;
  }
  try { fs.writeFileSync(fd, owner); } finally { fs.closeSync(fd); }
  const release = () => { try { if (fs.readFileSync(file, "utf8") === owner) fs.unlinkSync(file); } catch { /* Never remove a replacement owner's lock. */ } };
  process.once("exit", release);
  return () => { process.off("exit", release); release(); };
}

async function prepare(root = ROOT, { forceBuild = false, runNpm: execute = args => runNpm(root, args), log = console.log } = {}) {
  for (const directory of ["node_modules", ".next"]) {
    const file = path.join(root, directory);
    let info;
    try { info = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (info?.isSymbolicLink()) throw new Error(`${directory} 是链接目录；便捷启动不会改写其他安装，请使用独立检出目录。`);
  }
  let plan = getPlan(root, forceBuild);
  if (!plan.install && !plan.build) return;
  const release = setupLock(root);
  try {
    plan = getPlan(root, forceBuild);
    const state = readState(root);
    if (plan.install) {
      // npm ci can leave a partial directory on failure; old readiness must not survive.
      state.install = null;
      state.build = null;
      writeState(root, state);
      log("[Pi Web] 按锁文件准备本项目依赖（首次可能需要几分钟；不会全局安装）…");
      await execute(["ci"]);
      state.install = plan.installKey;
      state.build = null;
      writeState(root, state);
    }
    if (plan.build) {
      state.build = null;
      writeState(root, state);
      log("[Pi Web] 构建定制网页端…");
      await execute(["run", "build"]);
      if (!hasBuild(root)) throw new Error("构建未生成 .next/BUILD_ID，请检查构建输出后重试。");
      state.build = sourceFingerprint(root);
      writeState(root, state);
    }
  } finally { release(); }
}

async function main() {
  if (!isNodeVersionSupported(process.versions.node)) throw new Error(getUnsupportedNodeVersionMessage(process.versions.node));
  const args = process.argv.slice(2);
  const prepareOnly = args.includes("--prepare");
  const doctor = args.includes("--doctor");
  const forceBuild = args.includes("--rebuild");
  const forwarded = args.filter(arg => !["--prepare", "--doctor", "--rebuild"].includes(arg));
  const options = parseCommandLine(forwarded);
  if (options.help) {
    console.log("定制源码便捷启动：npm start / start.cmd / bash start.sh\n--prepare  只准备依赖与构建\n--rebuild  重新构建后启动\n--doctor   只读检查准备状态，不安装、不构建\n\n" + getHelpText().replace(/^  update.*\n/m, ""));
    return;
  }
  if (options.command === "update") throw new Error("定制版请使用 git pull --ff-only 后重新启动；此入口不会用官方 npm 包覆盖定制源码。");
  if (doctor) {
    const plan = getPlan(ROOT, forceBuild);
    console.log(`Node.js ${process.versions.node}\n项目依赖：${plan.install ? "需要准备" : "已就绪"}\n生产构建：${plan.build ? "需要构建" : "已就绪"}`);
    return;
  }
  if (options.command === "start") await prepare(ROOT, { forceBuild });
  if (prepareOnly) { console.log("[Pi Web] 准备完成。下次直接运行同一启动入口即可。"); return; }
  process.argv = [process.argv[0], path.join(__dirname, "pi-web.js"), ...forwarded];
  process.env.PI_WEB_SKIP_VERSION_CHECK ??= "1";
  // Reuse the existing CLI in this process, preserving its run record and shutdown handling.
  require("./pi-web.js");
}

module.exports = { prepare, getPlan, resolveNpmCli, sourceFingerprint };
if (require.main === module) main().catch(error => { console.error(`[Pi Web] ${error.message}`); process.exitCode = 1; });
