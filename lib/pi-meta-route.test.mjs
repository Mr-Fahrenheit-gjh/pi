import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/api/runtime/meta/[...path]/route.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "forward");
const js = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("the socket proxy keeps file-manager actions local-only using the original host", async () => {
  let started = false;
  const context = vm.createContext({
    Request, Response, process: { platform: "linux" },
    NextResponse: { json: (value, options) => Response.json(value, options) },
    isApiRequestAllowed: () => true,
    piMetaUpstreamPath: () => "/api/open-in-explorer",
    isLoopbackHost: () => false,
    ensurePiMeta: async () => { started = true; throw new Error("must not start"); },
  });
  vm.runInContext(js, context);
  const get = await context.forward(new Request("http://remote.example/api/runtime/meta/open-in-explorer"));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { supported: false, reason: "remote", platform: "linux" });
  const post = await context.forward(new Request("http://remote.example/api/runtime/meta/open-in-explorer", { method: "POST" }));
  assert.equal(post.status, 403);
  assert.equal(started, false);
});
