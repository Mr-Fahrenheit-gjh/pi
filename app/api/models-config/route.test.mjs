import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const modelsPath = join(testAgentDir, "models.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body, revision) {
  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost", ...(revision ? {"If-Match":revision} : {}) },
    body: JSON.stringify(body),
  });
}

test("a models.json with a syntax error is reported instead of read as empty, and a save cannot replace it", async () => {
  const original = '{ "providers": { "acme": { "models": [ } } }';
  await writeFile(modelsPath, original);

  let response = await GET();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /models\.json/);

  response = await PUT(put({ providers: {} }));
  assert.equal(response.status, 428);
  assert.equal((await response.json()).error, "stale-config");
  assert.equal(await readFile(modelsPath, "utf8"), original);

  response = await PUT(put({ providers: {} }, "prior-draft-revision"));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("a commented models.json loads with its providers", async () => {
  await writeFile(modelsPath, '{\n  // local models\n  "providers": { "acme": { "models": [{ "id": "a" },] } },\n}\n');

  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("X-Config-Revision"), /^[a-f0-9]{64}$/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { providers: { acme: { models: [{ id: "a" }] } } });
});

test("a fresh Models draft saves once, then its stale revision cannot overwrite another edit", async () => {
  await writeFile(modelsPath, JSON.stringify({providers:{}}));
  const first = await GET(), revision = first.headers.get("X-Config-Revision");
  const next = {providers:{acme:{models:[{id:"keep-this-edit"}]}}};
  const saved = await PUT(put(next,revision));
  assert.equal(saved.status,200);
  assert.notEqual(saved.headers.get("X-Config-Revision"),revision);
  const stale = await PUT(put({providers:{}},revision));
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).error,"stale-config");
  assert.deepEqual(JSON.parse(await readFile(modelsPath,"utf8")),next);
});
