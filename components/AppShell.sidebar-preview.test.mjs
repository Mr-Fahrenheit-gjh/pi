import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const css = postcss.parse(await readFile(new URL("../app/workspace.css", import.meta.url), "utf8"));
// Execute the actual hook callbacks, following AppShell.sidebar-breakpoint.test.mjs.
const ast = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
function previewState(state, setter) {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const context = createContext({
    isMobile: false, [state + "Open"]: false, [state + "PreviewOpen"]: false,
    [state + "PreviewExiting"]: false, [state + "HoverTimer"]: { current: null },
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  context[`set${setter}PreviewOpen`] = (value) => { context[`${state}PreviewOpen`] = value; };
  context[`set${setter}PreviewExiting`] = (value) => { context[`${state}PreviewExiting`] = value; };
  const evaluate = (text) => new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInContext(context);
  for (const name of [`clear${setter}HoverTimer`, `close${setter}Preview`, `preview${setter}`, `keep${setter}Preview`, `dismiss${setter}Preview`]) {
    const declaration = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
    context[name] = evaluate(`(${declaration.initializer.arguments[0].getText(ast)})`);
  }
  const effect = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[1]?.getText(ast) === `[${state}PreviewExiting]`);
  return {
    context,
    startExitCleanup: () => evaluate(`(${effect.arguments[0].getText(ast)})()`),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due; timers.delete(id); now = timer.at; timer.callback();
      }
      now = end;
    },
  };
}

test("a late compositor frame cannot reinsert a closed panel into flex", () => {
  for (const [selector, media] of [[".sidebar-container.sidebar-closed", "(min-width: 641px)"], [".right-panel-container.right-panel-closed", "(min-width: 960px)"]]) {
    let fixed = false;
    css.walkRules(rule => {
      if (!rule.selectors.includes(selector) || rule.parent.params !== media) return;
      rule.walkDecls("position", declaration => { if (declaration.value === "fixed") fixed = true; });
    });
    assert.equal(fixed, true, selector + " must stay outside flex even after the exiting class is removed");
  }
});

const declarationsFor = (selector) => {
  const declarations = {};
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    assert.equal(rule.parent.name, "media");
    assert.equal(rule.parent.params, "(min-width: 641px)", "preview overrides must remain desktop-only");
    rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
  });
  return declarations;
};

