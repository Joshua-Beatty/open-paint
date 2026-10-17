import { PHOSPHOR } from "../icons/icon-set";

/**
 * The icons of the tool options bar, as icon data (`iconShape`): icons from the app's icon set, and
 * 16 x 16 path data stroked in the text color at the set's weight where the set has no icon (the
 * hatch patterns, dash styles, line caps, edge rendering, gamma and single-layer sampling). A
 * drop-down shows its chosen value's icon, or the field's own icon when the values have none, so
 * each control is named by an icon and its tooltip rather than a heading.
 */

/** Round dots, each a zero-length stroke that the round line cap draws as a disc. */
function dots(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y]) => `M${x} ${y}h.01`).join("");
}

function grid(xs: readonly number[], ys: readonly number[]): Array<[number, number]> {
  return ys.flatMap((y) => xs.map((x): [number, number] => [x, y]));
}

/**
 * A filled square inside the outline square, a set-width gap apart: filled and outlined. The set's
 * bold weight has no two-tone square, so this adds a square to the outline's 256 unit path.
 */
const FILLED_OUTLINED_SQUARE = `${PHOSPHOR.square}M180,76H76V180H180Z`;

/** The icons of the on and off values of the options bar's on/off drop-downs, by setting name. */
export const BOOLEAN_ICONS: Readonly<
  Record<string, { readonly on: string; readonly off: string }>
> = {
  // A smooth edge for antialiased rendering, a stair-stepped edge for aliased (pixelated).
  antialiasing: {
    on: "M2.5 13.5C2.5 7 7 2.5 13.5 2.5",
    off: "M2.5 13.5v-3h3v-3h3v-3h3v-2h2",
  },
  "brush.pressure": { on: PHOSPHOR.pencilSimpleLine, off: PHOSPHOR.pencilSimpleSlash },
  // A single sheet while the active layer is sampled, a stack of sheets while the whole image is.
  sampleAllLayers: { off: "M2 8.5l6-3 6 3-6 3z", on: PHOSPHOR.stack },
  "gradient.alphaOnly": { off: PHOSPHOR.palette, on: PHOSPHOR.checkerboard },
};

/** The four corner marks of a selection rectangle. */
const SELECTION_CORNERS = "M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3";

/** The icon of each option field, by setting name under `tools.`, for drop-downs and number boxes. */
export const FIELD_ICONS: Readonly<Record<string, string>> = {
  "selection.drawMode": PHOSPHOR.frameCorners,
  "selection.drawUnits": PHOSPHOR.ruler,
  "move.resampling": PHOSPHOR.arrowsOutSimple,
  gammaMode: "M2.5 2.5v11h11M4 12C7 12 9.5 9 12.5 3",
  floodMode: PHOSPHOR.drop,
  toleranceAlphaMode: PHOSPHOR.checkerboard,
  blendMode: PHOSPHOR.intersect,
  sampleMode: PHOSPHOR.crosshair,
  "colorPicker.clickBehavior": PHOSPHOR.cursor,
  "recolor.samplingMode": PHOSPHOR.eyedropperSample,
  "gradient.type": PHOSPHOR.gradient,
  "gradient.repeatType": PHOSPHOR.repeat,
  "text.fontSizeMetric": PHOSPHOR.textAa,
  "text.renderingMode": PHOSPHOR.textAUnderline,
  "shapes.curveType": PHOSPHOR.path,
};

/** Swapping two values: the selection's width and height, or the primary and secondary colors. */
export const SWAP_ICON = PHOSPHOR.arrowsLeftRight;

/** The icons of individual values of a choice field, by setting name and stored value. */
export const OPTION_ICONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "selection.combineMode": {
    Replace: PHOSPHOR.selection,
    Union: PHOSPHOR.uniteSquare,
    Exclude: PHOSPHOR.subtractSquare,
    Intersect: PHOSPHOR.intersectSquare,
    Xor: PHOSPHOR.excludeSquare,
  },
  "brush.type": { Circle: PHOSPHOR.circle, Square: PHOSPHOR.square },
  // A smooth wave for a smoothed path, a zigzag for the raw input.
  inputSmoothing: { Enabled: PHOSPHOR.waveSine, Disabled: "M2 11l3-6 3 6 3-6 3 6" },
  // The Fill drop-down: Solid, then each hatch pattern drawn as its swatch (TL-OPT-FILL).
  "brush.fillType": {
    Solid: PHOSPHOR.squareFill,
    Horizontal: "M2.5 4h11M2.5 8h11M2.5 12h11",
    Vertical: "M4 2.5v11M8 2.5v11M12 2.5v11",
    ForwardDiagonal: "M2.5 2.5l11 11M2.5 8.5l5 5M8.5 2.5l5 5",
    BackwardDiagonal: "M13.5 2.5l-11 11M13.5 8.5l-5 5M7.5 2.5l-5 5",
    Cross: "M2.5 5h11M2.5 11h11M5 2.5v11M11 2.5v11",
    DiagonalCross: "M2.5 2.5l11 11M13.5 2.5l-11 11M8 2.5 13.5 8 8 13.5 2.5 8z",
    Percent50: dots([...grid([3, 7, 11], [3, 7, 11]), ...grid([5, 9, 13], [5, 9, 13])]),
    DottedGrid: dots([
      ...grid([3, 5.5, 8, 10.5, 13], [3, 8, 13]),
      ...grid([3, 8, 13], [5.5, 10.5]),
    ]),
  },
  // A selection's corner marks around a smooth or a stepped edge: the clip at the selection edge.
  "selection.renderingQuality": {
    Aliased: `${SELECTION_CORNERS}M5 11V9h2V7h2V5h2`,
    HighQualityAntialiased: `${SELECTION_CORNERS}M5 11c0-3.3 2.7-6 6-6`,
  },
  "text.alignment": {
    Left: PHOSPHOR.textAlignLeft,
    Center: PHOSPHOR.textAlignCenter,
    Right: PHOSPHOR.textAlignRight,
  },
  "shapes.drawType": {
    Outline: PHOSPHOR.square,
    Interior: PHOSPHOR.squareFill,
    Both: FILLED_OUTLINED_SQUARE,
  },
  "pen.dashStyle": {
    Solid: "M2 8h12",
    Dashes: "M2 8h3M6.5 8h3M11 8h3",
    Dotted: dots([
      [2, 8],
      [5, 8],
      [8, 8],
      [11, 8],
      [14, 8],
    ]),
    DashDot: "M2 8h4.5M9 8h.01M11.5 8h2.5",
    DashDotDot: "M2 8h3.5M8 8h.01M10.5 8h.01M13 8h1",
  },
  "pen.startCap": {
    Flat: "M3 8h11M3 5.5v5",
    Arrow: "M2.5 8H14M6.5 4.5 2.5 8l4 3.5",
    ArrowFilled: "M3 8h11M6.5 4.5 2.5 8l4 3.5zM5 7v2",
    Rounded: "M5.5 8H14M5.5 5.5a2.5 2.5 0 0 0 0 5",
  },
  "pen.endCap": {
    Flat: "M2 8h11M13 5.5v5",
    Arrow: "M2 8h11.5M9.5 4.5l4 3.5-4 3.5",
    ArrowFilled: "M2 8h11M9.5 4.5l4 3.5-4 3.5zM11 7v2",
    Rounded: "M2 8h8.5M10.5 5.5a2.5 2.5 0 0 1 0 5",
  },
};
