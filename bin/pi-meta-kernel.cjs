"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads this CommonJS file before the SDK. */

// These fingerprints are from the cached, unmodified npm 1.4.0 tarballs. A
// version update must be reviewed rather than silently mixing incompatible SDKs.
if (process.env.PI_META_PROCESS === "1") {
  const fs = require("node:fs");
  const path = require("node:path");
  const { resolveOriginalPi } = require("./pi-meta-original.cjs");
  const { createHash } = require("node:crypto");
  const { registerHooks } = require("node:module");
  const { fileURLToPath, pathToFileURL } = require("node:url");

  const fingerprints = {
    "pi-coding-agent": "8b2ae2b3da46f7a6e026e6753b4c9b48ac3c724b6e1444ae942ff7f5272aff6a",
    "pi-agent-core": "5e27b82a809bc1b2d20a0eac8e6fb383d5c02d0eb828ed06c462272966d4a203",
    "pi-ai": "501444d13628fe2a4f6b47fdce8323a575177ca77b892159744cfc032b3e88ce",
    "pi-codemode": "8fadac715929a074c017295b2ee44472e9c4e27b594f9d1860bfe8e6264652ea",
    "pi-mcp": "672999c3304f2546ded358b741f9ed687cdeffa6db7b16a23f3b0e67924c6cf7",
    "pi-telemetry": "7313b8ff7f7e50b362dbcdd6b506f5f13b40a5d1d5a862680377d677e5fc0be4",
    "pi-tui": "ef2b4bcab99bda8d528c9975b0c9033bddfc439ef5420cac6803825aac96b3d5",
  };
  const webSdkFingerprint = "02256fb904a895ee3546ba3d9cac28632ea07bfc26231a78a02bc1a55060ca1c";
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
    if (createHash("sha256").update(source).digest("hex") !== "436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162") {
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
