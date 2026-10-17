import { EXTENSION_API_MAJOR, type ShapeDescriptor, ShapeRegistry } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { definePropertySchema, type PropertySchema } from "@openpaint/properties";
import { regularPolygon, starPolygon } from "@openpaint/tools";

/** The stored shape type, a name in the registry (TL-SHAPE-01). */
export const SHAPE_SETTING_PATH = "tools.shapes.shape";

/** The shape a fresh install draws: Rectangle, the first in Basic (TL-SHAPE-02). */
export const DEFAULT_SHAPE_ID = "rectangle";

/** The five-point star's inner radius ratio (TL-SHAPE-02). */
const STAR_INNER_RATIO = 0.381966;

/** The Corner size setting, which only the rounded shapes show (TL-SHAPE-02). */
const CORNER_SETTINGS: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "double",
      key: "shapes.radius",
      label: "settings.field.tool.radius" as MessageId,
      defaultValue: 10,
      min: 0,
      max: 2000,
    },
  ],
});

const NO_SETTINGS: PropertySchema = definePropertySchema({ properties: [] });

/**
 * The rounded corners of a rectangle, with the corner radius in pixels. The `.x` and `.y` tokens
 * keep each corner circular. The arcs run clockwise on screen.
 */
const ROUNDED_RECTANGLE = [
  "M {radius.x},0 L {1-radius.x},0 A {radius.x} {radius.y} 0 0 1 1,{radius.y}",
  "L 1,{1-radius.y} A {radius.x} {radius.y} 0 0 1 {1-radius.x},1 L {radius.x},1",
  "A {radius.x} {radius.y} 0 0 1 0,{1-radius.y} L 0,{radius.y}",
  "A {radius.x} {radius.y} 0 0 1 {radius.x},0 Z",
].join(" ");

/**
 * The rounded rectangle body with a tail below its bottom edge. The tail's tip is the `tailX` and
 * `tailY` property handle, in unit coordinates, and its base spans 0.15 to 0.35 of the width.
 */
const CALLOUT = [
  "M {radius.x},0 L {1-radius.x},0 A {radius.x} {radius.y} 0 0 1 1,{radius.y}",
  "L 1,{1-radius.y} A {radius.x} {radius.y} 0 0 1 {1-radius.x},1 L 0.35,1",
  "L {tailX},{tailY} L 0.15,1 L {radius.x},1",
  "A {radius.x} {radius.y} 0 0 1 0,{1-radius.y} L 0,{radius.y}",
  "A {radius.x} {radius.y} 0 0 1 {radius.x},0 Z",
].join(" ");

/** A right-pointing block arrow: a shaft over the left 60 % and a head over the right 40 %. */
const ARROW = "M 0,0.25 L 0.6,0.25 L 0.6,0 L 1,0.5 L 0.6,1 L 0.6,0.75 L 0,0.75 Z";

/** A heart made of four cubic curves, its point at the bottom center. */
const HEART = [
  "M 0.5,1 C 0.5,1 0,0.62 0,0.3 C 0,0.12 0.13,0 0.28,0",
  "C 0.39,0 0.46,0.06 0.5,0.14 C 0.54,0.06 0.61,0 0.72,0",
  "C 0.87,0 1,0.12 1,0.3 C 1,0.62 0.5,1 0.5,1 Z",
].join(" ");

const pentagon = regularPolygon(5, -90);
const hexagon = regularPolygon(6, -90);
const star = starPolygon(5, STAR_INNER_RATIO, -90);

/**
 * The built-in shapes in picker order (TL-SHAPE-02). Each outline is a unit-square path, with
 * property handles as named tokens. Line / Curve is listed, but it opens the Line / Curve tool.
 */
