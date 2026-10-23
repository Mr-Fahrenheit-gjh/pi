import { compileVisualExpression, isVisualVariable, type VisualExpression } from "./visual-expressions";

export const INLINE_VISUAL_LANGUAGE = "pi-visual";
export const MAX_VISUAL_SOURCE = 6000;
export const VISUAL_SAMPLES = 160;
export type VisualRange = readonly [number, number];
export type VisualPosition = readonly [VisualExpression, VisualExpression];
export type VisualColor = "blue" | "orange" | "green" | "purple" | "red";
export interface VisualParameter { name: string; min: number; max: number; value: number; step: number }
interface Labeled { label: string; color: VisualColor }
export interface VisualCurve extends Labeled { expression: VisualExpression }
export type VisualShape = Labeled & (
  | { type: "point"; at: VisualPosition; drag?: string }
  | { type: "segment"; from: VisualPosition; to: VisualPosition; arrow: boolean }
  | { type: "circle"; center: VisualPosition; radius: VisualExpression }
  | { type: "polygon"; points: VisualPosition[] }
);
export interface InlineVisual {
  title: string;
  x: VisualRange;
  y: VisualRange;
  parameters: VisualParameter[];
  curves: VisualCurve[];
  shapes: VisualShape[];
  readouts: { label: string; expression: VisualExpression }[];
}
const COLORS: VisualColor[] = ["blue", "orange", "green", "purple", "red"];
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
};
const numeric = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error("Invalid number");
  return value;
};
const label = (value: unknown, fallback = ""): string => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 80) throw new Error("Invalid label");
  return value;
};
const items = (value: unknown, maximum: number): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Too many items");
  return value;
};
const range = (value: unknown): VisualRange => {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected range");
  const low = numeric(value[0]);
  const high = numeric(value[1]);
  if (high - low < 0.0001 || high - low > 1e7) throw new Error("Invalid range");
  return [low, high];
};
const labeled = (value: Record<string, unknown>, index: number): Labeled => {
  const color = value.color ?? COLORS[index % COLORS.length];
  if (!COLORS.includes(color as VisualColor)) throw new Error("Invalid color");
  return { label: label(value.label), color: color as VisualColor };
};

/** The renderer accepts data only; strings never become markup, URLs or JavaScript. */
export function parseInlineVisual(source: string): InlineVisual {
  if (source.length > MAX_VISUAL_SOURCE) throw new Error("Diagram is too large");
  const value = record(JSON.parse(source));
  if (value.version !== 1) throw new Error("Unsupported diagram version");
  const parameters = items(value.parameters, 4).map(item => {
    const parameter = record(item);
    const name = label(parameter.name);
    if (!isVisualVariable(name)) throw new Error("Invalid parameter name");
    const [min, max] = range([parameter.min, parameter.max]);
    const initial = numeric(parameter.value);
    const step = parameter.step === undefined ? (max - min) / 100 : numeric(parameter.step);
    if (step <= 0 || step > max - min || (max - min) / step > 1e6 || initial < min || initial > max) throw new Error("Invalid parameter range");
    const parsed = { name, min, max, value: initial, step };
    return { ...parsed, value: clampVisualParameter(parsed, initial) };
  });
  const names = parameters.map(parameter => parameter.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate parameter");
  const expression = (input: unknown) => compileVisualExpression(input, names);
  const position = (input: unknown): VisualPosition => {
    if (!Array.isArray(input) || input.length !== 2) throw new Error("Invalid position");
    return [expression(input[0]), expression(input[1])];
  };
  const curves = items(value.curves, 4).map((item, index) => {
    const curve = record(item);
    return { ...labeled(curve, index), expression: compileVisualExpression(curve.expr, ["x", ...names]) };
  });
  const shapes: VisualShape[] = items(value.shapes, 24).map((item, index) => {
    const shape = record(item);
    const common = labeled(shape, index);
    switch (shape.type) {
      case "point": {
        const at = position(shape.at);
        const drag = shape.drag;
        // Horizontal dragging has an exact inverse only for a parameter's x coordinate.
        if (drag !== undefined && (typeof drag !== "string" || !names.includes(drag) || (shape.at as unknown[])[0] !== drag)) throw new Error("Invalid draggable point");
        return { ...common, type: "point", at, ...(drag === undefined ? {} : { drag: drag as string }) };
      }
      case "segment":
        if (shape.arrow !== undefined && typeof shape.arrow !== "boolean") throw new Error("Invalid arrow");
        return { ...common, type: "segment", from: position(shape.from), to: position(shape.to), arrow: shape.arrow === true };
      case "circle": return { ...common, type: "circle", center: position(shape.center), radius: expression(shape.radius) };
      case "polygon": {
        const points = items(shape.points, 32).map(position);
        if (points.length < 3) throw new Error("Polygon needs three points");
        return { ...common, type: "polygon", points };
      }
      default: throw new Error("Unknown shape");
    }
  });
  if (curves.length + shapes.length === 0) throw new Error("Empty diagram");
  const readouts = items(value.readouts, 6).map(item => {
    const readout = record(item);
    return { label: label(readout.label), expression: expression(readout.expr) };
  });
  return { title: label(value.title), x: range(value.x), y: range(value.y), parameters, curves, shapes, readouts };
}

export function clampVisualParameter(parameter: VisualParameter, value: number): number {
  if (!Number.isFinite(value)) return parameter.value;
  const steps = Math.round((value - parameter.min) / parameter.step);
  return Number(Math.max(parameter.min, Math.min(parameter.max, parameter.min + steps * parameter.step)).toPrecision(12));
}

export function visualViewport(x: VisualRange, y: VisualRange) {
  // Equal units on both axes: circles stay circles and vector angles stay meaningful.
  const scale = Math.min(544 / (x[1] - x[0]), 300 / (y[1] - y[0]));
  const left = 48 + (544 - (x[1] - x[0]) * scale) / 2;
  const top = 24 + (300 - (y[1] - y[0]) * scale) / 2;
  return {
    left, top, width: (x[1] - x[0]) * scale, height: (y[1] - y[0]) * scale, scale,
    px: (value: number) => left + (value - x[0]) * scale,
    py: (value: number) => top + (y[1] - value) * scale,
    xAt: (pixel: number) => x[0] + (pixel - left) / scale,
  };
}
export type VisualViewport = ReturnType<typeof visualViewport>;

export function formatVisualNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1e-10) return "0";
  return Number(value.toPrecision(5)).toString();
}
export function visualTicks([low, high]: VisualRange): number[] {
  const raw = (high - low) / 6;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find(multiplier => multiplier * magnitude >= raw)! * magnitude;
  const result: number[] = [];
  for (let n = Math.ceil(low / step); n * step <= high && result.length < 12; n++) result.push(n * step);
  return result;
}

