import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePiMeta, piMetaControl, piMetaRestartBlockingIds, piMetaStartingOrUnresolved, shutdownPiMeta } from "./pi-meta-process.mjs";

const LEASE = "11111111-1111-4111-8111-111111111111";
const FAKE_WORKER = `
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path'), {spawn,execFileSync}=require('node:child_process');
(async () => {
  const agentDir=process.env.PI_CODING_AGENT_DIR, socketDir=process.env.PI_META_SOCKET_DIR, token=process.env.PI_META_CONTROL_TOKEN;
  const lock=path.join(agentDir,'.pi-meta-worker'), socket=path.join(socketDir,'worker.sock');
  await fs.mkdir(lock,{mode:0o700});
  const groupId=Number(execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());
  if(groupId!==process.pid) throw Error('wrong process group');
  const st=await fs.stat(process.cwd(),{bigint:true});
  let build='dev'; try { build=(await fs.readFile(path.join(process.cwd(),'.next/BUILD_ID'),'utf8')).trim(); } catch {}
  const packageIdentity=String(st.dev)+':'+String(st.ino)+':'+build;
  await fs.writeFile(path.join(lock,'owner.json'), JSON.stringify({version:2,pid:process.pid,groupId,token,agentDir,packageDir:process.cwd(),packageIdentity,socketDir}), {mode:0o600});
  let pending=false, currentLease, busy=false;
  const server=http.createServer(async (req,res)=>{
    if(req.headers['x-pi-meta-control']!==token) {res.writeHead(404).end();return;}
    let input=''; for await(const chunk of req) input+=chunk;
    const {action,leaseId}=JSON.parse(input); let out;
    if(action==='identity') out={ok:true,pid:process.pid,agentDir};
    else if(action==='drain' && busy) out={ok:false,reason:'busy',sessions:1,terminals:0};
    else if(action==='drain') {pending=true;currentLease=leaseId;out={ok:true,pending,owned:true,sessions:0,terminals:0};}
    else if(action==='resume' && leaseId===currentLease) {pending=false;out={ok:true};}
    else if(action==='status') out={ok:true,pending,owned:leaseId===currentLease,sessions:busy?1:0,terminals:0};
    else if(action==='set-busy') {busy=true;out={ok:true};}
    else if(action==='clear-busy') {busy=false;out={ok:true};}
    else if(action==='hold-child') {const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});out={ok:true,childPid:child.pid};}
    else if(action==='shutdown' && pending && leaseId===currentLease) { await fs.rm(socketDir,{recursive:true,force:true}); out={ok:true}; }
    else out={ok:false};
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(out),()=>{ if(action==='shutdown') server.close(()=>process.exit(0)); });
  });
  await new Promise((resolve,reject)=>server.listen(socket,resolve).once('error',reject));
  await fs.chmod(socket,0o600);
  process.on('disconnect',()=>console.error('synthetic detached worker log'));
  process.send({type:'ready',pid:process.pid});
})().catch(()=>process.exit(1));
`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-meta-launch-")));
  const main = join(root, "agent"), pkg = join(root, "web");
  for (const name of ["pi-web-access", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo", "pi-subagents"]) {
    await mkdir(join(main, "npm/node_modules", name), { recursive: true });
  }
  await mkdir(join(main, "extensions/codex-speed"), { recursive: true });
  await mkdir(join(main, "skills/grilling"), { recursive: true });
  await mkdir(join(pkg, "bin"), { recursive: true });
  for (const file of ["extensions/codex-speed/index.ts", "skills/grilling/SKILL.md"]) await writeFile(join(main, file), "fixture");
  await writeFile(join(pkg, "bin/pi-meta-mcp-permissions.ts"), "fixture");
  await writeFile(join(main, "settings.json"), "{}");
  await writeFile(join(main, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(pkg, "bin/pi-meta-worker.cjs"), FAKE_WORKER);
  for (const name of ["pi-meta-auth-lock.cjs", "pi-meta-kernel.cjs", "pi-meta-original.cjs"]) {
    await copyFile(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), join(pkg, "bin", name));
  }
  const dependencyRoot = process.env.PI_META_TEST_DEPENDENCY_ROOT;
  assert.ok(dependencyRoot, "PI_META_TEST_DEPENDENCY_ROOT must point to the installed Web package");
  await symlink(join(dependencyRoot, "node_modules"), join(pkg, "node_modules"), "dir");
  t.after(async () => {
    delete globalThis[Symbol.for("pi-web:meta-worker/v1")];
    // If an assertion fails, stop only the synthetic worker belonging to this
    // unique fixture. Never leave its detached process or private socket behind.
    let owner;
    try { owner = JSON.parse(await readFile(join(root, "meta-agent/.pi-meta-worker/owner.json"), "utf8")); } catch { /* no worker */ }
    if (owner?.pid > 0) {
      const { execFileSync } = await import("node:child_process");
      try {
        const command = execFileSync("/bin/ps", ["-p", String(owner.pid), "-o", "command="], { encoding: "utf8" }).trim();
        if (command.endsWith(join(pkg, "bin/pi-meta-worker.cjs"))) process.kill(owner.pid, "SIGTERM");
      } catch { /* already exited */ }
      if (typeof owner.socketDir === "string" && owner.socketDir.startsWith(join(tmpdir(), "pi-meta-"))) {
        await rm(owner.socketDir, { recursive: true, force: true });
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, main, pkg };
}

test("concurrent starts share one worker, which a fresh parent can authenticate and adopt", async (t) => {
  const { main, pkg } = await fixture(t);
  const options = { mainAgentDir: main, packageDir: pkg, canStart: () => true };
  const [first, second] = await Promise.all([ensurePiMeta(options), ensurePiMeta(options)]);
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.pid, process.pid);
  delete globalThis[Symbol.for("pi-web:meta-worker/v1")];
  const status = await piMetaControl(options, "status");
  assert.equal(status.available, true);
  assert.equal(status.pending, false);
  const drain = await piMetaControl(options, "drain", LEASE);
  assert.equal(drain.pending, true);
  assert.equal((await piMetaControl(options, "status", LEASE)).pending, true);
  await shutdownPiMeta(options, LEASE);
});

test("a previous build is replaced only after its worker becomes idle", async (t) => {
  const { main, pkg } = await fixture(t);
  const options = { mainAgentDir: main, packageDir: pkg, canStart: () => true };
  assert.deepEqual(await piMetaRestartBlockingIds(options), []);
  const old = await ensurePiMeta(options);
  await piMetaControl(options, "set-busy");
  assert.deepEqual(await piMetaRestartBlockingIds(options), ["meta:session"]);
  await mkdir(join(pkg, ".next"));
  await writeFile(join(pkg, ".next/BUILD_ID"), "new-build");
  delete globalThis[Symbol.for("pi-web:meta-worker/v1")];
  assert.equal((await piMetaControl(options, "status")).sessions, 1);
  await assert.rejects(ensurePiMeta(options), /still busy/i);
  assert.equal((await piMetaControl(options, "status")).sessions, 1);
  await piMetaControl(options, "clear-busy");
  assert.deepEqual(await piMetaRestartBlockingIds(options), []);
  const replacement = await ensurePiMeta(options);
  assert.notEqual(replacement.pid, old.pid);
  assert.equal(replacement.stale, false);
  await piMetaControl(options, "drain", LEASE);
  await shutdownPiMeta(options, LEASE);
});

test("an unrecognized owner blocks startup and the external idle guard", async (t) => {
  const { root, main, pkg } = await fixture(t);
  const options = { mainAgentDir: main, packageDir: pkg, canStart: () => true };
  await ensurePiMeta(options);
  const ownerPath = join(root, "meta-agent/.pi-meta-worker/owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, JSON.stringify({ ...owner, groupId: owner.pid + 1 }), { mode: 0o600 });
  delete globalThis[Symbol.for("pi-web:meta-worker/v1")];
  assert.deepEqual(await piMetaRestartBlockingIds(options), ["meta:unknown"]);
  await assert.rejects(ensurePiMeta(options), /ownership record is unrecognized/i);
  await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  await piMetaControl(options, "drain", LEASE);
  await shutdownPiMeta(options, LEASE);
});

test("a worker in its own process group survives its parent and can be reattached", async (t) => {
  const { main, pkg } = await fixture(t);
  const moduleUrl = new URL("./pi-meta-process.mjs", import.meta.url).href;
  const program = `const {ensurePiMeta}=await import(process.env.TEST_MODULE); const worker=await ensurePiMeta({mainAgentDir:process.env.TEST_AGENT,packageDir:process.env.TEST_WEB,canStart:()=>true});process.send({pid:worker.pid},()=>process.exit(0));`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, TEST_MODULE: moduleUrl, TEST_AGENT: main, TEST_WEB: pkg },
  });
  parent.stderr.resume();
  const parentExit = once(parent, "exit");
  const [message] = await once(parent, "message");
  const [code] = await parentExit;
  assert.equal(code, 0);
  const { execFileSync } = await import("node:child_process");
  const groupId = Number(execFileSync("/bin/ps", ["-p", String(message.pid), "-o", "pgid="], { encoding: "utf8" }).trim());
  assert.equal(groupId, message.pid);
  const options = { mainAgentDir: main, packageDir: pkg };
  assert.equal((await piMetaControl(options, "status")).available, true);
  assert.equal((await piMetaControl(options, "drain", LEASE)).ok, true);
  await shutdownPiMeta(options, LEASE);
});

