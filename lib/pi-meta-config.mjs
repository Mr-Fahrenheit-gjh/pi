import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MARKER = ".pi-meta.json";
const SCHEMA = 1;
const PACKAGE_NAMES = ["pi-web-access", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo"];

async function existingMeta(metaAgentDir, mainAgentDir) {
  const dir = await lstat(metaAgentDir);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && dir.uid !== process.getuid())) {
    throw new Error("Pi Meta directory is not a private, owned directory (symlinks are not allowed)");
  }
  const markerPath = join(metaAgentDir, MARKER);
  let marker;
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid marker");
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch { throw new Error("Unrecognized Pi Meta directory; refusing to overwrite it"); }
  if (marker?.schema !== SCHEMA || marker.mainAgentDir !== mainAgentDir) {
    throw new Error("Unrecognized Pi Meta directory or source agent; refusing to overwrite it");
  }
  const auth = await lstat(join(metaAgentDir, "auth.json"));
  if (!auth.isSymbolicLink()) throw new Error("Pi Meta auth is not the expected shared link");
  const { readlink } = await import("node:fs/promises");
  if (await readlink(join(metaAgentDir, "auth.json")) !== join(mainAgentDir, "auth.json")) {
    throw new Error("Pi Meta auth link does not point to the configured shared account");
  }
  return metaAgentDir;
}

/** Initialize a private profile once; later Meta changes never write the main settings or MCP file. */
export async function initializePiMeta({ mainAgentDir, metaAgentDir, packageDir }) {
  if (!isAbsolute(mainAgentDir) || !isAbsolute(metaAgentDir) || !isAbsolute(packageDir)) throw new Error("Pi Meta paths must be absolute");
  mainAgentDir = resolve(mainAgentDir);
  metaAgentDir = resolve(metaAgentDir);
  if (mainAgentDir === metaAgentDir || metaAgentDir.startsWith(`${mainAgentDir}/`)) {
    throw new Error("Pi Meta requires a separate agent directory");
  }
  try { return await existingMeta(metaAgentDir, mainAgentDir); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  const packages = PACKAGE_NAMES.map(name => join(mainAgentDir, "npm", "node_modules", name));
  const extensions = [join(mainAgentDir, "extensions", "codex-speed", "index.ts"), join(packageDir, "bin", "pi-meta-mcp-permissions.ts")];
  const skills = [join(mainAgentDir, "skills", "grilling")];
  for (const resource of [...packages, ...extensions, ...skills, join(mainAgentDir, "auth.json")]) await stat(resource);
  const sourceSettings = JSON.parse(await readFile(join(mainAgentDir, "settings.json"), "utf8"));
  const settings = { packages, extensions, skills };
  if (typeof sourceSettings.defaultProvider === "string" && typeof sourceSettings.defaultModel === "string") {
    settings.defaultProvider = sourceSettings.defaultProvider;
    settings.defaultModel = sourceSettings.defaultModel;
  }

  try { await mkdir(metaAgentDir, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") return existingMeta(metaAgentDir, mainAgentDir);
    throw error;
  }
  try {
    await writeFile(join(metaAgentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    for (const name of ["models.json"]) {
      try {
        await copyFile(join(mainAgentDir, name), join(metaAgentDir, name), constants.COPYFILE_EXCL);
        await chmod(join(metaAgentDir, name), 0o600);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    try {
      const sourceMcp = JSON.parse(await readFile(join(mainAgentDir, "mcp.json"), "utf8"));
      const tushare = sourceMcp.mcpServers?.tushareMcp;
      const mcp = { mcpServers: tushare ? { tushareMcp: tushare } : {} };
      await writeFile(join(metaAgentDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await symlink(join(mainAgentDir, "auth.json"), join(metaAgentDir, "auth.json"));
    await writeFile(join(metaAgentDir, MARKER), JSON.stringify({ schema: SCHEMA, mainAgentDir }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(metaAgentDir, { recursive: true, force: true });
    throw error;
  }
  return metaAgentDir;
}