/** Bounded adaptive sampling: clip steep lines, and omit unresolved jumps/poles. */
export function sampleVisualCurve(curve: VisualExpression, values: Readonly<Record<string, number>>, x: VisualRange, y: VisualRange, viewport: VisualViewport): string {
  type Point = { x: number; y: number };
  const variables = { ...values, x: x[0] };
  const path: string[] = [];
  let evaluations = 0;
  let pen: string | null = null;
  const sample = (at: number): Point => {
    variables.x = at;
    return { x: at, y: ++evaluations <= 2048 ? curve(variables) : NaN };
  };
  const segment = (a: Point, b: Point) => {
    if ((a.y < y[0] && b.y < y[0]) || (a.y > y[1] && b.y > y[1])) { pen = null; return; }
    const clip = (point: Point): Point => {
      const cy = Math.max(y[0], Math.min(y[1], point.y));
      return { x: cy === point.y ? point.x : a.x + (b.x - a.x) * ((cy - a.y) / (b.y - a.y)), y: cy };
    };
    const from = clip(a), to = clip(b);
    if (!Number.isFinite(from.x) || !Number.isFinite(to.x)) { pen = null; return; }
    const start = `${viewport.px(from.x).toFixed(2)},${viewport.py(from.y).toFixed(2)}`;
    const end = `${viewport.px(to.x).toFixed(2)},${viewport.py(to.y).toFixed(2)}`;
    if (start === end) return;
    if (pen !== start) path.push(`M${start}`);
    path.push(`L${end}`);
    pen = end;
  };
  const refine = (a: Point, b: Point, depth: number) => {
    const middle = sample((a.x + b.x) / 2);
    if ([a.y, middle.y, b.y].every(Number.isFinite)) {
      const error = Math.abs(middle.y - (a.y / 2 + b.y / 2)) * viewport.scale;
      if (error <= 0.5) { segment(a, b); return; }
      if ([a, middle, b].every(point => point.y < y[0]) || [a, middle, b].every(point => point.y > y[1])) { pen = null; return; }
    } else if ([a.y, middle.y, b.y].every(value => !Number.isFinite(value))) { pen = null; return; }
    if (depth >= 8 || evaluations >= 2048) { pen = null; return; }
    refine(a, middle, depth + 1);
    refine(middle, b, depth + 1);
  };
  let previous = sample(x[0]);
  for (let index = 1; index <= VISUAL_SAMPLES && evaluations < 2048; index++) {
    const next = sample(x[0] + (x[1] - x[0]) * index / VISUAL_SAMPLES);
    refine(previous, next, 0);
    previous = next;
  }
  return path.join(" ");
}

/** CommonMark fences may be unfinished while streaming: don't render a half-built diagram. */
export function isClosedVisualFence(markdown: string, start?: number, end?: number): boolean {
  if (start === undefined || end === undefined) return false;
  const lines = markdown.slice(start, end).trimEnd().split("\n");
  const opener = /^ {0,3}(`{3,}|~{3,})[ \t]*pi-visual[ \t]*\r?$/i.exec(lines[0]);
  if (!opener || lines.length < 2) return false;
  const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(lines[lines.length - 1]);
  return !!closer && closer[1][0] === opener[1][0] && closer[1].length >= opener[1].length;
}
