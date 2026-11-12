import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { focusIfLost } from "../lib/stacked-dialog.ts";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");
const [panel, shell, hook, route, css] = await Promise.all([
  read("./PendingReleasePanel.tsx"), read("./AppShell.tsx"), read("../hooks/usePendingReleases.ts"),
  read("../app/api/pending-releases/route.ts"), read("../app/settings.css"),
]);

test("GET returns a no-store snapshot and directory failure is unavailable, not empty", async () => {
  const evaluate = (readReleaseSnapshot) => runInNewContext(
    route.replace(/^import .*;\n/gm, "").replace(/export /g, "") + "\nGET;",
    { readReleaseSnapshot, NextResponse: { json: (value, options) => Response.json(value, options) } },
  );
  const snapshot = { entries: [], warnings: ["synthetic warning"], pendingCount: 0 };
  const success = await evaluate(async () => snapshot)();
  assert.equal(success.status, 200); assert.equal(success.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await success.json(), snapshot);
  const failure = await evaluate(async () => { throw new Error("private path or content"); })();
  assert.equal(failure.status, 503); assert.equal(failure.headers.get("Cache-Control"), "no-store");
  const result = await failure.json(); assert.ok(result.error); assert.equal(result.entries, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("API is read-only and accepts no request-controlled filesystem path", () => {
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /async function GET\(\)/);
  assert.doesNotMatch(route, /function (?:POST|PUT|PATCH|DELETE)|request\.|searchParams|readFile|startRpc|sendAgent/);
});

test("footer only mounts Settings, without release polling or restart entry", () => {
  assert.match(shell, /<SettingsPanel/);
  assert.doesNotMatch(shell, /PendingReleasePanel|usePendingReleases|pendingReleaseOpen/);
  const footer = shell.match(/<div className="workspace-settings-entry">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.equal((footer.match(/<button/g) ?? []).length, 1);
  assert.match(footer, /translate\("common.settings"\)/);
});

test("single Settings action keeps a visible label and aligned navigation typography", async () => {
  const workspace = await read("../app/workspace.css");
  const footer = workspace.match(/\.workspace-settings-entry > button \{([^}]+)\}/)?.[1] ?? "";
  assert.match(footer, /font-family: var\(--font-sidebar\)/);
  assert.match(footer, /font-size: 14px/);
  assert.match(footer, /font-weight: 435/);
  assert.match(footer, /min-height: 32px/);
  assert.match(footer, /justify-content: flex-start/);
  assert.match(footer, /width: 100%/);
  assert.doesNotMatch(workspace, /@container sidebar-actions/);
});

test("panel shares Settings desktop shell, focus/Escape, read-only evidence, history and copy", () => {
  for (const className of ["settings-dialog-backdrop", "settings-dialog-surface", "settings-dialog-header", "settings-dialog-title", "settings-section-tabs", "settings-section-tab", "settings-dialog-main", "settings-section-host"]) assert.ok(panel.includes(className), className);
  assert.match(panel, /focusModalPanel\(document, dialogRef\.current\)/);
  assert.match(panel, /listenForPanelEscape\(document, onClose\)/);
  assert.match(panel, /event\.key !== "Tab"/);
  assert.match(panel, /role="dialog"/); assert.match(panel, /aria-modal="true"/);
  assert.match(panel, /event\.target === event\.currentTarget\) onClose\(\)/);
  assert.match(panel, /\["pending", "deployed"\]/);
  assert.match(panel, /entry\.status === tab/);
  assert.match(panel, /<details>[\s\S]*?<summary>\{t\("pendingRelease\.details"\)\}<\/summary>/);
  for (const field of ["summary", "sourceSessions", "codeLocations", "verification", "releaseSteps", "rollback", "dependencies", "createdAt", "deployedAt", "revision"]) assert.ok(panel.includes(`entry.${field}`), field);
  assert.match(panel, /formatReleaseHandoff\(entry\)/);
  assert.match(panel, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(panel, /!document\.execCommand\("copy"\)/);
  assert.match(panel, /t\("pendingRelease\.copyFailed"\)/);
  assert.match(panel, /t\("pendingRelease\.warning"\)/);
  assert.match(panel, /error && <p role="alert"/);
  assert.match(panel, /<ConfigButton size="small"/);
  assert.doesNotMatch(panel, /sendAgent|useAgentSession|startRpc|\/api\/agent|\/api\/service|eval\(|dangerouslySetInnerHTML/);
  assert.match(css, /\.pending-release-dialog \{\s*font-family: var\(--font-ui\)/);
});

// Execute the panel's actual effect and Tab handler against a minimal DOM stand-in;
// no React/browser dependencies are installed in the source worktree.
function refreshFocusHarness() {
  const document = { body: {}, activeElement: null };
  const control = () => ({ focus() { document.activeElement = this; } });
  const first = control(), last = control(), copy = control();
  const dialog = { ...control(), querySelectorAll: () => [first, last] };
  const context = { document, dialogRef: { current: dialog }, focusIfLost };
  const effect = panel.match(/useLayoutEffect\((\(\) => \{[^}]*focusIfLost[^}]*\}), \[snapshot\]\);/);
  assert.ok(effect, "snapshot changes must run focus recovery after DOM updates");
  const recoverFocus = runInNewContext(effect[1], context);
  const handler = panel.match(/onKeyDown=\{(\(event\) => \{[\s\S]*?\n      \})\}/);
  assert.ok(handler);
  const onKeyDown = runInNewContext(handler[1].replace("querySelectorAll<HTMLElement>", "querySelectorAll"), context);
  const commitSnapshot = (snapshot) => {
    const visibleEntries = snapshot?.entries.filter((entry) => entry.status === "pending") ?? [];
    if (document.activeElement === copy && !visibleEntries.some((entry) => entry.id === "focused-entry")) {
      // Browser focus fixup after React removes the copy button.
      copy.isConnected = false;
      document.activeElement = document.body;
    }
    recoverFocus();
  };
  return { document, first, last, copy, dialog, recoverFocus, onKeyDown, commitSnapshot };
}

for (const [scenario, nextSnapshot] of [
  ["refresh removes the focused entry", { entries: [] }],
  ["refresh failure clears the snapshot", null],
]) {
  test(`${scenario}: recover modal focus before Tab can escape`, () => {
    const { document, first, last, copy, dialog, onKeyDown, commitSnapshot } = refreshFocusHarness();
    document.activeElement = copy;
    commitSnapshot({ entries: [{ id: "focused-entry", status: "pending" }] });
    assert.equal(document.activeElement, copy, "do not steal focus while its control remains");
    commitSnapshot(nextSnapshot);
    assert.equal(document.activeElement, dialog);
    let prevented = false;
    onKeyDown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(document.activeElement, first, "the next Tab stays in the dialog");
    onKeyDown({ key: "Tab", shiftKey: true, preventDefault() {} });
    assert.equal(document.activeElement, last, "reverse Tab still wraps inside the dialog");
  });
}

test("snapshot focus recovery preserves a remaining control or deliberate external focus", () => {
  const { document, first, recoverFocus } = refreshFocusHarness();
  for (const focused of [first, { name: "deliberately focused elsewhere" }]) {
    document.activeElement = focused;
    recoverFocus();
    assert.equal(document.activeElement, focused);
  }
});

test("hook refreshes on start, open, focus and visibility; listeners and requests clean up", () => {
  assert.match(hook, /void current\.refresh\(\)/);
  assert.match(hook, /if \(open\) refresh\(\)/);
  assert.match(hook, /addEventListener\("focus", onFocus\)/);
  assert.match(hook, /addEventListener\("visibilitychange", onVisible\)/);
  assert.match(hook, /visibilityState === "visible"/);
  assert.match(hook, /current\.dispose\(\)/);
  assert.match(hook, /removeEventListener\("focus", onFocus\)/);
  assert.match(hook, /removeEventListener\("visibilitychange", onVisible\)/);
  assert.doesNotMatch(hook, /setInterval|sendAgent|POST/);
});
