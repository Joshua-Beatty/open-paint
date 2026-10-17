import { type CurveList, type CurvePoint, curveLut, curveValueAt } from "@openpaint/effects";
import { useTranslation } from "@openpaint/i18n/react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
  type CurveEditState,
  type CurveKey,
  curveAt,
  editableKeys,
  modeKeys,
} from "./curves-model";

/** The plot's size before the first measurement, in CSS pixels. */
const DEFAULT_SIZE = 256;
/** The minimum size of the plot, in CSS pixels. */
const MIN_SIZE = 64;
/** The dashed grid lines at these fractions (ADJ-CURVES-UI-04). */
const GRID_FRACTIONS = [0.25, 0.5, 0.75];
/** Guide lines are the foreground at alpha 128 (grid) and 96 (crosshair), of 255 (ADJ-CURVES-UI-04). */
const GRID_OPACITY = 128 / 255;
const CROSSHAIR_OPACITY = 96 / 255;
/** An unchecked curve is drawn at alpha 192 (ADJ-CURVES-UI-04). */
const UNCHECKED_OPACITY = 192 / 255;

const CURVE_COLOR: Readonly<Record<CurveKey, string>> = {
  luminosity: "var(--curves-luminosity)",
  red: "var(--curves-red)",
  green: "var(--curves-green)",
  blue: "var(--curves-blue)",
};

/** Each drawn curve's output level at the 256 input levels, by its point list (lists are immutable). */
const LEVELS = new WeakMap<CurveList, Float32Array>();

/**
 * The output levels 0..255 of a curve at each input level, from its table. Cached, so a frame that
 * redraws the plot recomputes only the curve being dragged.
 */
function curveLevels(list: CurveList): Float32Array {
  const cached = LEVELS.get(list);
  if (cached !== undefined) return cached;
  const lut = curveLut(list);
  // The table holds outputs on 0..1, and the plot's y axis is in levels 0..255.
  const levels = Float32Array.from({ length: 256 }, (_, x) => curveValueAt(lut, x / 255) * 255);
  LEVELS.set(list, levels);
  return levels;
}

export interface CurvesPlotProps {
  readonly state: CurveEditState;
  /** The point under the pointer, highlighted (ADJ-CURVES-UI-07). */
  readonly hover?: { readonly key: CurveKey; readonly x: number };
  /** The pointer's curve position, for the crosshair (ADJ-CURVES-UI-04). */
  readonly pointer?: CurvePoint;
  readonly onPress: (point: CurvePoint) => void;
  readonly onMove: (point: CurvePoint) => void;
  readonly onRelease: () => void;
  readonly onRemove: (point: CurvePoint) => void;
  readonly onLeave: () => void;
}

/**
 * The curve editor of the Curves dialog (ADJ-CURVES-UI-04 to -09). It draws every curve of the
 * visible mode through its control points and reports the pointer in curve units. The editing
 * rules live in `curves-model.ts`, and the dialog applies them.
 */
export function CurvesPlot({
  state,
  hover,
  pointer,
  onPress,
  onMove,
  onRelease,
  onRemove,
  onLeave,
}: CurvesPlotProps) {
  const t = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  useEffect(() => {
    const element = wrapRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setSize(Math.max(MIN_SIZE, Math.floor(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const span = size - 1;
  const plotX = (x: number) => (x * span) / 255;
  const plotY = (y: number) => span - (y * span) / 255;
  const keys = modeKeys(state.mode);
  const editable = editableKeys(state);
  const ordered = [
    ...keys.filter((key) => !editable.includes(key)),
    ...keys.filter((key) => editable.includes(key)),
  ];

  const pointFrom = (event: ReactPointerEvent<SVGSVGElement>): CurvePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return curveAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  };

  return (
    <div className="curves-plot" ref={wrapRef}>
      <svg
        className="curves-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={t("curves.plot")}
        onPointerDown={(event) => {
          if (event.button === 0) {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onPress(pointFrom(event));
          } else if (event.button === 2) {
            onRemove(pointFrom(event));
          }
        }}
        onPointerMove={(event) => onMove(pointFrom(event))}
        onPointerUp={(event) => {
          if (event.button === 0) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            onRelease();
          }
        }}
        onPointerCancel={onRelease}
        onPointerLeave={onLeave}
        onContextMenu={(event) => event.preventDefault()}
      >
        <rect
          className="curves-background"
          x={0.5}
          y={0.5}
          width={span}
          height={span}
          style={{ fill: "var(--panel-background)" }}
          stroke="currentColor"
        />
        {GRID_FRACTIONS.map((fraction) => (
          <g
            key={fraction}
            stroke="currentColor"
            strokeDasharray="3 3"
            strokeOpacity={GRID_OPACITY}
          >
            <line x1={plotX(fraction * 255)} y1={0} x2={plotX(fraction * 255)} y2={span} />
            <line x1={0} y1={plotY(fraction * 255)} x2={span} y2={plotY(fraction * 255)} />
          </g>
        ))}
        <line
          x1={0}
          y1={span}
          x2={span}
          y2={0}
          stroke="currentColor"
          strokeDasharray="3 3"
          strokeOpacity={GRID_OPACITY}
        />
        {pointer !== undefined && (
          <g stroke="currentColor" strokeOpacity={CROSSHAIR_OPACITY}>
            <line x1={plotX(pointer[0])} y1={0} x2={plotX(pointer[0])} y2={span} />
            <line x1={0} y1={plotY(pointer[1])} x2={span} y2={plotY(pointer[1])} />
          </g>
        )}
        {ordered.map((key) => {
          const checked = editable.includes(key);
          const color = CURVE_COLOR[key];
          const levels = curveLevels(state.lists[key]);
          const line = Array.from(
            { length: 256 },
            (_, x) => `${plotX(x)},${plotY(levels[x] ?? 0)}`,
          ).join(" ");
          return (
            <g key={key}>
              <polyline
                points={line}
                fill="none"
                style={{ stroke: color }}
                strokeWidth={checked ? 2 : 1}
                strokeOpacity={checked ? 1 : UNCHECKED_OPACITY}
              />
              {state.lists[key].map(([x, y]) => {
                const isHover = hover !== undefined && hover.key === key && hover.x === x;
                const radius = isHover ? 4 : checked ? 3 : 2;
                return (
                  <circle
                    key={x}
                    cx={plotX(x)}
                    cy={plotY(y)}
                    r={radius}
                    style={{
                      fill: isHover ? "#ffffff" : color,
                      stroke: isHover ? color : "none",
                    }}
                    strokeWidth={isHover ? 1.5 : 0}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
