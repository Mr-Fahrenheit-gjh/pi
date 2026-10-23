"use client";

import { createContext, memo, useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useInlineVisuals } from "@/hooks/useInlineVisuals";
import { clampVisualParameter, formatVisualNumber, parseInlineVisual, sampleVisualCurve, visualTicks, visualViewport, type InlineVisual, type VisualPosition, type VisualShape } from "@/lib/inline-visual";
import styles from "./InlineVisual.module.css";

export type VisualValueCache = Map<string, Record<string, number>>;
const SessionValuesContext = createContext<Map<string, VisualValueCache> | null>(null);
const MessageValuesContext = createContext<VisualValueCache | null>(null);

/** Live replies and saved-message views are separate React trees in ChatWindow. */
export function InlineVisualSessionState({ children }: { children: ReactNode }) {
  const values = useRef(new Map<string, VisualValueCache>());
  return <SessionValuesContext.Provider value={values.current}>{children}</SessionValuesContext.Provider>;
}
export function InlineVisualMessageState({ identity, children }: { identity: string; children: ReactNode }) {
  const session = useContext(SessionValuesContext);
  const values = useMemo(() => {
    const cached = session?.get(identity);
    if (cached) return cached;
    const cache: VisualValueCache = new Map();
    session?.set(identity, cache);
    if (session && session.size > 32) session.delete(session.keys().next().value!);
    return cache;
  }, [session, identity]);
  return <MessageValuesContext.Provider value={values}>{children}</MessageValuesContext.Provider>;
}
export function useInlineVisualValues(): VisualValueCache {
  const shared = useContext(MessageValuesContext);
  const local = useRef<VisualValueCache>(new Map());
  return shared ?? local.current;
}

interface Props {
  source: string;
  ready: boolean;
  isStreaming: boolean;
  cache: VisualValueCache;
  cacheKey: string;
}
const color = (name: string) => `var(--visual-${name})`;

/** Completed data can render before the surrounding assistant reply finishes. */
export const InlineVisualBlock = memo(function InlineVisualBlock({ source, ready, isStreaming, cache, cacheKey }: Props) {
  const enabled = useInlineVisuals();
  const { t } = useI18n();
  const parsed = useMemo(() => {
    if (!enabled || !ready) return null;
    try { return parseInlineVisual(source); } catch { return null; }
  }, [enabled, ready, source]);
  if (!enabled) return <div className={styles.status} data-visual-state="disabled">{t("visual.disabled")}</div>;
  if (!ready) return <div className={styles.status} data-visual-state={isStreaming ? "pending" : "invalid"} role="status">{t(isStreaming ? "visual.pending" : "visual.incomplete")}</div>;
  if (!parsed) return <div className={styles.status} data-visual-state="invalid" role="status">{t("visual.invalid")}</div>;
  return <VisualFigure key={source} diagram={parsed} cache={cache} cacheKey={cacheKey} />;
});

