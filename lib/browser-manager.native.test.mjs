import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const { BrowserManager } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./browser-manager.ts");

async function read(manager, id, expression) {
  const p = manager.pages.get(id);
  const r = await manager.connection.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: true }, p.session);
  return r.result.value;
}
async function wait(manager, id, predicate) {
  let finish; const result = new Promise(resolve => { finish = resolve; });
  const timer = setTimeout(() => finish(false), 10000);
  const off = await manager.subscribe(id, e => { if (e.type === "state" && predicate(e.state)) finish(true); });
  try { assert.equal(await result, true, `native browser state deadline: ${JSON.stringify(manager.get(id))}`); } finally { clearTimeout(timer); off(); }
}
test("real Chrome: frame-denied page, mouse/key/IME input, history, popup, private persistent cookies", { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "pi-native-browser-test-"));
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" });
    response.end(`<!doctype html><title>${request.url === "/popup" ? "POPUP_READY" : "NATIVE_READY"}</title><body style="margin:0;height:2500px"><input style="position:absolute;left:20px;top:20px;width:200px;height:32px" oninput="document.title='typed:'+this.value"><h1 style="margin-top:100px">Native browser, not iframe</h1><script>window.__alive='yes';</script></body>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  let manager = new BrowserManager(profile);
  const id = "b".repeat(32);
  try {
    await manager.create(id, url, 800, 700);
    await wait(manager, id, s => s.title === "NATIVE_READY" && !s.loading);
    assert.match(await read(manager, id, "document.body.innerText"), /not iframe/);
    for (const event of ["mousePressed", "mouseReleased"]) await manager.command(id, { type: "mouse", event, x: 40, y: 35, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
    await manager.command(id, { type: "key", event: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 });
    await manager.command(id, { type: "key", event: "keyUp", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 });
    await manager.command(id, { type: "text", text: "中文" });
    assert.equal(await read(manager, id, "document.querySelector('input').value"), "a中文");
    await read(manager, id, "document.querySelector('input').select()");
    assert.equal((await manager.command(id, { type: "copy" })).text, "a中文");
    await read(manager, id, "document.querySelector('input').type='password'");
    assert.equal((await manager.command(id, { type: "copy" })).text, "");
    await read(manager, id, "document.cookie='NATIVE_LOGIN=ok; Max-Age=3600; Path=/'");
    await manager.command(id, { type: "resize", width: 900, height: 600 });
    assert.equal(await read(manager, id, "window.__alive"), "yes");
    await manager.command(id, { type: "navigate", url: url + "/next" });
    await wait(manager, id, s => s.url.endsWith("/next") && !s.loading);
    await manager.command(id, { type: "back" });
    await wait(manager, id, s => s.url === url + "/" && !s.loading);
    await read(manager, id, `void window.open('${url}/popup','_blank')`);
    await wait(manager, id, s => s.title === "POPUP_READY");
    await read(manager, id, "window.close()");
    await wait(manager, id, s => s.url === url + "/");
    await manager.shutdown();
    manager = new BrowserManager(profile);
    await manager.create(id, url, 800, 700);
    await wait(manager, id, s => s.title === "NATIVE_READY" && !s.loading);
    assert.match(await read(manager, id, "document.cookie"), /NATIVE_LOGIN=ok/);
  } finally { await manager.shutdown(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(profile, { recursive: true, force: true }); }
});