for (const [state, setter, prefix, container] of [
  ["sidebar", "Sidebar", "sidebar", "sidebar"],
  ["rightPanel", "RightPanel", "right-panel", "right-panel"],
]) {
  test(`${prefix} preview exits at zero width outside the flex layout`, () => {
    const open = declarationsFor(`.${container}-container.${prefix}-preview`);
    const exiting = declarationsFor(`.${container}-container.${prefix}-preview-exiting`);
    assert.equal(open.position, "fixed");
    assert.equal(exiting.position, "fixed");
    assert.equal(exiting.width, "0");
    assert.equal(exiting["min-width"], "0");
    assert.equal(exiting["pointer-events"], "none");
    assert.match(exiting.transition, /width 0\.2s var\(--workspace-ease\), min-width 0\.2s var\(--workspace-ease\)/);
  });

  test(`${prefix} previews use solid theme surfaces without fading content`, () => {
    for (const suffix of ["preview", "preview-exiting"]) {
      const paint = declarationsFor(`.${container}-container.${prefix}-${suffix}`);
      assert.equal(paint.background, prefix === "sidebar" ? "var(--sidebar-preview-surface)" : "var(--bg)");
      assert.doesNotMatch(paint.background, /gradient|transparent/);
      assert.equal(paint.opacity, undefined, "text and icons must not fade");
      assert.equal(paint["mask-image"], undefined, "a mask would fade the content too");
    }
    css.walkRules((rule) => {
      if (rule.nodes?.some((node) => node.prop === "background" && node.value.includes("linear-gradient(to"))) {
        assert.ok(rule.selectors.every((selector) => selector.includes("-preview")), "pinned/mobile surfaces must not become gradients");
      }
    });
  });

  test(`${prefix} hover bridge, dismissal and fallback use an independent closing phase`, () => {
    const { context, advance, startExitCleanup } = previewState(state, setter);
    context[`preview${setter}`]({ pointerType: "mouse" }); advance(160);
    assert.equal(context[`${state}PreviewOpen`], true);
    context[`dismiss${setter}Preview`](); advance(100);
    context[`keep${setter}Preview`](); advance(300);
    assert.equal(context[`${state}PreviewOpen`], true, "entering the preview cancels pointer dismissal");
    context[`dismiss${setter}Preview`](); advance(220);
    assert.equal(context[`${state}PreviewOpen`], false);
    assert.equal(context[`${state}PreviewExiting`], true);
    startExitCleanup(); advance(201);
    assert.equal(context[`${state}PreviewExiting`], true, "fixed positioning must outlast the 200ms width transition");
    advance(39);
    assert.equal(context[`${state}PreviewExiting`], false);
    assert.equal(context[`${state}Open`], false, "previews never pin the panel");
  });

  test(`${prefix} re-entry cancels closing and touch/mobile/pinned hover never previews`, () => {
    const { context, advance, startExitCleanup } = previewState(state, setter);
    context[`preview${setter}`]({ pointerType: "mouse" }); advance(160);
    context[`close${setter}Preview`]();
    const cleanup = startExitCleanup();
    context[`preview${setter}`]({ pointerType: "mouse" }); advance(160);
    cleanup(); advance(300);
    assert.equal(context[`${state}PreviewOpen`], true);
    assert.equal(context[`${state}PreviewExiting`], false);
    for (const guard of ["touch", "mobile", "pinned"]) {
      context[`${state}PreviewOpen`] = false;
      context.isMobile = guard === "mobile";
      context[`${state}Open`] = guard === "pinned";
      context[`preview${setter}`]({ pointerType: guard === "touch" ? "touch" : "mouse" }); advance(300);
      assert.equal(context[`${state}PreviewOpen`], false, guard);
    }
  });

  test(`${prefix} pointer dismissal and Escape retain the exit phase with cleanup`, () => {
    assert.ok(source.includes(`if (${state}PreviewOpen) set${setter}PreviewExiting(true);`));
    assert.ok(source.includes(`${state}HoverTimer.current = setTimeout(close${setter}Preview, 220);`));
    assert.match(source, new RegExp(`event.key === "Escape"[\\s\\S]*?clear${setter}HoverTimer\\(\\);\\s*close${setter}Preview\\(\\);`));
    assert.ok(source.includes(`const timer = setTimeout(() => set${setter}PreviewExiting(false), 240);`));
    assert.match(source, new RegExp(`set${setter}PreviewExiting\\(false\\), 240\\);\\s*return \\(\\) => clearTimeout\\(timer\\);`));
    assert.ok(source.includes(`event.target === event.currentTarget && event.propertyName === "width") set${setter}PreviewExiting(false)`));
    assert.ok(source.includes(`!${state}Open && !isMobile ? ${state}PreviewOpen ? " ${prefix}-preview" : ${state}PreviewExiting ? " ${prefix}-preview-exiting"`));
    assert.ok(source.includes(`set${setter}PreviewExiting(false);\n      set${setter}PreviewOpen(true);`), "re-entering cancels an unfinished exit");
    assert.ok(source.includes(`set${setter}PreviewOpen(false);\n    set${setter}PreviewExiting(false);`), "pin/mobile changes clear ephemeral phases");
  });
}

test("solid previews do not erase inner theme surfaces", () => {
  css.walkRules(rule => {
    if (!rule.selector.includes("-preview")) return;
    assert.ok(!rule.selector.includes('[style*="background'), "no broad transparent inline-surface override");
    rule.walkDecls("background", declaration => assert.doesNotMatch(declaration.value, /gradient|transparent/));
  });
});

test("right preview finishes offscreen before compact desktop's closed style takes over", () => {
  const exiting = declarationsFor(".right-panel-container.right-panel-preview-exiting");
  assert.equal(exiting.transform, "translateX(100%)");
  assert.match(exiting.transition, /transform 0\.2s var\(--workspace-ease\)/);
});

test("reduced motion overrides pinned, preview and compact panel transitions", () => {
  for (const selector of [".sidebar-container", ".sidebar-overlay-backdrop", ".right-panel-container", ".right-panel-overlay-backdrop", ".composer-entry"]) {
    let override = false;
    css.walkAtRules("media", media => {
      if (media.params !== "(prefers-reduced-motion: reduce)") return;
      media.walkRules(rule => {
        if (!rule.selectors.includes(selector)) return;
        rule.walkDecls("transition", declaration => {
          if (declaration.value === "none" && declaration.important) override = true;
        });
      });
    });
    assert.ok(override, `${selector} needs to override the more specific preview selectors`);
  }
});
