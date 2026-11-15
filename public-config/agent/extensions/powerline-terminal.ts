import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The npm package's direct extension entry is disabled in settings.json.
// Only interactive terminals load it; pi-web sets PI_WEB_HOSTNAME even
// when its server was launched from a terminal. Print/RPC also stay clean.
export default async function (pi: ExtensionAPI) {
  if (process.env.PI_WEB_HOSTNAME !== undefined) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const args = process.argv.slice(2);
  if (args.some((arg) => ["--print", "-p", "--mode", "--help", "-h", "--version", "-v"].includes(arg)
    || arg.startsWith("--mode="))) return;

  const { default: powerlineFooter } = await import("../npm/node_modules/pi-powerline-footer/index.ts");
  await powerlineFooter(pi);
}
