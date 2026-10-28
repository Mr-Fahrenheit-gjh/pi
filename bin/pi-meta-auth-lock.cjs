"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads CommonJS before any SDK module. */

// Meta shares the model auth file, but the main runtime and pi-legacy can name
// it through different symlinks. Meta must hold both existing lock paths for
// each transaction; neither other process needs a configuration change.
const fs = require("node:fs");
const path = require("node:path");
const { resolveOriginalPi } = require("./pi-meta-original.cjs");
const { createRequire, syncBuiltinESMExports } = require("node:module");

const alias = process.env.PI_META_AUTH_PATH;
const shared = process.env.PI_META_SHARED_AUTH_PATH;
if (process.env.PI_META_PROCESS === "1" || alias || shared) {
  if (!alias || !shared || !path.isAbsolute(alias) || !path.isAbsolute(shared)) {
    throw new Error("Pi Meta shared-auth lock configuration is missing or invalid");
  }
  const aliasPath = path.resolve(alias);
  const sharedPath = path.resolve(shared);
  const actualPath = fs.realpathSync(sharedPath);
  // Canonicalize the parent only: on macOS /var and /private/var may refer to
  // the same lock directory, while an auth.json symlink is a distinct lock key.
  const sharedLockPath = path.join(fs.realpathSync(path.dirname(sharedPath)), path.basename(sharedPath));
  function assertAuthPaths() {
    if (!fs.lstatSync(aliasPath).isSymbolicLink() ||
        path.resolve(path.dirname(aliasPath), fs.readlinkSync(aliasPath)) !== sharedPath ||
        path.join(fs.realpathSync(path.dirname(sharedPath)), path.basename(sharedPath)) !== sharedLockPath ||
        fs.realpathSync(sharedPath) !== actualPath || fs.realpathSync(aliasPath) !== actualPath) {
      throw new Error("Pi Meta shared-auth link does not match the configured account");
    }
  }
  assertAuthPaths();
  const webDirectory = process.env.PI_META_WEB_PACKAGE_DIR;
  if (!webDirectory || !path.isAbsolute(webDirectory)) throw new Error("Pi Meta Web package directory is missing");
  const { root: legacyRoot } = resolveOriginalPi(webDirectory);

  // Different files are required as lock keys: proper-lockfile tracks ownership
  // in a process-local map keyed by file path. Every Meta process uses this
  // order and immediately rolls back if the second lock cannot be acquired.
  const targets = [...new Set([actualPath, sharedLockPath])];
  const webRequire = createRequire(path.join(webDirectory, "node_modules/@earendil-works/pi-coding-agent/package.json"));
  const legacyRequire = createRequire(path.join(legacyRoot, "package.json"));
  const lockfiles = new Set([webRequire("proper-lockfile"), legacyRequire("proper-lockfile")]);
  const retry = createRequire(webRequire.resolve("proper-lockfile"))("retry");
  // Main Pi's async locks can legitimately wait 15s between heartbeats.
  const lockOptions = options => ({ ...options, realpath: false, retries: 0,
    stale: Math.max(options?.stale ?? 0, 30_000), update: 2000 });
  const isMetaAuth = file => typeof file === "string" && path.resolve(file) === aliasPath;
  const raw = {
    existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
    chmodSync: fs.chmodSync, openSync: fs.openSync, closeSync: fs.closeSync,
    fstatSync: fs.fstatSync, ftruncateSync: fs.ftruncateSync, fchmodSync: fs.fchmodSync,
  };
  let active;
  let unsafe = false;
  function openPinned(flags, requireLock) {
    if (requireLock && !active) throw new Error("Pi Meta auth writes require both shared locks");
    assertAuthPaths();
    const fd = raw.openSync(actualPath, flags | fs.constants.O_NOFOLLOW);
    try {
      const info = raw.fstatSync(fd, { bigint: true });
      if (!info.isFile() || (active && (info.dev !== active.dev || info.ino !== active.ino))) {
        throw new Error("Pi Meta shared-auth file changed during the transaction");
      }
      return fd;
    } catch (error) { raw.closeSync(fd); throw error; }
  }
  function activate() {
    if (unsafe || active) throw new Error("Pi Meta shared-auth lock ownership is uncertain");
    const fd = openPinned(fs.constants.O_RDONLY, false);
    try {
      const info = raw.fstatSync(fd, { bigint: true });
      assertAuthPaths();
      active = { dev: info.dev, ino: info.ino };
      return active;
    } finally { raw.closeSync(fd); }
  }
  // SDK and Web credential writes use these synchronous APIs. Open the already
  // locked target without following symlinks, and verify its inode before
  // truncating, so an in-flight link replacement cannot redirect a write.
  fs.existsSync = function (file) {
    if (!isMetaAuth(file)) return raw.existsSync(file);
    assertAuthPaths();
    return raw.existsSync(actualPath);
  };
  fs.readFileSync = function (file, ...args) {
    if (!isMetaAuth(file)) return raw.readFileSync(file, ...args);
    const fd = openPinned(fs.constants.O_RDONLY, false);
    try { const result = raw.readFileSync(fd, ...args); assertAuthPaths(); return result; }
    finally { raw.closeSync(fd); }
  };
  fs.writeFileSync = function (file, data, options) {
    if (!isMetaAuth(file)) return raw.writeFileSync(file, data, options);
    if (typeof options === "object" && options?.flag && options.flag !== "w") throw new Error("Unsupported Pi Meta auth write flag");
    const fd = openPinned(fs.constants.O_WRONLY, true);
    try { raw.ftruncateSync(fd, 0); return raw.writeFileSync(fd, data, options); }
    finally { raw.closeSync(fd); }
  };
  fs.chmodSync = function (file, mode) {
    if (!isMetaAuth(file)) return raw.chmodSync(file, mode);
    const fd = openPinned(fs.constants.O_RDONLY, true);
    try { return raw.fchmodSync(fd, mode); }
    finally { raw.closeSync(fd); }
  };
  syncBuiltinESMExports();
  const releaseFailure = errors => {
    if (!errors.length) return;
    unsafe = true;
    console.error("[pi-meta] Could not release all shared-auth locks");
    throw new AggregateError(errors, "Pi Meta shared-auth lock release failed");
  };

  for (const lockfile of lockfiles) {
    const originalLock = lockfile.lock.bind(lockfile);
    const originalLockSync = lockfile.lockSync.bind(lockfile);
    const originalUnlock = lockfile.unlock.bind(lockfile);
    const originalUnlockSync = lockfile.unlockSync.bind(lockfile);
    lockfile.lock = async (file, options) => {
      if (!isMetaAuth(file)) return originalLock(file, options);
      if (options?.realpath !== false) throw new Error("Pi Meta auth requires explicit non-canonical locks");
      const retries = options.retries ?? 0;
      const operation = retry.operation(typeof retries === "number" ? { retries } : retries);
      return new Promise((resolve, reject) => {
        operation.attempt(async () => {
          const releases = [];
          let released = false;
          let owner;
          let compromised;
          const configured = lockOptions(options);
          const onCompromised = configured.onCompromised;
          configured.onCompromised = error => {
            compromised ??= error;
            if (onCompromised) onCompromised(error);
            else throw error;
          };
          const releaseAll = async () => {
            if (released) throw new Error("Pi Meta shared-auth locks were already released");
            released = true;
            if (owner && active === owner) active = undefined;
            const errors = [];
            for (const release of releases.splice(0).reverse()) {
              try { await release(); } catch (error) { errors.push(error); }
            }
            releaseFailure(errors);
          };
          try {
            assertAuthPaths();
            for (const target of targets) {
              if (compromised) throw compromised;
              releases.push(await originalLock(target, configured));
            }
            if (compromised) throw compromised;
            assertAuthPaths();
            owner = activate();
            resolve(releaseAll);
          } catch (error) {
            try { await releaseAll(); }
            catch (releaseError) { reject(new AggregateError([error, releaseError], "Pi Meta auth lock acquisition and rollback failed")); return; }
            // Never wait while holding just one lock. SDK callers already retry
            // externally; Web credential edits supply their own retry options.
            if (!compromised && !unsafe && error?.code === "ELOCKED" && operation.retry(error)) return;
            reject(error);
          }
        });
      });
    };
    lockfile.lockSync = (file, options) => {
      if (!isMetaAuth(file)) return originalLockSync(file, options);
      if (options?.realpath !== false) throw new Error("Pi Meta auth requires explicit non-canonical locks");
      assertAuthPaths();
      const releases = [];
      let released = false;
      let owner;
      const releaseAll = () => {
        if (released) throw new Error("Pi Meta shared-auth locks were already released");
        released = true;
        if (owner && active === owner) active = undefined;
        const errors = [];
        for (const release of releases.splice(0).reverse()) {
          try { release(); } catch (error) { errors.push(error); }
        }
        releaseFailure(errors);
      };
      try {
        for (const target of targets) releases.push(originalLockSync(target, lockOptions(options)));
        assertAuthPaths();
        owner = activate();
        return releaseAll;
      } catch (error) {
        try { releaseAll(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Pi Meta auth lock acquisition and rollback failed"); }
        throw error;
      }
    };
    lockfile.unlock = (file, options) => {
      if (isMetaAuth(file)) throw new Error("Pi Meta auth locks must be released by their owner");
      return originalUnlock(file, options);
    };
    lockfile.unlockSync = (file, options) => {
      if (isMetaAuth(file)) throw new Error("Pi Meta auth locks must be released by their owner");
      return originalUnlockSync(file, options);
    };
  }
}
