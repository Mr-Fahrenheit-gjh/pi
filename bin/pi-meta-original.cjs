"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Shared by Node preloads. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function checkPackage(root) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "@earendil-works/pi-coding-agent" ||
      !fs.statSync(path.join(root, "dist/cli.js")).isFile() ||
      !fs.statSync(path.join(root, "dist/bundle/cli.js")).isFile()) {
    throw new Error("Pi Meta original Pi package is invalid");
  }
  for (const name of ["dist/cli.js", "dist/bundle/cli.js"]) {
    fs.accessSync(path.join(root, name), fs.constants.X_OK);
  }
}

// The Linux installer preserves the original Web SDK before applying its
// overlays. Existing installations can instead use their original pi-legacy.
function resolveOriginalPi(webDirectory, homeDirectory = os.homedir()) {
  if (!path.isAbsolute(webDirectory)) throw new Error("Pi Meta Web directory must be absolute");
  const installed = path.join(webDirectory, "node_modules/.pi-meta-original");
  let info;
  try { info = fs.lstatSync(installed); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pi Meta original package cannot be a symlink");
    const root = fs.realpathSync(installed);
    checkPackage(root);
    return { root, installed: true };
  }
  const cli = fs.realpathSync(path.join(homeDirectory, ".pi/agent/bin/pi-legacy"));
  const root = path.dirname(path.dirname(path.dirname(cli)));
  if (cli !== path.join(root, "dist/bundle/cli.js")) throw new Error("Pi Meta original Pi CLI is invalid");
  checkPackage(root);
  return { root, installed: false };
}

module.exports = { resolveOriginalPi };
