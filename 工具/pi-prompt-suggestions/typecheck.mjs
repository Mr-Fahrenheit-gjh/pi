import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const maintenance = join(root, "../pi-web维护/native-agent-switcher");
const host = process.env.PI_SUGGESTIONS_HOST_ROOT || JSON.parse(readFileSync(join(maintenance, "local-update.json"), "utf8")).candidateDirectory;
const temporary = mkdtempSync(join(tmpdir(), "pi-suggestions-types-"));
try {
  const paths = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui"].map(name => [
    `@earendil-works/${name}`, [join(host, "node_modules/@earendil-works", name, "dist/index.d.ts")],
  ]));
  const config = join(temporary, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true,
    skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"],
    typeRoots: [join(host, "node_modules/@types")], paths,
  }, include: [join(root, "src/index.ts")] }));
  const result = spawnSync(process.execPath, [join(host, "node_modules/typescript/bin/tsc"), "-p", config], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
