/** A deliberately small numerical language. No JavaScript, property access or eval. */
export type VisualExpression = (variables: Readonly<Record<string, number>>) => number;

const FUNCTIONS: Readonly<Record<string, (value: number) => number>> = Object.freeze({
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log,
  log10: Math.log10, floor: Math.floor, ceil: Math.ceil,
});
const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({ pi: Math.PI, e: Math.E });
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
export const MAX_EXPRESSION_LENGTH = 160;
const MAX_NODES = 64;
const MAX_DEPTH = 16;

export function isVisualVariable(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(name)
    && !["x", "__proto__", "constructor", "prototype"].includes(name)
    && !hasOwn(FUNCTIONS, name) && !hasOwn(CONSTANTS, name);
}

/** Compile once; the resulting small expression is reused for every sample/drag. */
export function compileVisualExpression(source: unknown, names: readonly string[]): VisualExpression {
  if (typeof source === "number" && Number.isFinite(source)) return () => source;
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_EXPRESSION_LENGTH) {
    throw new Error("Invalid expression length");
  }
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/g) ?? [];
  const allowed = new Set(names);
  let position = 0;
  let nodes = 0;
  const node = (expression: VisualExpression): VisualExpression => {
    if (++nodes > MAX_NODES) throw new Error("Expression is too complex");
    return expression;
  };
  const parse = (minimum: number, depth: number): VisualExpression => {
    if (depth > MAX_DEPTH) throw new Error("Expression is too deep");
    const token = tokens[position++];
    let left: VisualExpression;
    if (token === "+" || token === "-") {
      // Exponentiation binds tighter than unary minus: -x^2 means -(x^2).
      const child = parse(25, depth + 1);
      left = node(token === "-" ? values => -child(values) : child);
    } else if (token === "(") {
      left = parse(0, depth + 1);
      if (tokens[position++] !== ")") throw new Error("Missing closing parenthesis");
    } else if (token && /^(?:\d|\.\d)/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error("Non-finite literal");
      left = node(() => value);
    } else if (token && hasOwn(FUNCTIONS, token)) {
      if (tokens[position++] !== "(") throw new Error("Function needs parentheses");
      const argument = parse(0, depth + 1);
      if (tokens[position++] !== ")") throw new Error("Function needs one argument");
      const fn = FUNCTIONS[token];
      left = node(values => fn(argument(values)));
    } else if (token && hasOwn(CONSTANTS, token)) {
      const value = CONSTANTS[token];
      left = node(() => value);
    } else if (token && allowed.has(token)) {
      left = node(values => hasOwn(values, token) ? values[token] : NaN);
    } else {
      throw new Error("Unknown expression token");
    }
    while (position < tokens.length) {
      const operator = tokens[position];
      const precedence = operator === "+" || operator === "-" ? 10
        : operator === "*" || operator === "/" ? 20 : operator === "^" ? 30 : -1;
      if (precedence < minimum) break;
      position++;
      const right = parse(operator === "^" ? precedence : precedence + 1, depth + 1);
      const previous = left;
      switch (operator) {
        case "+": left = node(values => previous(values) + right(values)); break;
        case "-": left = node(values => previous(values) - right(values)); break;
        case "*": left = node(values => previous(values) * right(values)); break;
        case "/": left = node(values => previous(values) / right(values)); break;
        case "^": left = node(values => previous(values) ** right(values)); break;
      }
    }
    return left;
  };
  const expression = parse(0, 0);
  if (position !== tokens.length) throw new Error("Unexpected expression token");
  return expression;
}
