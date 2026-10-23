import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { compileVisualExpression } = await jiti.import("./visual-expressions.ts");
const { parseInlineVisual, sampleVisualCurve, visualViewport, visualTicks, clampVisualParameter, isClosedVisualFence, MAX_VISUAL_SOURCE } = await jiti.import("./inline-visual.ts");

export const derivativeFigure = {
  version: 1, title: "导数与切线", x: [-3, 3], y: [-1, 5],
  parameters: [{ name: "a", min: -1.8, max: 1.8, value: 1, step: 0.01 }],
  curves: [{ expr: "x^2", label: "y = x²" }, { expr: "2*a*x-a^2", label: "切线" }],
  shapes: [{ type: "point", at: ["a", "a^2"], label: "P", drag: "a" }],
  readouts: [{ label: "斜率", expr: "2*a" }],
};

test("bounded expression language uses mathematical precedence and finite constants", () => {
  for (const [expression, expected] of [["-2^2", -4], ["2^3^2", 512], ["2^-2", 0.25], ["1e-3 + .5", 0.501], ["sqrt(9)+abs(-2)", 5], ["sin(pi/2)", 1], ["log(e)", 1]]) {
    assert.ok(Math.abs(compileVisualExpression(expression, [])({}) - expected) < 1e-12, expression);
  }
  assert.equal(compileVisualExpression("x*x + a", ["x", "a"])({ x: 3, a: 2 }), 11);
  assert.ok(Number.isNaN(compileVisualExpression("sqrt(-1)", [])({})));
});
test("expressions cannot access JavaScript, prototypes, properties, or unbounded input", () => {
  for (const expression of ["alert(1)", "window", "x.constructor", "constructor(1)", "x=3", "x;1", "sin(1,2)", "2x", "1e999", "(".repeat(17) + "1" + ")".repeat(17), "1+".repeat(81) + "1"]) {
    assert.throws(() => compileVisualExpression(expression, ["x"]), expression);
  }
});
test("diagram formulas agree at positive, zero and negative tangent points", () => {
  const diagram = parseInlineVisual(JSON.stringify(derivativeFigure));
  for (const a of [-1.8, -1, 0, 1, 1.8]) {
    assert.ok(Math.abs(diagram.curves[0].expression({ x: a, a }) - a*a) < 1e-12);
    assert.ok(Math.abs(diagram.curves[1].expression({ x: a, a }) - a*a) < 1e-12);
    assert.equal(diagram.readouts[0].expression({ a }), 2*a);
  }
});
test("invalid diagrams fail closed with bounded expressions, parameters and geometry", () => {
  const invalid = [
    { ...derivativeFigure, version: 2 }, { ...derivativeFigure, x: [1, 1] },
    { ...derivativeFigure, curves: Array(5).fill({ expr: "x" }) },
    { ...derivativeFigure, parameters: [{ name: "constructor", min: 0, max: 1, value: 0 }] },
    { ...derivativeFigure, parameters: [{ name: "a", min: 0, max: 1, value: 0, step: 0 }] },
    { ...derivativeFigure, shapes: [{ type: "point", at: ["cos(a)", "sin(a)"], drag: "a" }] },
    { ...derivativeFigure, curves: [{ expr: "x", color: "url(https://example.com)" }] },
    { ...derivativeFigure, shapes: [{ type: "html", content: "<script>alert(1)</script>" }] },
  ];
  for (const value of invalid) assert.throws(() => parseInlineVisual(JSON.stringify(value)));
  assert.throws(() => parseInlineVisual(" ".repeat(MAX_VISUAL_SOURCE + 1)));
  assert.throws(() => parseInlineVisual('{"version":1'));
});
test("geometry preserves equal units, drag snapping and bounded tick counts", () => {
  const diagram = parseInlineVisual(JSON.stringify(derivativeFigure));
  const view = visualViewport(diagram.x, diagram.y);
  assert.equal(view.px(1)-view.px(0), view.py(0)-view.py(1));
  assert.ok(Math.abs(view.xAt(view.px(1.2)) - 1.2) < 1e-12);
  assert.equal(clampVisualParameter(diagram.parameters[0], 100), 1.8);
  assert.equal(clampVisualParameter(diagram.parameters[0], -0.504), -0.5);
  assert.ok(visualTicks([-1e6, 1e6]).length <= 12);
});
test("sampled paths do not bridge non-finite points or poles", () => {
  const view = visualViewport([-2, 2], [-4, 4]);
  const pole = sampleVisualCurve(compileVisualExpression("1/(x-0.123)", ["x"]), {}, [-2, 2], [-4, 4], view);
  assert.ok((pole.match(/M/g) ?? []).length > 1);
  assert.ok(!pole.includes("NaN") && !pole.includes("Infinity"));
  assert.equal(sampleVisualCurve(compileVisualExpression("sqrt(-1)", []), {}, [-2, 2], [-4, 4], view), "");
});
test("steep continuous lines render without drawing across finite step discontinuities", () => {
  const view = visualViewport([-1, 1], [-1, 1]);
  const steep = sampleVisualCurve(compileVisualExpression("1000*x", ["x"]), {}, [-1, 1], [-1, 1], view);
  assert.match(steep, /L/, "A clipped continuous line must have visible segments");
  const floor = sampleVisualCurve(compileVisualExpression("floor(x)", ["x"]), {}, [-1, 1], [-1, 1], view);
  const points = [...floor.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)];
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] === "L") assert.equal(points[i][3], points[i - 1][3], "floor's steps must not be connected by invented sloping segments");
  }
});
test("initial parameter values use the same step normalization as interaction and reset", () => {
  const diagram = parseInlineVisual(JSON.stringify({ ...derivativeFigure, parameters: [{ name: "a", min: 0, max: 1, value: 0.25, step: 0.1 }] }));
  assert.equal(diagram.parameters[0].value, clampVisualParameter(diagram.parameters[0], 0.25));
});
test("Markdown info-string whitespace still produces a complete diagram", async () => {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  for (const opener of ["``` pi-visual", "~~~\tpi-visual", "```pi-visual"]) {
    const markdown = opener + '\n{"version":1}\n' + opener.slice(0, 3);
    const node = unified().use(remarkParse).parse(markdown).children[0];
    assert.equal(node.lang, "pi-visual");
    assert.equal(isClosedVisualFence(markdown, node.position.start.offset, node.position.end.offset), true);
  }
});
test("only a fully closed matching fence becomes interactive while prose continues", () => {
  const fence = '\x60\x60\x60pi-visual\n{"version":1}\n\x60\x60\x60';
  assert.equal(isClosedVisualFence(fence, 0, fence.length), true);
  for (let n = 0; n < fence.length; n++) assert.equal(isClosedVisualFence(fence.slice(0, n), 0, n), false);
  assert.equal(isClosedVisualFence(fence.replace(/\x60\x60\x60$/, "~~~"), 0, fence.length), false);
});
test("representative graph sampling is bounded and measured without a model call", t => {
  const diagram = parseInlineVisual(JSON.stringify(derivativeFigure));
  const view = visualViewport(diagram.x, diagram.y);
  const start = performance.now();
  for (let index = 0; index < 100; index++) for (const curve of diagram.curves) sampleVisualCurve(curve.expression, { a: index / 100 }, diagram.x, diagram.y, view);
  t.diagnostic("100 two-curve updates: " + (performance.now() - start).toFixed(1) + " ms (local measurement, not a network/model latency guarantee)");
});
