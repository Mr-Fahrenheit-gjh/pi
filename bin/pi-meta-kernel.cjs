"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads this CommonJS file before the SDK. */

// These fingerprints are from the cached, unmodified npm 1.5.0 tarballs. A
// version update must be reviewed rather than silently mixing incompatible SDKs.
if (process.env.PI_META_PROCESS === "1") {
  const fs = require("node:fs");
  const path = require("node:path");
  const { resolveOriginalPi } = require("./pi-meta-original.cjs");
  const { createHash } = require("node:crypto");
  const { registerHooks } = require("node:module");
  const { fileURLToPath, pathToFileURL } = require("node:url");

  const fingerprints = {
      "pi-coding-agent": "0463ddef82f5c00526efd1cc8286732f0d6f6e5f83cf05663d860bedc2b236f0",
      "pi-agent-core": "1e1cbe1f1e10af214dba286c498ff09b61b0b5371752f85af1e2eaf6674f35c5",
      "pi-ai": "a555b4349ac1b2e75a7b6dd5a767914878e934a89d10fe25b32134af35e460f1",
      "pi-codemode": "aab382520c774070bdbb348ed1368a07d398527e20e1a4ffe0fcb38806d6be5b",
      "pi-mcp": "87e4e5f4634c0277fa002cdc3bd10ef1d88580124a1eb708e993e3c66ec15371",
      "pi-telemetry": "00474a3ef53873987d57e1aa8a02f06a951985276ff3e076a3b0b69683721953",
      "pi-tui": "9e263463fcf983fcb1e97c4c634dabbda41267dececcf6b21e98405cea2a7252",
      "pi-schema": "4da7a29940ac73ce52e365213db07796416c3d1656344c179c6b7b874bf56f74"
  };
  const webSdkFingerprint = "ee70da3bcc7096537baa01877a0580e1c6704ccd1e1bac8fa00c8f8c3b062e33";
  const skipWebSdkFile = name => name.startsWith("dist/bundle/") ||
    name.startsWith("dist/pi-interrupt-backup/") ||
    name === "dist/core/agent-session.js" || name === "dist/pi-interrupt-engine.mjs";

  function fingerprint(root, skip = () => false) {
    const files = ["package.json"];
    function visit(relative) {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile() && !name.endsWith(".map") && !skip(name)) files.push(name);
        else if (!entry.isFile()) throw new Error(`unexpected SDK entry: ${name}`);
      }
    }
    visit("dist");
    const digest = createHash("sha256");
    for (const name of files.sort()) {
      digest.update(name).update("\0").update(createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest());
    }
    return digest.digest("hex");
  }

  try {
    if (typeof registerHooks !== "function") throw new Error("Node synchronous module hooks are unavailable");
    const webDirectory = process.env.PI_META_WEB_PACKAGE_DIR;
    if (!webDirectory || !path.isAbsolute(webDirectory)) throw new Error("Web package directory is missing");
    const { root: legacyRoot, installed } = resolveOriginalPi(webDirectory);
    const webPackages = path.join(webDirectory, "node_modules/@earendil-works");
    const legacyPackages = path.join(legacyRoot, "node_modules/@earendil-works");
    for (const [name, expected] of Object.entries(fingerprints)) {
      const nested = path.join(legacyPackages, name);
      // The installed original is copied from Web's pristine npm package; if a
      // Pi dependency is not nested, Node resolves it from Web's node_modules.
      const original = name === "pi-coding-agent" ? legacyRoot :
        installed && !fs.existsSync(nested) ? path.join(webPackages, name) : nested;
      const web = path.join(webPackages, name);
      if (fingerprint(original) !== expected ||
          fingerprint(web, name === "pi-coding-agent" ? skipWebSdkFile : undefined) !==
            (name === "pi-coding-agent" ? webSdkFingerprint : expected)) {
        throw new Error(`${name} integrity mismatch`);
      }
    }
    const webRoot = fs.realpathSync(path.join(webPackages, "pi-coding-agent"));
    const originalSession = path.join(legacyRoot, "dist/core/agent-session.js");
    const webSession = pathToFileURL(fs.realpathSync(path.join(webRoot, "dist/core/agent-session.js"))).href;
    const webBundle = path.join(webRoot, "dist/bundle") + path.sep;
    const legacyBundle = path.join(legacyRoot, "dist/bundle") + path.sep;
    const packageNames = new Map();
    function piPackageRoot(file, marker) {
      const index = file.indexOf(marker);
      if (index < 0) return undefined;
      const root = file.slice(0, index);
      if (!packageNames.has(root)) {
        let name;
        try { name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name; } catch { /* Not a Pi package. */ }
        packageNames.set(root, name);
      }
      return packageNames.get(root) === "@earendil-works/pi-coding-agent" ? root : undefined;
    }
    // The source and all of its imports were checked above. Preserve the Web
    // module URL, so every Web SDK importer keeps the same class identity.
    const source = fs.readFileSync(originalSession, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== "1941d9608c98a3638825a8d10b5443ff7c06f96b3ae370bb37269f3a574ede65") {
      throw new Error("original AgentSession integrity mismatch");
    }
    // Unbundled Pi is byte-for-byte original and lets the auth preload wrap its
    // proper-lockfile dependency. The bundled CLI embeds that dependency and
    // cannot participate in the shared-account lock protocol.
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = legacyRoot;
    process.env.PI_SUBAGENT_PI_BINARY = path.join(legacyRoot, "dist/cli.js");
    registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith("file:")) {
          const parsed = new URL(url);
          parsed.search = "";
          parsed.hash = "";
          if (parsed.href === webSession) {
            globalThis[Symbol.for("pi-web:meta-original-agent-session/v1")] = true;
            return { format: "module", source, shortCircuit: true };
          }
          const file = fileURLToPath(parsed);
          if (file.startsWith(webBundle) || file.startsWith(legacyBundle) ||
              piPackageRoot(file, `${path.sep}dist${path.sep}bundle${path.sep}`)) {
            throw new Error("Pi Meta refuses Pi bundles that bypass its shared-auth lock protocol");
          }
          if (/[\\/](?:agent-session|auth-storage)\.js$/.test(file)) {
            const root = piPackageRoot(file, `${path.sep}dist${path.sep}core${path.sep}`);
            if (root && root !== webRoot && root !== legacyRoot) throw new Error("Pi Meta refuses an unverified Pi SDK copy");
          }
        }
        return nextLoad(url, context);
      },
    });
  } catch (error) {
    throw new Error(`Pi Meta original kernel verification failed: ${error.message}`, { cause: error });
  }
}
