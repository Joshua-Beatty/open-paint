import type { ShapeDescriptor } from "@openpaint/extension-api";
import { type ShapeBox, type ShapeParams, shapeRings } from "@openpaint/tools";

/** The icon grid, and the margin that keeps the 1.5 px outline (`.prop-icon`) inside it. */
const ICON_SIZE = 16;
const ICON_MARGIN = 2;

/** The box the outline is traced in before it is fitted to the icon; large enough for smooth arcs. */
const TRACE_SIZE = 100;

/** A path token, as `substituteShapePath` reads it: `{name}`, `{name.x}`, `{1-name.y}`. */
const TOKEN = /\{(?:1-)?([A-Za-z][A-Za-z0-9]*)(?:\.([xy]))?\}/g;

/**
 * Where the built-in property handles start when a shape is drawn (the callout's tail tip below
 * its body). Any other plain token is drawn at the middle of the box.
 */
const HANDLE_STARTS: Readonly<Record<string, number>> = { tailX: 0.25, tailY: 1.25 };

/** A value for every token of `path`: lengths (`.x`, `.y`) at a quarter of the shorter side. */
function iconParams(path: string, box: ShapeBox): ShapeParams {
  const params: Record<string, number> = {};
  for (const [, name, axis] of path.matchAll(TOKEN)) {
    if (name === undefined) continue;
    params[name] =
      axis === undefined ? (HANDLE_STARTS[name] ?? 0.5) : Math.min(box.width, box.height) / 4;
  }
  return params;
}

function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const cache = new Map<string, string>();

/**
 * The 16 px outline icon of a shape, drawn from its own geometry (TL-SHAPE-02): the path is traced
 * at the shape's aspect ratio with its handles at their starting values, then fitted and centered
 * in the icon, tail and all. A newly registered shape gets its icon this way with no icon data.
 */
export function shapeIcon(shape: ShapeDescriptor): string {
  const key = `${shape.geometry.path}|${shape.geometry.aspect ?? 1}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const aspect = shape.geometry.aspect ?? 1;
  const box: ShapeBox =
    aspect >= 1
      ? { x: 0, y: 0, width: TRACE_SIZE, height: TRACE_SIZE / aspect }
      : { x: 0, y: 0, width: TRACE_SIZE * aspect, height: TRACE_SIZE };
  const rings = shapeRings(shape.geometry.path, box, iconParams(shape.geometry.path, box));
  const points = rings.flat();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  const scale = (ICON_SIZE - 2 * ICON_MARGIN) / Math.max(width, height, Number.EPSILON);
  const offsetX = (ICON_SIZE - width * scale) / 2;
  const offsetY = (ICON_SIZE - height * scale) / 2;
  const closed = /z/i.test(shape.geometry.path);
  const icon = rings
    .map((ring) => {
      const coordinates = ring.map(
        (point) =>
          `${format(offsetX + (point.x - left) * scale)} ${format(offsetY + (point.y - top) * scale)}`,
      );
      return `M${coordinates.join("L")}${closed ? "Z" : ""}`;
    })
    .join("");
  cache.set(key, icon);
  return icon;
}
