import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getPlan } = require("../bin/start-custom.js");
const { stopServer } = require("../bin/pi-web-commands.js");
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(getPlan(root).install, false, "Run node bin/start-custom.js --prepare first");
assert.equal(getPlan(root).build, false, "Prepared sources must not build again on ordinary startup");
const probe = createServer();
await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const agent = await mkdtemp(join(tmpdir(), "pi-public-start-"));
const url = `http://127.0.0.1:${port}`;
const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
const args = process.platform === "win32"
  ? ["/d", "/c", `start.cmd --port ${port} --no-open`]
  : ["start.sh", "--port", String(port), "--no-open"];
const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_SKIP_VERSION_CHECK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise(resolve => child.once("close", resolve));
let output = "";
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output.slice(-4000)}`)), 60_000);
    const finish = callback => { clearTimeout(timer); callback(); };
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("Ready")) finish(resolve);
    });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("error", error => finish(() => reject(error)));
    child.once("exit", code => finish(() => reject(new Error(`Startup exited (${code}): ${output.slice(-4000)}`))));
  });
  assert.doesNotMatch(output, /按锁文件准备|构建定制网页端/, "Ready installation must not reinstall or rebuild");
  const request = path => fetch(url + path, { signal: AbortSignal.timeout(15_000) });
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/api/home")).status, 200);
  assert.equal((await request("/api/sessions")).status, 200);
  for (const path of ["/pi-meta", "/feynman", "/api/runtime/meta/status", "/api/runtime/feynman/status"]) {
    assert.equal((await request(path)).status, 404, `${path} must not be present in the public application`);
  }
  console.log("Public startup OK: existing build reused, UI/session API ready, excluded runtime routes return 404; no model called.");
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    assert.equal(await stopServer({ pid: child.pid, url }, { timeoutMs: 10_000 }), 0, "Owned startup process tree must stop");
  }
  await exited;
  await rm(agent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
