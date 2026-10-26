import assert from "node:assert/strict";
import { join } from "node:path";

/** Isolated real routes + browser polls; no model commands or native/global state. */
export async function checkReadState({ browser, base, artifacts, a, b, api, post }) {
  const state = async () => (await api("/api/sessions/read-state")).state;
  const mark = async (action, ids) => post("/api/sessions/read-state", { action, ids });
  const read = async (id, token) => post("/api/sessions/read-state", { action: "read", entries: [{ id, token }] });
  const wait = async (predicate) => {
    const deadline = Date.now() + 20_000;
    while (!predicate(await state())) {
      assert.ok(Date.now() < deadline, "read-state did not converge");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const forbidden = [];
  await context.route("**/api/agent/**", async route => {
    const request = route.request();
    if (request.method() === "POST" && ["prompt", "steer", "follow_up"].includes(request.postDataJSON()?.type)) {
      forbidden.push(request.postData()); return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(({ b }) => {
    localStorage.setItem("pi-web:unread-session-ids", JSON.stringify([b]));
    // Deterministic background-window/visibility boundary, independent of the headless host's focus policy.
    window.__readFocus = false; window.__readVisible = true;
    document.hasFocus = () => window.__readFocus;
    Object.defineProperty(document, "visibilityState", { get: () => window.__readVisible ? "visible" : "hidden" });
  }, { b });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const row = id => page.locator(`#session-sidebar-panel-sessions [data-row-key="session:group:${id}"]`);
  const unread = id => row(id).locator(".session-tree-unread");
  const attention = (focused, visible = true) => page.evaluate(({ focused, visible }) => {
    window.__readFocus = focused; window.__readVisible = visible;
    document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
  }, { focused, visible });
  const menu = async (id, label) => {
    await row(id).hover();
    await row(id).locator(".session-tree-more-action").click();
    await page.getByRole("menuitem", { name: label, exact: false }).click();
  };
  try {
    await page.goto(`${base}/?session=${a}`, { waitUntil: "domcontentloaded" });
    // The initial local dot can paint before full catalogue hydration permits import.
    await wait(s => !!s.unread[b]);
    await unread(b).waitFor();
    const migrated = await state(); assert.ok(migrated.unread[b]);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-web:unread-session-ids")), null);
    // Native->Web read, then Web->native explicit unread/read.
    await read(b, migrated.unread[b]); await unread(b).waitFor({ state: "hidden" });
    await menu(b, "Mark as unread"); await wait(s => !!s.unread[b]); await unread(b).waitFor();
    await menu(b, "Mark as read"); await wait(s => !s.unread[b]);
    // A background selected conversation must stay unread; a focus event reads it.
    await mark("unread", [a]); await unread(a).waitFor();
    assert.ok((await state()).unread[a]);
    await attention(true); await wait(s => !s.unread[a]);
    // An explicitly marked selected conversation remains unread until attention changes.
    await menu(a, "Mark as unread"); await unread(a).waitFor();
    const explicit = (await state()).unread[a];
    await page.waitForResponse(r => r.url().endsWith("/api/agent/running") && r.ok());
    assert.equal((await state()).unread[a], explicit);
    await attention(false, false);
    await row(b).locator("a.session-tree-main").click();
    await mark("unread", [b]);
    await attention(true, false);
    assert.ok((await state()).unread[b], "hidden selected session remains unread");
    await attention(true, true); await wait(s => !s.unread[b]);
    // A second tab's stale legacy import cannot resurrect the shared read tombstone.
    const second = await context.newPage();
    const imported = second.waitForResponse(r => r.url().endsWith("/api/sessions/read-state") && r.request().method() === "POST" && r.ok());
    await second.goto(`${base}/?session=${a}`, { waitUntil: "domcontentloaded" });
    await imported;
    assert.equal((await state()).unread[b], undefined);
    await second.close();
    // Stale and zero acknowledgements cannot clear a newer token.
    await read(a, explicit); const newer = (await mark("unread", [a])).state.unread[a];
    await read(a, explicit); await read(a, 0); assert.equal((await state()).unread[a], newer);
    // Mobile workspace covers the conversation even though desktop full-width
    // mode is off. A completion must remain unread until the workspace closes.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    const mobilePanel = page.locator("#file-panel.right-panel-open");
    await mobilePanel.waitFor({ state: "visible" });
    const bounds = await mobilePanel.boundingBox();
    assert.ok(bounds && bounds.width >= 389, "mobile workspace covers the viewport");
    const mobileReads = [];
    const watchMobileRead = request => {
      if (request.url().endsWith("/api/sessions/read-state") && request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action === "read" && body.entries.some(entry => entry.id === b)) mobileReads.push(body);
      }
    };
    page.on("request", watchMobileRead);
    await mark("unread", [b]);
    // Observe consecutive polls, not merely the immediate pre-effect state.
    for (let i = 0; i < 2; i++) await page.waitForResponse(r => r.url().endsWith("/api/agent/running") && r.ok());
    assert.ok((await state()).unread[b], "mobile overlay must not clear the hidden conversation");
    assert.deepEqual(mobileReads, []);
    // The existing mobile header overlaps the centre toggle; use its keyboard
    // activation to close it without changing that unrelated layout contract.
    await page.getByRole("button", { name: "Hide file panel", exact: true }).press("Enter");
    await wait(s => !s.unread[b]);
    page.off("request", watchMobileRead);
    // Route hardening, including actual streamed byte bound.
    for (const [body, status] of [[{ action: "read", entries: [{ id: a, token: -1 }] }, 400], [{ action: "unread", ids: [a], extra: true }, 400]]) {
      const response = await fetch(`${base}/api/sessions/read-state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const crossOrigin = await fetch(`${base}/api/sessions/read-state`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.invalid" }, body: JSON.stringify({ action: "unread", ids: [a] }) });
    assert.equal(crossOrigin.status, 403);
    const oversized = await fetch(`${base}/api/sessions/read-state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(128 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(forbidden, []);
    console.log("PASS: shared read-state routes, browser migration/tombstones, bidirectional polling, focus/visibility, explicit actions, mobile workspace occlusion and CAS/security");
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "read-state-failure.png") }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