test("a drained shutdown waits for processes remaining in the worker group", async (t) => {
  const { main, pkg } = await fixture(t);
  const options = { mainAgentDir: main, packageDir: pkg, canStart: () => true };
  const worker = await ensurePiMeta(options);
  const held = await piMetaControl(options, "hold-child");
  const childPid = held.childPid;
  t.after(() => { try { process.kill(childPid, "SIGTERM"); } catch {} });
  const { execFileSync } = await import("node:child_process");
  const childGroup = Number(execFileSync("/bin/ps", ["-p", String(childPid), "-o", "pgid="], { encoding: "utf8" }).trim());
  assert.equal(childGroup, worker.pid);
  await piMetaControl(options, "drain", LEASE);
  let completed = false;
  const shutdown = shutdownPiMeta(options, LEASE).then(() => { completed = true; });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  assert.equal(completed, false, "must not release ownership while the group still contains a process");
  process.kill(childPid, "SIGTERM");
  await shutdown;
});

test("startup-error followed by process exit does not permanently block a safe retry", async (t) => {
  const { main, pkg } = await fixture(t);
  await writeFile(join(pkg, "bin/pi-meta-worker.cjs"), `process.send({type:'startup-error'}); setTimeout(() => process.exit(1), 10);`);
  const options = { mainAgentDir: main, packageDir: pkg, canStart: () => true };
  await assert.rejects(ensurePiMeta(options), /failed to start/i);
  assert.equal(piMetaStartingOrUnresolved(), false);
  await writeFile(join(pkg, "bin/pi-meta-worker.cjs"), FAKE_WORKER);
  await ensurePiMeta(options);
  assert.equal((await piMetaControl(options, "drain", LEASE)).ok, true);
  await shutdownPiMeta(options, LEASE);
});

test("restart admission refuses starting a worker", async (t) => {
  const { main, pkg } = await fixture(t);
  await assert.rejects(ensurePiMeta({ mainAgentDir: main, packageDir: pkg, canStart: () => false }), /restarting/i);
});
