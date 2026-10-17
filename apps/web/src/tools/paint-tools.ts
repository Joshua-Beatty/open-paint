import {
  type ColorRgba8,
  type Document,
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rect,
  rectContainsRect,
  type Surface,
  type TransformResampler,
  translateRect,
  unionRects,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import type {
  ToolDescriptor,
  ToolPointerEvent,
  ToolRuntime,
  ToolViewState,
} from "@openpaint/extension-api";
import type { MessageId, Translate } from "@openpaint/i18n";
import {
  type ColorSettings,
  PRIMARY_COLOR_PATH,
  readStoredColor,
  SECONDARY_COLOR_PATH,
} from "../colors/use-colors";
import {
  type CloneSource,
  cloneAnchorOf,
  cloneSourceMarker,
  readCloneSource,
  setCloneAnchor,
} from "./clone-source";
import { colorPickerToolRuntime } from "./color-picker-tools";
import { BRUSH_POINTER_CURSOR, CLONE_ANCHOR_CURSOR, CROSSHAIR_CURSOR } from "./cursors";
import { EngineStroke } from "./engine-stroke";
import type { EngineStrokeChannel } from "./engine-strokes";
import type { GradientLanes } from "./gradient-tiles";
import { gradientToolRuntime } from "./gradient-tools";
import { lineCurveToolRuntime } from "./line-curve-tools";
import {
  cropCoverage,
  cropSurface,
  type LiveCanvas,
  type LivePainter,
  livePainterFor,
} from "./live-stroke";
import { paintBucketToolRuntime } from "./paint-bucket-tools";
import {
  blendValue,
  brushOptionsFor,
  type StrokePoint,
  type StrokeSpec,
  selectionCoverage,
  strokeReach,
  strokeRegion,
  type ToolRead,
} from "./paint-stroke";
import { shapeToolRuntime } from "./shape-tools";
import { textToolRuntime } from "./text-tools";
import { reportToolFailure } from "./tool-failure";

/**
 * The tools that paint on the layer pixels: the Paintbrush, the Eraser, the Pencil, the Recolor and
 * the Clone Stamp.
 */
export type PaintToolId = "paintbrush" | "eraser" | "pencil" | "recolor" | "cloneStamp";

/** The history name of each paint tool (TL-HIST), one step per stroke (TL-BRUSH-01). */
const HISTORY_KEYS = {
  paintbrush: "history.paintbrush",
  eraser: "history.eraser",
  pencil: "history.pencil",
  recolor: "history.recolor",
  cloneStamp: "history.cloneStamp",
} as const satisfies Record<PaintToolId, MessageId>;

const BLACK = { r: 0, g: 0, b: 0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

/** What the paint tools need from the app. */
export interface PaintHost {
  /** The settings the tools read, or null before they open. */
  readonly settings: () => ColorSettings | null;
  /** The image the tools paint on, or undefined when none is open. */
  readonly document: () => Document | undefined;
  readonly translate: Translate;
  /** Tells the user about a refused memory operation (WEB-MEM-03). */
  readonly notify: (messageId: MessageId) => void;
  /** Reports any other failure to the error log. */
  readonly report: (cause: unknown) => void;
  /** Sets the status bar text while a tool is adjusting a result (TL-FRAME-05). */
  readonly status?: (text: string) => void;
  /** Makes a tool active, as a hotkey does (TL-PICK-01 "After click"). */
  readonly activateTool?: (id: string) => void;
  /** The tool that was active before the last switch, if any (TL-PICK-01 "Switch to the last tool"). */
  readonly previousTool?: () => string | undefined;
  /**
   * Runs `callback` before the next repaint and returns a function that cancels it. Strokes draw
   * their preview at most once per frame with it, however many pointer samples arrive, so the main
   * thread stays free for input. Without it, every sample is drawn at once (tests).
   */
  readonly scheduleFrame?: (callback: () => void) => () => void;
  /**
   * The engine v2 stroke channel, or undefined on engine v1. With it, Paintbrush and Eraser
   * strokes are painted in the engine worker.
   */
  readonly engineStrokes?: () => EngineStrokeChannel | undefined;
  /** Where gradient tiles render: workers in the app. Without it they render inline (tests). */
  readonly gradientLanes?: () => GradientLanes;
  /** The part of the image on screen, in image pixels, so renders can start there. */
  readonly visibleArea?: () => Rect | undefined;
  /**
   * Resamples Move Selected Pixels previews on the engine's GPU, or undefined without one
   * (`FloatingPixels.setResampler`).
   */
  readonly transformResampler?: () => TransformResampler | undefined;
}

/** The colors a stroke can draw with: the button's pair and the primary and secondary colors. */
interface StrokeColors {
  readonly color: ColorRgba8;
  readonly background: ColorRgba8;
  readonly primary: ColorRgba8;
  readonly secondary: ColorRgba8;
}

/** One stroke from pointer down to pointer up (TL-BRUSH-01). */
interface Stroke {
  readonly document: Document;
  readonly layer: Layer;
  readonly historyName: string;
  readonly spec: StrokeSpec;
  readonly pixelated: boolean;
  readonly points: StrokePoint[];
  /** The rectangle of the layer the stroke can change. Empty while the stroke is off the image. */
  region: Rect;
  /** The pixels of `region` before the stroke, and what the stroke has painted over them. */
  original: Surface | undefined;
  output: Surface | undefined;
  coverage: Uint8Array | undefined;
  /** Where a Clone Stamp stroke reads its source (TL-BRUSH-CS-01). */
  readonly clone: CloneSource | undefined;
  /** The source pixels of `region`, read again whenever the region grows. */
  source: Surface | undefined;
  /** The stroke drawn a few new samples per frame. */
  readonly live: LiveStroke;
}

/**
 * A stroke drawn incrementally: each frame paints only what its new samples add, and writes only
 * the pixels that changed, so a frame costs the same however long the stroke already is.
 */
interface LiveStroke {
  readonly painter: LivePainter;
  /** `original` with every final part of the stroke painted, before the selection clip. */
  work: Surface | undefined;
  /** How many of the stroke's points the painter has been given. */
  sent: number;
  /** Where the last preview drew the part that smoothing still holds back, to redraw when it moves. */
  tailArea: Rect;
}

/** The union of two rectangles, where an empty one adds nothing. */
function joinAreas(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return b;
  if (isEmptyRect(b)) return a;
  return unionRects(a, b);
}

/**
 * A stroke region that had to grow, with room to spare: a quarter of its longer side on every side,
 * clipped to the image. Each growth copies the whole region, so growing by a share of its size keeps
 * a long stroke to a few copies, instead of one every few frames (L2).
 */
export function grownRegion(region: Rect, bounds: Rect): Rect {
  const pad = Math.ceil(Math.max(region.width, region.height) / 4);
  return intersectRects(
    rect(region.x - pad, region.y - pad, region.width + 2 * pad, region.height + 2 * pad),
    bounds,
  );
}

function isPaintTool(id: string): id is PaintToolId {
  return (
    id === "paintbrush" ||
    id === "eraser" ||
    id === "pencil" ||
    id === "recolor" ||
    id === "cloneStamp"
  );
}

function pointOf(event: ToolPointerEvent): StrokePoint {
  return { x: event.x, y: event.y, pressure: event.pressure };
}

/** The color of the layer pixel under a point, with the point clamped to the layer (TL-BRUSH-RC-01). */
function colorUnder(layer: Layer, point: StrokePoint): ColorRgba8 {
  const { x, y, width, height } = layer.pixels.bounds;
  const px = Math.min(Math.max(Math.floor(point.x), x), x + width - 1);
  const py = Math.min(Math.max(Math.floor(point.y), y), y + height - 1);
  const [r = 0, g = 0, b = 0, a = 0] = layer.pixels.readRegion(rect(px, py, 1, 1)).data;
  return { r, g, b, a };
}

/**
 * The Recolor stroke (TL-BRUSH-RC-01). The basis color is the one under the first point ("Once"),
 * or the secondary color ("Secondary color"). Under the secondary color the fill is the primary
 * color for both buttons, so the stroke never recolors to the color it matches. Otherwise the fill
 * is the button's color (TL-FRAME-03). The tolerance and its alpha mode are the flood options.
 */
function recolorSpec(
  read: ToolRead,
  layer: Layer,
  first: StrokePoint,
  colors: StrokeColors,
): StrokeSpec {
  const bySecondary = read("recolor.samplingMode") === "SecondaryColor";
  const tolerance = read("tolerance");
  return {
    kind: "recolor",
    options: brushOptionsFor(read, "paint", colors.color, colors.background),
    recolor: {
      basis: bySecondary ? colors.secondary : colorUnder(layer, first),
      fill: bySecondary ? colors.primary : colors.color,
      tolerance: typeof tolerance === "number" ? tolerance : 0.5,
      straight: read("toleranceAlphaMode") === "Straight",
    },
  };
}

/**
 * The stroke runtime of the Paintbrush, the Eraser and the Pencil. A stroke is drawn live into the
 * layer without history (`previewLayerPixels`), and pointer up records it as one history item
 * named after the tool (`editLayerPixels`). Enter or Esc while drawing cancels it and restores the
 * layer. The left button paints with the primary color and the right button with the secondary one
 * (TL-FRAME-03), and the Eraser erases with either button (TL-BRUSH-ER-01).
 */
class PaintRuntime implements ToolRuntime {
  readonly #tool: PaintToolId;
  readonly #host: PaintHost;
  #stroke: Stroke | undefined;
  /** The stroke the engine paints (engine v2 Paintbrush and Eraser). */
  #engineStroke: EngineStroke | undefined;
  /** Cancels the preview frame scheduled for the stroke's newest samples, if one is pending. */
  #cancelFrame: (() => void) | undefined;

  constructor(tool: PaintToolId, host: PaintHost) {
    this.#tool = tool;
    this.#host = host;
  }

  activate(): void {
    if (this.#tool === "cloneStamp") this.#showSource();
  }

  deactivate(): void {
    this.cancel();
    if (this.#tool === "cloneStamp") cloneSourceMarker.set({});
  }

  /**
   * The Pencil's precise crosshair, and a small dot for the brush tools, whose outline the canvas
   * draws at the brush size (TL-BRUSH-01). Ctrl over the Clone Stamp shows the anchor target, since
   * a Ctrl+click sets the anchor (TL-BRUSH-CS-01).
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    if (this.#tool === "pencil") return CROSSHAIR_CURSOR;
    const drawing = this.#stroke !== undefined || this.#engineStroke !== undefined;
    if (this.#tool === "cloneStamp" && view.ctrlKey === true && !drawing) {
      return CLONE_ANCHOR_CURSOR;
    }
    return BRUSH_POINTER_CURSOR;
  }

  pointer(event: ToolPointerEvent): void {
    try {
      if (event.type === "down") this.#start(event);
      else if (event.type === "move") this.#move(event);
      else if (event.type === "up") this.#finish(event);
      else this.cancel();
    } catch (cause) {
      this.cancel();
      this.#fail(cause);
    }
  }

  /** Stops the stroke in progress and restores the layer. Nothing is recorded. */
  cancel(): void {
    this.#unscheduleFrame();
    this.#engineStroke?.cancel();
    this.#engineStroke = undefined;
    const stroke = this.#stroke;
    if (stroke === undefined) return;
    this.#stroke = undefined;
    try {
      this.#restore(stroke);
    } catch (cause) {
      this.#fail(cause);
    } finally {
      stroke.live.painter.free();
    }
  }

  #start(event: ToolPointerEvent): void {
    if (this.#stroke !== undefined || this.#engineStroke !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    const settings = this.#host.settings();
    const document = this.#host.document();
    const layer = document?.activeLayer;
    if (settings === null || document === undefined || layer === undefined) return;
    if (this.#tool === "cloneStamp") {
      // Ctrl+click sets the anchor with the left button and never paints (TL-BRUSH-CS-01).
      if (event.ctrlKey) {
        if (event.button === 0) setCloneAnchor(document, layer, event.x, event.y);
        cloneSourceMarker.set({});
        return;
      }
      if (event.button !== 0) return;
    }
    const read: ToolRead = (name) => settings.get(`tools.${name}`);
    const primary = readStoredColor(settings, PRIMARY_COLOR_PATH, BLACK);
    const secondary = readStoredColor(settings, SECONDARY_COLOR_PATH, WHITE);
    const [color, background] = event.button === 0 ? [primary, secondary] : [secondary, primary];
    const first = pointOf(event);
    const points = [first];
    const clone =
      this.#tool === "cloneStamp" ? this.#cloneSourceFor(document, layer, first) : undefined;
    if (this.#tool === "cloneStamp" && clone === undefined) return;
    const spec = this.#specFor(read, layer, first, { color, background, primary, secondary });
    const pixelated = read("selection.renderingQuality") === "Aliased";
    const channel = spec.kind === "brush" ? this.#host.engineStrokes?.() : undefined;
    if (channel !== undefined && spec.kind === "brush") {
      this.#engineStroke = new EngineStroke(
        channel,
        {
          report: this.#host.report,
          ...(this.#host.scheduleFrame && { scheduleFrame: this.#host.scheduleFrame }),
        },
        document,
        layer,
        this.#host.translate(HISTORY_KEYS[this.#tool]),
        spec.options,
        pixelated,
        first,
      );
      return;
    }
    const stroke: Stroke = {
      document,
      layer,
      historyName: this.#host.translate(HISTORY_KEYS[this.#tool]),
      spec,
      pixelated,
      points,
      region: EMPTY_RECT,
      original: undefined,
      output: undefined,
      coverage: undefined,
      clone,
      source: undefined,
      live: { painter: livePainterFor(spec), work: undefined, sent: 0, tailArea: EMPTY_RECT },
    };
    this.#stroke = stroke;
    this.#extend(stroke);
  }

  /** Adds the sample to the stroke and draws the preview on the next frame (all samples at once). */
  #move(event: ToolPointerEvent): void {
    if (event.predicted === true) return;
    if (this.#engineStroke !== undefined) {
      this.#engineStroke.add(pointOf(event));
      return;
    }
    const stroke = this.#stroke;
    if (stroke === undefined) return;
    stroke.points.push(pointOf(event));
    const schedule = this.#host.scheduleFrame;
    if (schedule === undefined) {
      this.#extend(stroke);
      return;
    }
    if (this.#cancelFrame !== undefined) return;
    this.#cancelFrame = schedule(() => {
      this.#cancelFrame = undefined;
      if (this.#stroke !== stroke) return;
      try {
        this.#extend(stroke);
      } catch (cause) {
        this.cancel();
        this.#fail(cause);
      }
    });
  }

  #unscheduleFrame(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
  }

  #finish(event: ToolPointerEvent): void {
    this.#unscheduleFrame();
    const engineStroke = this.#engineStroke;
    if (engineStroke !== undefined) {
      this.#engineStroke = undefined;
      void engineStroke.finish(pointOf(event));
      return;
    }
    const stroke = this.#stroke;
    if (stroke === undefined) return;
    stroke.points.push(pointOf(event));
    this.#stroke = undefined;
    try {
      this.#extend(stroke);
      this.#finishLive(stroke, stroke.live);
    } finally {
      stroke.live.painter.free();
    }
    const { original, output, region, document, layer, historyName } = stroke;
    if (original === undefined || output === undefined) return;
    // The region grew with room to spare, but the stroke changed pixels only near its samples, so
    // only that part is restored and recorded.
    const painted = intersectRects(
      strokeRegion(stroke.points, strokeReach(stroke.spec), layer.pixels.bounds),
      region,
    );
    const local = translateRect(painted, -region.x, -region.y);
    document.restoreLayerPixels(layer, (pixels) => {
      pixels.writeRegion(original, painted.x, painted.y, local);
    });
    document.editLayerPixels(historyName, layer, painted, (pixels) => {
      pixels.writeRegion(output, painted.x, painted.y, local);
    });
  }

  /**
   * Reads the region the stroke now needs, then draws the stroke into it as a preview. The first
   * call that finds the stroke on the image reads its region. Later calls grow it when the samples
   * leave it.
   */
  #extend(stroke: Stroke): void {
    const wanted = strokeRegion(
      stroke.points,
      strokeReach(stroke.spec),
      stroke.layer.pixels.bounds,
    );
    const grows =
      !isEmptyRect(wanted) &&
      (stroke.original === undefined || !rectContainsRect(stroke.region, wanted));
    if (grows) {
      const previous = stroke.region;
      const next =
        stroke.original === undefined
          ? wanted
          : grownRegion(unionRects(stroke.region, wanted), stroke.layer.pixels.bounds);
      const original = stroke.layer.pixels.readRegion(next);
      if (stroke.original !== undefined) {
        // The layer holds this stroke's preview in the old region, so the old originals are copied back.
        original.copyFrom(
          stroke.original,
          stroke.original.bounds,
          stroke.region.x - next.x,
          stroke.region.y - next.y,
        );
      }
      stroke.region = next;
      stroke.original = original;
      stroke.coverage = selectionCoverage(stroke.document.selection, next, stroke.pixelated);
      if (stroke.clone !== undefined) stroke.source = readCloneSource(stroke.clone, next);
      const live = stroke.live;
      const work = original.clone();
      if (live.work !== undefined) {
        work.copyFrom(live.work, live.work.bounds, previous.x - next.x, previous.y - next.y);
      }
      live.work = work;
      const canvas = this.#canvasOf(stroke);
      if (canvas !== undefined) live.painter.grow(previous, canvas);
    }
    this.#extendLive(stroke, stroke.live);
  }

  /** The live buffers of a stroke, once it has a region on the image. */
  #canvasOf(stroke: Stroke): LiveCanvas | undefined {
    const { original, region, source } = stroke;
    const work = stroke.live.work;
    if (original === undefined || work === undefined) return undefined;
    return { region, original, work, source };
  }

  /**
   * Paints what the stroke's new samples add into its working copy, then shows the pixels that
   * changed, with the part that smoothing still holds back drawn on top. Only that area is written.
   */
  #extendLive(stroke: Stroke, live: LiveStroke): void {
    const canvas = this.#canvasOf(stroke);
    if (canvas === undefined) return;
    const { original, region, work } = canvas;
    const changed = live.painter.push(stroke.points.slice(live.sent), canvas);
    live.sent = stroke.points.length;
    const tailArea = intersectRects(live.painter.tailArea, region);
    const area = intersectRects(joinAreas(joinAreas(changed, live.tailArea), tailArea), region);
    live.tailArea = tailArea;
    if (isEmptyRect(area)) return;
    const local = translateRect(area, -region.x, -region.y);
    const patch = cropSurface(work, local);
    if (!isEmptyRect(tailArea)) live.painter.drawTail(patch, area, canvas);
    const shown =
      stroke.coverage === undefined
        ? patch
        : clipToCoverage(
            cropSurface(original, local),
            patch,
            cropCoverage(stroke.coverage, region.width, local),
          );
    stroke.document.previewLayerPixels(stroke.layer, (pixels) => {
      pixels.writeRegion(shown, area.x, area.y);
    });
  }

  /** Paints the stroke's held-back part and sets its output: the working copy, clipped to the selection. */
  #finishLive(stroke: Stroke, live: LiveStroke): void {
    const canvas = this.#canvasOf(stroke);
    if (canvas === undefined) return;
    const { original, work } = canvas;
    live.painter.finish(canvas);
    stroke.output =
      stroke.coverage === undefined ? work : clipToCoverage(original, work, stroke.coverage);
  }

  /** Puts back the pixels under the stroke. It works even while the history is busy or held. */
  #restore(stroke: Stroke): void {
    const { original, region } = stroke;
    if (original === undefined) return;
    stroke.document.restoreLayerPixels(stroke.layer, (pixels) => {
      pixels.writeRegion(original, region.x, region.y);
    });
  }

  /** Shows the source marker when the anchor's offset is already fixed (TL-BRUSH-CS-01). */
  #showSource(): void {
    const document = this.#host.document();
    const offset = document === undefined ? undefined : cloneAnchorOf(document)?.offset;
    cloneSourceMarker.set(offset === undefined ? {} : { offset });
  }

  /**
   * The source of a Clone Stamp stroke that starts at `first`, or undefined after the notice when no
   * anchor is set. The first stroke after the anchor fixes the offset, anchor minus stroke start,
   * and later strokes reuse it (TL-BRUSH-CS-01). A stroke on the source layer reads a copy of it,
   * so it never copies its own paint.
   */
  #cloneSourceFor(document: Document, layer: Layer, first: StrokePoint): CloneSource | undefined {
    const anchor = cloneAnchorOf(document);
    if (anchor === undefined) {
      this.#host.notify("clone.noAnchor");
      return undefined;
    }
    anchor.offset ??= { x: Math.round(anchor.x - first.x), y: Math.round(anchor.y - first.y) };
    cloneSourceMarker.set({ offset: anchor.offset });
    return {
      layer: anchor.layer,
      offset: anchor.offset,
      snapshot: anchor.layer === layer ? layer.pixels.readRegion(layer.pixels.bounds) : undefined,
    };
  }

  #specFor(read: ToolRead, layer: Layer, first: StrokePoint, colors: StrokeColors): StrokeSpec {
    if (this.#tool === "pencil")
      return { kind: "pencil", color: colors.color, blend: blendValue(read("blendMode")) };
    if (this.#tool === "recolor") return recolorSpec(read, layer, first, colors);
    if (this.#tool === "cloneStamp") {
      return {
        kind: "clone",
        options: brushOptionsFor(read, "paint", colors.color, colors.background),
      };
    }
    const mode = this.#tool === "eraser" ? "erase" : "paint";
    return {
      kind: "brush",
      options: brushOptionsFor(read, mode, colors.color, colors.background),
    };
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/**
 * The runtime of a built-in paint tool, or undefined for the other tools. The engine draws the
 * result, so the runtime only writes the layer pixels (TL-FRAME-07). The Paint Bucket and the
 * Gradient write their results the same way, as pending steps (TL-BUCKET-01, TL-GRAD-01).
 */
export function builtinToolRuntime(tool: ToolDescriptor, host: PaintHost): ToolRuntime | undefined {
  if (tool.id === "paintBucket") return paintBucketToolRuntime(host);
  if (tool.id === "gradient") return gradientToolRuntime(host);
  if (tool.id === "lineCurve") return lineCurveToolRuntime(host);
  if (tool.id === "shapes") return shapeToolRuntime(host);
  if (tool.id === "colorPicker") return colorPickerToolRuntime(host);
  if (tool.id === "text") return textToolRuntime(host);
  return isPaintTool(tool.id) ? new PaintRuntime(tool.id, host) : undefined;
}