function VisualFigure({ diagram, cache, cacheKey }: { diagram: InlineVisual; cache: VisualValueCache; cacheKey: string }) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const id = useId().replace(/:/g, "");
  const clipId = `${id}-clip`;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; name: string } | null>(null);
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(diagram.parameters.map(parameter => [parameter.name,
    clampVisualParameter(parameter, cache.get(cacheKey)?.[parameter.name] ?? parameter.value),
  ])));
  const viewport = useMemo(() => visualViewport(diagram.x, diagram.y), [diagram]);
  const curves = useMemo(() => diagram.curves.map(curve => ({ ...curve, path: sampleVisualCurve(curve.expression, values, diagram.x, diagram.y, viewport) })), [diagram, values, viewport]);
  const position = (at: VisualPosition) => {
    const x = at[0](values);
    const y = at[1](values);
    const point = { x: viewport.px(x), y: viewport.py(y) };
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 1e6 && Math.abs(point.y) < 1e6 ? point : null;
  };
  const update = (name: string, value: number) => {
    const parameter = diagram.parameters.find(item => item.name === name);
    if (!parameter) return;
    const nextValue = clampVisualParameter(parameter, value);
    setValues(previous => {
      if (previous[name] === nextValue) return previous;
      const next = { ...previous, [name]: nextValue };
      // The chat-local cache survives message_end and the final markdown parse, not reloads.
      cache.set(cacheKey, next);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      return next;
    });
  };
  const startDrag = (event: PointerEvent<SVGGElement>, name: string) => {
    if (event.button !== 0 || drag.current || !svgRef.current) return;
    drag.current = { pointerId: event.pointerId, name };
    svgRef.current.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== drag.current?.pointerId) return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    update(drag.current.name, viewport.xAt(point.x));
    event.stopPropagation();
  };
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== drag.current?.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  };
  const keyMove = (event: KeyboardEvent<SVGGElement>, name: string) => {
    const parameter = diagram.parameters.find(item => item.name === name)!;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    event.stopPropagation();
    update(name, direction ? values[name] + direction * parameter.step : event.key === "Home" ? parameter.min : parameter.max);
  };
  const shapeElements = diagram.shapes.map((shape: VisualShape, index) => {
    const stroke = color(shape.color);
    if (shape.type === "point") {
      const point = position(shape.at);
      if (!point) return null;
      const parameter = diagram.parameters.find(item => item.name === shape.drag);
      return <g key={index} transform={`translate(${point.x} ${point.y})`} data-visual-point={shape.label || String(index)}
        className={parameter ? styles.draggable : undefined} role={parameter ? "slider" : undefined} tabIndex={parameter ? 0 : undefined}
        aria-label={parameter ? `${shape.label || "P"}: ${parameter.name}` : undefined} aria-valuemin={parameter?.min} aria-valuemax={parameter?.max}
        aria-valuenow={parameter ? values[parameter.name] : undefined}
        onPointerDown={parameter ? event => startDrag(event, parameter.name) : undefined}
        onKeyDown={parameter ? event => keyMove(event, parameter.name) : undefined}>
        {parameter && <circle r="16" fill="transparent" />}
        <circle r="6" fill={stroke} stroke="var(--bg-panel)" strokeWidth="2" />
        {shape.label && <text x="11" y="-10" fill={stroke}>{shape.label}</text>}
      </g>;
    }
    if (shape.type === "segment") {
      const from = position(shape.from), to = position(shape.to);
      if (!from || !to) return null;
      return <g key={index}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={stroke} strokeWidth="2" markerEnd={shape.arrow ? `url(#${id}-${shape.color})` : undefined} />
        {shape.label && <text x={(from.x + to.x) / 2 + 6} y={(from.y + to.y) / 2 - 7} fill={stroke}>{shape.label}</text>}</g>;
    }
    if (shape.type === "circle") {
      const center = position(shape.center), radius = shape.radius(values) * viewport.scale;
      if (!center || !Number.isFinite(radius) || radius < 0 || radius > 1e6) return null;
      return <g key={index}><circle cx={center.x} cy={center.y} r={radius} fill="none" stroke={stroke} strokeWidth="2" />
        {shape.label && <text x={center.x + 8} y={center.y - 8} fill={stroke}>{shape.label}</text>}</g>;
    }
    const points = shape.points.map(position);
    if (points.some(point => point === null)) return null;
    return <g key={index}><polygon points={points.map(point => `${point!.x},${point!.y}`).join(" ")} fill={stroke} fillOpacity=".1" stroke={stroke} strokeWidth="2" />
      {shape.label && <text x={points[0]!.x + 8} y={points[0]!.y - 8} fill={stroke}>{shape.label}</text>}</g>;
  });
  const unavailable = shapeElements.some(shape => shape === null) || curves.some(curve => !curve.path) || diagram.readouts.some(readout => !Number.isFinite(readout.expression(values)));
  const xAxis = viewport.py(Math.max(diagram.y[0], Math.min(diagram.y[1], 0)));
  const yAxis = viewport.px(Math.max(diagram.x[0], Math.min(diagram.x[1], 0)));
  return <figure className={styles.figure} data-dark={isDark} data-visual-state="ready" aria-label={diagram.title || t("visual.title")}>
    <figcaption className={styles.heading}>{diagram.title || t("visual.title")}</figcaption>
    <svg ref={svgRef} className={styles.plot} viewBox="0 0 640 364" role="group" aria-label={diagram.title || t("visual.title")}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }}>
      <defs>
        <clipPath id={clipId}><rect x={viewport.left} y={viewport.top} width={viewport.width} height={viewport.height} /></clipPath>
        {["blue", "orange", "green", "purple", "red"].map(name => <marker key={name} id={`${id}-${name}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 1L7 4L0 7" fill="none" stroke={color(name)} strokeWidth="1.4" /></marker>)}
      </defs>
      <g className={styles.grid}>
        {visualTicks(diagram.x).map(value => <line key={`x${value}`} x1={viewport.px(value)} x2={viewport.px(value)} y1={viewport.top} y2={viewport.top + viewport.height} />)}
        {visualTicks(diagram.y).map(value => <line key={`y${value}`} x1={viewport.left} x2={viewport.left + viewport.width} y1={viewport.py(value)} y2={viewport.py(value)} />)}
      </g>
      <g className={styles.axes}><line x1={viewport.left} x2={viewport.left + viewport.width} y1={xAxis} y2={xAxis} /><line x1={yAxis} x2={yAxis} y1={viewport.top} y2={viewport.top + viewport.height} /></g>
      <g className={styles.tickLabels}>
        {visualTicks(diagram.x).map(value => <text key={`x${value}`} x={viewport.px(value)} y={viewport.top + viewport.height + 20} textAnchor="middle">{formatVisualNumber(value)}</text>)}
        {visualTicks(diagram.y).map(value => <text key={`y${value}`} x={viewport.left - 10} y={viewport.py(value) + 4} textAnchor="end">{formatVisualNumber(value)}</text>)}
        <text x={viewport.left + viewport.width + 16} y={xAxis + 4}>x</text><text x={yAxis + 8} y={viewport.top - 8}>y</text>
      </g>
      <g clipPath={`url(#${clipId})`}>
        {curves.map((curve, index) => <path key={index} data-visual-curve={index} d={curve.path} fill="none" stroke={color(curve.color)} strokeWidth="2.5" />)}
        {shapeElements}
      </g>
    </svg>
    {curves.some(curve => curve.label) && <div className={styles.legend}>{curves.map((curve, index) => curve.label && <span key={index} style={{ color: color(curve.color) }}>━ {curve.label}</span>)}</div>}
    {diagram.parameters.length > 0 && <div className={styles.parameters}>
      {diagram.parameters.map(parameter => <label key={parameter.name} className={styles.parameter}><span>{parameter.name} <output>{formatVisualNumber(values[parameter.name])}</output></span>
        <input type="range" aria-label={parameter.name} min={parameter.min} max={parameter.max} step={parameter.step} value={values[parameter.name]} onChange={event => update(parameter.name, Number(event.target.value))} />
      </label>)}
      <button type="button" onClick={() => {
        const initial = Object.fromEntries(diagram.parameters.map(parameter => [parameter.name, parameter.value]));
        cache.set(cacheKey, initial); setValues(initial);
      }}>{t("visual.reset")}</button>
    </div>}
    {diagram.readouts.length > 0 && <div className={styles.readouts}>{diagram.readouts.map((readout, index) => <span key={index}>{readout.label} <output data-visual-readout={readout.label}>{formatVisualNumber(readout.expression(values))}</output></span>)}</div>}
    {unavailable && <p className={styles.note} role="status">{t("visual.undefined")}</p>}
  </figure>;
}