const BUILT_IN_SHAPES: readonly ShapeDescriptor[] = [
  {
    id: "line",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.line" as MessageId,
    category: "lines",
    geometry: { path: "M 0,1 L 1,0", fillRule: "nonzero" },
    settings: NO_SETTINGS,
    tool: "lineCurve",
  },
  {
    id: "rectangle",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.rectangle" as MessageId,
    category: "basic",
    geometry: { path: "M 0,0 L 1,0 L 1,1 L 0,1 Z", fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
  {
    id: "roundedRectangle",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.roundedRectangle" as MessageId,
    category: "basic",
    geometry: { path: ROUNDED_RECTANGLE, fillRule: "nonzero" },
    settings: CORNER_SETTINGS,
    handles: ["radius"],
  },
  {
    id: "ellipse",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.ellipse" as MessageId,
    category: "basic",
    geometry: {
      path: "M 0,0.5 A 0.5 0.5 0 0 1 1,0.5 A 0.5 0.5 0 0 1 0,0.5 Z",
      fillRule: "nonzero",
    },
    settings: NO_SETTINGS,
  },
  {
    id: "diamond",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.diamond" as MessageId,
    category: "basic",
    geometry: { path: "M 0.5,0 L 1,0.5 L 0.5,1 L 0,0.5 Z", fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
  {
    id: "triangle",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.triangle" as MessageId,
    category: "basic",
    geometry: { path: "M 0.5,0 L 1,1 L 0,1 Z", fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
  {
    id: "rightTriangle",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.rightTriangle" as MessageId,
    category: "basic",
    geometry: { path: "M 0,0 L 0,1 L 1,1 Z", fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
  {
    id: "pentagon",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.pentagon" as MessageId,
    category: "polygons",
    geometry: { path: pentagon.path, fillRule: "nonzero", aspect: pentagon.aspect },
    settings: NO_SETTINGS,
  },
  {
    id: "hexagon",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.hexagon" as MessageId,
    category: "polygons",
    geometry: { path: hexagon.path, fillRule: "nonzero", aspect: hexagon.aspect },
    settings: NO_SETTINGS,
  },
  {
    id: "star",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.star" as MessageId,
    category: "polygons",
    geometry: { path: star.path, fillRule: "nonzero", aspect: star.aspect },
    settings: NO_SETTINGS,
  },
  {
    id: "arrow",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.arrow" as MessageId,
    category: "arrows",
    geometry: { path: ARROW, fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
  {
    id: "callout",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.callout" as MessageId,
    category: "callouts",
    geometry: { path: CALLOUT, fillRule: "nonzero" },
    settings: CORNER_SETTINGS,
    handles: ["radius", "tail"],
  },
  {
    id: "heart",
    apiVersion: EXTENSION_API_MAJOR,
    label: "shape.heart" as MessageId,
    category: "symbols",
    geometry: { path: HEART, fillRule: "nonzero" },
    settings: NO_SETTINGS,
  },
];

/** The shape registry of the Shapes tool and its picker (EXT-08-02, TL-FRAME-07). */
export const SHAPE_REGISTRY: ShapeRegistry = (() => {
  const registry = new ShapeRegistry();
  for (const shape of BUILT_IN_SHAPES) registry.register(shape);
  return registry;
})();

/** The shapes the Shapes tool draws, in picker order. The shapes that open a tool are left out. */
export const DRAWABLE_SHAPES: readonly ShapeDescriptor[] = BUILT_IN_SHAPES.filter(
  (shape) => shape.tool === undefined,
);

/** The shape a stored shape type names, if the Shapes tool draws it. */
export function drawableShapeOf(stored: unknown): ShapeDescriptor | undefined {
  const name =
    typeof stored === "object" && stored !== null ? (stored as { name?: unknown }).name : undefined;
  return DRAWABLE_SHAPES.find((shape) => shape.id === name);
}

/** The drawable shape a stored shape type names, or the default shape when it names none. */
export function drawableShapeOrDefault(stored: unknown): ShapeDescriptor {
  const shape = drawableShapeOf(stored) ?? drawableShapeOf({ name: DEFAULT_SHAPE_ID });
  if (shape === undefined)
    throw new Error(`The default shape "${DEFAULT_SHAPE_ID}" is not registered.`);
  return shape;
}
