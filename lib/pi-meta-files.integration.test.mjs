import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

test("a persisted Meta session grants its worker file access without a Pi session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-files-"));
  const meta = join(root, "meta-agent"), project = join(root, "project");
  await mkdir(meta); await mkdir(project);
  await writeFile(join(meta, "settings.json"), "{}");
  await writeFile(join(project, "fixture.txt"), "synthetic fixture");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = meta;
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(root, { recursive: true, force: true }); });
  const session = SessionManager.create(project);
  session.appendMessage({ role: "user", content: "synthetic fixture", timestamp: Date.now() });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
  const { GET } = await jiti.import("../app/api/files/[...path]/route.ts");
  const segments = project.split("/").filter(Boolean);
  const response = await GET(new NextRequest("http://localhost/api/files/fixture?type=list"), { params: Promise.resolve({ path: segments }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).entries.some(entry => entry.name === "fixture.txt"));
});
