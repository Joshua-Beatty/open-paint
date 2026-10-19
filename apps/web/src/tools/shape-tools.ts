import {
  applyAffine,
  type ColorRgba8,
  type Document,
  EMPTY_RECT,
  intersectRects,
  invertAffine,
  isEmptyRect,
  type Layer,
  type Rect,
  rasterizeSelection,
  rectFromEdges,
} from "@openpaint/document";
import type {
  ShapeDescriptor,
  ToolPointerEvent,
  ToolRuntime,
  ToolViewState,
} from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import {
  CLICK_DEAD_ZONE_CSS_PX,
  ClickDeadZone,
  DASH_STYLES,
  type DashStyle,
  type DragBox,
  dragBox,
  isDegenerateBox,
  type LinePoint,
  type StrokeStyle,
  shapeRings,
  strokeShapes,
} from "@openpaint/tools";
import { ColorEdits, isColorChange, paintColors, sameColor } from "./color-edits";
import { coverageParts } from "./coverage-cells";
import { CROSSHAIR_CURSOR, GRAB_CURSOR, GRABBING_CURSOR, nearHandle, viewScaleOf } from "./cursors";
import { FrameCoalescer } from "./frame-coalescer";
import { type CoveragePart, type LayerPatches, renderCoverage, SessionPixels } from "./layer-patch";
import { NudgeBurst, nudgeOffset } from "./nudge-burst";
import { blendValue, hatchValue } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import { HistoryFollower, PendingResults, type PendingStep } from "./pending-results";
import { restoreSettings, type SettingSnapshot, snapshotSettings } from "./pending-steps";
import { drawableShapeOf, drawableShapeOrDefault, SHAPE_SETTING_PATH } from "./shape-catalog";
import { type ShapeHandles, shapeHandles } from "./shape-handles";
import {
  boxRect,
  CENTER_PIVOT,
  onShapeBody,
  placeByGesture,
  placementAnchor,
  placementTransform,
  type ShapePlacement,
} from "./shape-transform";
import { reportToolFailure } from "./tool-failure";
import {
  type FrameGesture,
  type FrameHit,
  frameCursor,
  frameGeometry,
  gestureCursor,
  gestureFor,
  gestureResult,
  hitFrame,
  transformFrame,
} from "./transform-frame";

/** The tail tip of a callout before it is dragged, in unit-square coordinates. */
const TAIL_DEFAULT: LinePoint = { x: 0.25, y: 1.25 };

/** The Draw / Fill modes of TL-SHAPE-01, as the settings store names them. */
const DRAW_TYPES = ["Outline", "Interior", "Both"] as const;
type DrawType = (typeof DRAW_TYPES)[number];

/** The history name of each option change made while a shape is pending (TL-FRAME-02). */
const OPTION_HISTORY_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.shapes.drawType": "history.changeDrawMode",
  "tools.shapes.radius": "history.adjustShape",
  "tools.brush.size": "history.changeBrushSize",
  "tools.brush.fillType": "history.changeFill",
  "tools.brush.hatchStyle": "history.changeFill",
  "tools.pen.dashStyle": "history.changeDashStyle",
  "tools.antialiasing": "history.toggleAntialiasing",
  "tools.blendMode": "history.changeBlendMode",
  "tools.selection.renderingQuality": "history.changeSelectionQuality",
};

/** The settings a shape step depends on, which undo and redo write back. */
const OPTION_PATHS = [...Object.keys(OPTION_HISTORY_NAMES), SHAPE_SETTING_PATH];

/** The geometry a drag changes: the placement, the corner radius and the callout tail. */
interface ShapeState extends ShapePlacement {
  readonly radius: number;
  readonly tail: LinePoint;
}

/** A pending shape after one of its steps, which undo and redo give back to it (TL-FRAME-01). */
interface ShapeStep extends ShapeState, PendingStep {
  readonly shape: ShapeDescriptor;
  readonly color: ColorRgba8;
  readonly background: ColorRgba8;
  readonly touched: boolean;
  readonly options: SettingSnapshot;
}

/**
 * A shape, drawn or still pending (TL-SHAPE-01). `pixels` draws each step over the layer as it was
 * before the session, so the steps never stack. The box is in the shape's own axes, which `angle`
 * turns about the box's centre.
 */
interface ShapeSession {
  readonly document: Document;
  readonly layer: Layer;
  readonly pixels: SessionPixels;
  /** The button that drew the shape, which decides which color is `color` (TL-FRAME-03). */
  readonly button: number;
  /** The outline color for the outline modes, and the fill color for Interior: primary or secondary. */
  color: ColorRgba8;
  /** The other color, which the clear pixels of a hatch take. */
  background: ColorRgba8;
  shape: ShapeDescriptor;
  box: DragBox;
  /** The turn of the shape, in radians clockwise on screen. */
  angle: number;
  /** The rotation anchor, as a fraction of the box. */
  pivot: LinePoint;
  radius: number;
  tail: LinePoint;
  /** Whether a handle has been dragged since the shape was drawn. */
  touched: boolean;
  /** The step the history stands at, undefined until the drawing is recorded. */
  step: ShapeStep | undefined;
}

/**
 * The shapes' steps, kept with their history items: an undo or redo that lands on one makes that
 * shape pending again, as it was after the step (owner request). Only on its own layer while that
 * layer is active, since switching layers finishes a shape.
 */
const SHAPE_RESULTS = new PendingResults<ShapeSession, ShapeStep>(
  "shapes",
  (session) => session.pixels.valid && session.document.activeLayer === session.layer,
);

/**
 * What a press on a pending shape picks up: the corner size or the callout tail handle, or a part
 * of the transform frame (TL-MOVE-01): the body moves the shape, the frame's handles resize it, and
 * the area around it rotates it.
 */
type Grab =
  | { readonly kind: "radius" }
  | { readonly kind: "tail" }
  | { readonly kind: "frame"; readonly hit: FrameHit };

/** A handle drag, which keeps the state it started from so a cancel can restore it. */
interface ShapeDrag {
  readonly session: ShapeSession;
  readonly grab: Grab;
  readonly from: ShapeState;
  /** The frame gesture of a frame grab, from the state at the press. */
  readonly gesture: FrameGesture | undefined;
}

/** A shape being drawn: its anchor is the press point, snapped to a pixel corner. */
interface ShapeDraw {
  readonly session: ShapeSession;
  readonly anchor: LinePoint;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function drawTypeOf(value: unknown): DrawType {
  return DRAW_TYPES.find((type) => type === value) ?? "Outline";
}

function dashOf(value: unknown): DashStyle {
  return DASH_STYLES.find((style) => style === value) ?? "Solid";
}

/** The corner-size handle: on the top edge, at the radius the corner has, in the shape's axes. */
function radiusPoint(session: ShapeSession): LinePoint {
  const { box } = session;
  const shorter = Math.min(box.right - box.left, box.bottom - box.top) / 2;
  return { x: box.left + Math.min(Math.max(session.radius, 0), shorter), y: box.top };
}

/** The callout tail handle, at the tip, in the shape's axes. */
function tailPoint(session: ShapeSession): LinePoint {
  const { box, tail } = session;
  return {
    x: box.left + tail.x * (box.right - box.left),
    y: box.top + tail.y * (box.bottom - box.top),
  };
}

function hasHandle(session: ShapeSession, name: string): boolean {
  return session.shape.handles?.includes(name) ?? false;
}

/** A point of the shape's own axes on the image. */
function toImage(session: ShapeSession, point: LinePoint): LinePoint {
  return applyAffine(placementTransform(session), point.x, point.y);
}

/** A point of the image in the shape's own axes. */
function toShape(session: ShapeSession, point: LinePoint): LinePoint {
  return applyAffine(invertAffine(placementTransform(session)), point.x, point.y);
}

/** The shape's rings in its own axes, under its corner size and tail. */
function localRings(session: ShapeSession): LinePoint[][] {
  return shapeRings(session.shape.geometry.path, boxRect(session.box), {
    radius: session.radius,
    tailX: session.tail.x,
    tailY: session.tail.y,
  });
}

/**
 * The part of the shape under a pointer sample, measured in CSS pixels (TL-FRAME-06). The corner
 * size and tail handles come first, then the frame's anchor, reset button and scale handles.
 * Anywhere inside the (turned) frame moves the shape, as inside a selection (owner request), and so
 * does its outline where it pokes out of the frame (`onShapeBody`; `reach` is half its width). Just
 * outside the frame rotates it. Farther out, a press draws a new shape.
 */
function grabAt(session: ShapeSession, sample: ToolPointerEvent, reach: number): Grab | undefined {
  const near = (handle: LinePoint) => nearHandle(sample, toImage(session, handle));
  if (hasHandle(session, "tail") && near(tailPoint(session))) return { kind: "tail" };
  if (hasHandle(session, "radius") && near(radiusPoint(session))) return { kind: "radius" };
  const p = { x: sample.x, y: sample.y };
  const scale = viewScaleOf(sample);
  const m = placementTransform(session);
  const source = boxRect(session.box);
  const hit = hitFrame(source, m, placementAnchor(session), p, 0, scale);
  if (hit?.kind === "anchor" || hit?.kind === "reset" || hit?.kind === "handle") {
    return { kind: "frame", hit };
  }
  if (hit?.kind === "move") return { kind: "frame", hit };
  const slack = CLICK_DEAD_ZONE_CSS_PX / scale;
  if (onShapeBody(localRings(session), toShape(session, p), reach + slack)) {
    return { kind: "frame", hit: { kind: "move" } };
  }
  return hit === undefined ? undefined : { kind: "frame", hit };
}

function stateOf(session: ShapeSession): ShapeState {
  return {
    box: session.box,
    angle: session.angle,
    pivot: session.pivot,
    radius: session.radius,
    tail: session.tail,
  };
}

function sameState(a: ShapeState, b: ShapeState): boolean {
  return (
    a.box.left === b.box.left &&
    a.box.top === b.box.top &&
    a.box.right === b.box.right &&
    a.box.bottom === b.box.bottom &&
    a.angle === b.angle &&
    a.pivot.x === b.pivot.x &&
    a.pivot.y === b.pivot.y &&
    a.radius === b.radius &&
    a.tail.x === b.tail.x &&
    a.tail.y === b.tail.y
  );
}

function restoreState(session: ShapeSession, state: ShapeState): void {
  session.box = state.box;
  session.angle = state.angle;
  session.pivot = state.pivot;
  session.radius = state.radius;
  session.tail = state.tail;
}
/** The rectangle that holds every point of the rings, in whole pixels. */
function ringsRect(rings: readonly (readonly LinePoint[])[]): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const point of ring) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }
  if (left > right) return EMPTY_RECT;
  return rectFromEdges(Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom));
}

/**
 * The runtime of the Shapes tool (TL-SHAPE-01). A drag draws the shape with the primary color (left
 * button) or the secondary color (right button). Shift keeps the shape's aspect ratio, and Alt draws
 * from the center. Corners snap to pixel corners, and a zero-area shape is discarded. The shape stays
 * editable: a corner drag records "Adjust", and a radius or tail drag records "Edit". Option changes
 * recompute it. Enter, Esc, the Finish button, a tool switch or a click elsewhere commit it as
 * "Finish". The draw mode decides whether the outline, the interior or both are filled.
 */
class ShapeRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  #session: ShapeSession | undefined;
  #draw: ShapeDraw | undefined;
  #drag: ShapeDrag | undefined;
  /** The press of the drawing or handle drag stays a click, which changes nothing, inside this zone. */
  #zone: ClickDeadZone | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Set while the runtime writes a setting itself, so the write is not recorded as an option change. */
  #quiet = false;
  /** Draws the drag's preview once per frame, at the latest pointer position only. */
  readonly #frames: FrameCoalescer;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;

  /** Color changes of the pending shape: drawn per frame, recorded as one "Change Color" step. */
  readonly #colors: ColorEdits;
  /** Arrow nudges of the pending shape, recorded as one "Adjust" step per burst (TL-MOVE-01). */
  readonly #nudges: NudgeBurst;
  /** Follows the open image's history, so an undo or redo can make a shape pending again. */
  readonly #follow: HistoryFollower;

  constructor(host: PaintHost) {
    this.#host = host;
    this.#frames = new FrameCoalescer(host.scheduleFrame);
    this.#follow = new HistoryFollower(host, () => {
      if (this.#draw === undefined && this.#drag === undefined) this.#live();
    });
    this.#nudges = new NudgeBurst(() => {
      const session = this.#idle();
      if (session === undefined) return;
      this.#guard(() => this.#record(session, "history.adjustShape"));
      this.#refresh();
    });
    this.#colors = new ColorEdits({
      ...(host.scheduleFrame && { scheduleFrame: host.scheduleFrame }),
      preview: () => {
        const session = this.#idle();
        if (session !== undefined) this.#guard(() => this.#show(session));
      },
      record: () => {
        const session = this.#idle();
        if (session === undefined) return;
        this.#guard(() => this.#record(session, "history.changeColor"));
        this.#refresh();
      },
    });
  }

  /**
   * Moves the pending shape by an arrow key, `step` image pixels as the move tools do (TL-MOVE-01).
   * It is drawn at once, and a burst of nudges records one "Adjust {shape}" step.
   */
  nudge(dx: number, dy: number, step: number): boolean {
    const session = this.#idle();
    if (session === undefined) return false;
    this.#colors.flush();
    const offset = nudgeOffset(dx, dy, step);
    const { box } = session;
    session.box = {
      left: box.left + offset.dx,
      top: box.top + offset.dy,
      right: box.right + offset.dx,
      bottom: box.bottom + offset.dy,
    };
    session.touched = true;
    this.#guard(() => this.#show(session));
    this.#nudges.nudged();
    this.#refresh();
    return true;
  }

  /** Records waiting nudges and color changes, before anything else changes the shape. */
  #settle(): void {
    this.#nudges.flush();
    this.#colors.flush();
  }

  activate(): void {
    this.#unsubscribe = this.#host.settings()?.onChange((change) => this.#optionChanged(change));
    this.#follow.start();
  }

  deactivate(): void {
    this.#settle();
    this.cancel();
    this.#follow.stop();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#end();
  }

  /**
   * A crosshair to draw; over a pending shape, the cursor of the frame part under the pointer
   * (TL-MOVE-01): the move arrows on the body, a resize arrow along each handle, the rotate arrow
   * around the shape, and an open hand on the anchor, the corner size and the tail (TL-FRAME-06).
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    const drag = this.#drag;
    const hover = this.#hover;
    if (drag !== undefined) {
      if (drag.gesture === undefined || hover === undefined) return GRABBING_CURSOR;
      const { session } = drag;
      return gestureCursor(drag.gesture, boxRect(session.box), placementTransform(session), hover);
    }
    const session = this.#draw === undefined ? this.#live() : undefined;
    if (session === undefined || hover === undefined) return CROSSHAIR_CURSOR;
    const grab = grabAt(session, hover, this.#reach());
    if (grab === undefined) return CROSSHAIR_CURSOR;
    if (grab.kind !== "frame") return GRAB_CURSOR;
    return (
      frameCursor(grab.hit, boxRect(session.box), placementTransform(session), hover) ??
      CROSSHAIR_CURSOR
    );
  }

  pointer(event: ToolPointerEvent): void {
    if (event.predicted !== true) this.#hover = event;
    try {
      if (event.type === "down") this.#down(event);
      else if (event.type === "move") this.#move(event);
      else if (event.type === "up") this.#up(event);
      else this.cancel();
    } catch (cause) {
      this.cancel();
      this.#fail(cause);
    }
  }

  hasPending(): boolean {
    return this.#live() !== undefined;
  }

  /** Commits the pending shape with "Finish {shape}". */
  commit(): void {
    this.cancel();
    this.#settle();
    const session = this.#live();
    if (session !== undefined) {
      this.#record(session, "history.finishShape", true);
      this.#end();
    }
    this.#refresh();
  }

  /** Stops a drawing or a handle drag, and restores the layer. Nothing is recorded. */
  cancel(): void {
    this.#frames.cancel();
    const drag = this.#drag;
    const draw = this.#draw;
    this.#drag = undefined;
    this.#draw = undefined;
    if (drag !== undefined) {
      restoreState(drag.session, drag.from);
      this.#revert(drag.session);
    }
    if (draw !== undefined) this.#revert(draw.session);
    this.#refresh();
  }

  #down(event: ToolPointerEvent): void {
    if (this.#drag !== undefined || this.#draw !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    this.#settle();
    this.#zone = new ClickDeadZone(event);
    const session = this.#live();
    if (session !== undefined) {
      const grab = grabAt(session, event, this.#reach());
      if (grab?.kind === "frame" && grab.hit.kind === "reset") {
        this.#resetAnchor(session);
        return;
      }
      if (grab !== undefined) {
        const gesture =
          grab.kind === "frame"
            ? gestureFor(grab.hit, {
                m: placementTransform(session),
                anchor: placementAnchor(session),
                press: { x: event.x, y: event.y },
              })
            : undefined;
        this.#drag = { session, grab, from: stateOf(session), gesture };
        this.#refresh();
        return;
      }
    }
    this.commit();
    this.#beginDraw(event);
  }

  #beginDraw(event: ToolPointerEvent): void {
    const settings = this.#host.settings();
    const document = this.#host.document();
    const layer = document?.activeLayer;
    if (settings === null || document === undefined || layer === undefined) return;
    const anchor = { x: Math.round(event.x), y: Math.round(event.y) };
    const shape = drawableShapeOrDefault(settings.get(SHAPE_SETTING_PATH));
    const session: ShapeSession = {
      document,
      layer,
      pixels: new SessionPixels(document, layer),
      button: event.button,
      ...paintColors(settings, event.button),
      shape,
      box: { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y },
      angle: 0,
      pivot: CENTER_PIVOT,
      radius: numberOf(settings.get("tools.shapes.radius"), 10),
      tail: { ...TAIL_DEFAULT },
      touched: false,
      step: undefined,
    };
    this.#draw = { session, anchor };
    this.#refresh();
  }

  #move(event: ToolPointerEvent): void {
    if (event.predicted === true || this.#zone?.track(event) === false) return;
    const point = { x: event.x, y: event.y };
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#place(drag, point, event);
      this.#showOnNextFrame(drag.session);
      return;
    }
    const draw = this.#draw;
    if (draw !== undefined) {
      draw.session.box = drawnBox(draw.anchor, point, event, draw.session.shape);
      this.#showOnNextFrame(draw.session);
    }
  }

  /**
   * Shows the session as it is at the next frame. Moves in between only update its geometry, so
   * the shape is drawn where the pointer is, not at every position it passed.
   */
  #showOnNextFrame(session: ShapeSession): void {
    this.#frames.request(() => {
      if (session !== this.#draw?.session && session !== this.#drag?.session) return;
      try {
        this.#show(session);
        this.#refresh();
      } catch (cause) {
        this.cancel();
        this.#fail(cause);
      }
    });
  }

  /**
   * Moves the dragged part to `point` (TL-MOVE-01). A frame gesture moves, rotates, resizes or
   * re-anchors the shape from the state at the press: Shift snaps a rotation to 15 degree steps
   * and keeps the aspect ratio of a resize, and Alt resizes about the centre. The corner size and
   * the tail follow the pointer in the shape's own axes.
   */
  #place(drag: ShapeDrag, point: LinePoint, modifiers: ToolPointerEvent): void {
    const { session, grab, from, gesture } = drag;
    if (grab.kind === "frame") {
      if (gesture === undefined) return;
      const result = gestureResult(boxRect(from.box), gesture, point, {
        // A rotation snaps the shape's own angle, not the turn of this drag.
        shift: gesture.kind !== "rotate" && modifiers.shiftKey,
        alt: modifiers.altKey,
      });
      const placed = placeByGesture(
        from,
        gesture.kind,
        result.m,
        result.anchor,
        modifiers.shiftKey,
      );
      session.box = placed.box;
      session.angle = placed.angle;
      session.pivot = placed.pivot;
      return;
    }
    const local = toShape(session, point);
    const { box } = session;
    if (grab.kind === "radius") {
      session.radius = Math.max(0, Math.round(local.x - box.left));
      return;
    }
    session.tail = {
      x: (local.x - box.left) / (box.right - box.left),
      y: (local.y - box.top) / (box.bottom - box.top),
    };
  }

  /** The reset button puts the rotation anchor back at the centre, as one step. */
  #resetAnchor(session: ShapeSession): void {
    if (session.pivot.x === CENTER_PIVOT.x && session.pivot.y === CENTER_PIVOT.y) return;
    session.pivot = CENTER_PIVOT;
    this.#record(session, "history.moveRotationAnchor");
    this.#refresh();
  }

  /** How far from the outline a press still picks the shape up: half the outline's width. */
  #reach(): number {
    const settings = this.#host.settings();
    if (settings === null) return 0;
    if (drawTypeOf(settings.get("tools.shapes.drawType")) === "Interior") return 0;
    return numberOf(settings.get("tools.brush.size"), 2) / 2;
  }

  /**
   * Ends a handle drag or a drawing. A drag that changes nothing, or makes a degenerate box, is put
   * back. A drawing that is degenerate is discarded. A press that stayed in its dead zone is a
   * click: it moves no handle and draws nothing.
   */
  #up(event: ToolPointerEvent): void {
    this.#frames.cancel();
    const dragged = this.#zone?.track(event) !== false;
    const drag = this.#drag;
    if (drag !== undefined) {
      const { session } = drag;
      if (session !== this.#live()) {
        this.#drag = undefined;
        this.#refresh();
        return;
      }
      if (dragged) this.#place(drag, { x: event.x, y: event.y }, event);
      if (isDegenerateBox(session.box)) restoreState(session, drag.from);
      if (sameState(stateOf(session), drag.from)) {
        this.#revert(session);
      } else {
        session.touched = true;
        this.#record(session, historyNameOf(drag));
        if (drag.grab.kind === "radius") this.#persistRadius(session.radius);
      }
      this.#drag = undefined;
      this.#refresh();
      return;
    }
    const draw = this.#draw;
    if (draw === undefined) return;
    const { session } = draw;
    if (dragged) {
      session.box = drawnBox(draw.anchor, { x: event.x, y: event.y }, event, session.shape);
    }
    if (dragged && !isDegenerateBox(session.box)) {
      if (this.#record(session, "history.drawShape")) this.#session = session;
    }
    if (this.#session !== session) this.#revert(session);
    this.#draw = undefined;
    this.#refresh();
  }

  /**
   * Renders the session and shows it on the layer, with no history item. The pixels the last step
   * wrote go back to the base, and the new shape is drawn over its own tiles only.
   */
  #show(session: ShapeSession): void {
    session.pixels.show(this.#render(session));
  }

  /**
   * Writes the session's shape as one history item named `name`. The layer is first put back to the
   * last recorded step, so the item's before-state is right, even after previews.
   */
  #record(session: ShapeSession, name: MessageId, finished = false): boolean {
    if (!session.pixels.record(this.#named(session, name), this.#render(session))) return false;
    const command = session.document.history.appliedCommands.at(-1);
    const settings = this.#host.settings();
    const step: ShapeStep = {
      ...stateOf(session),
      shape: session.shape,
      color: session.color,
      background: session.background,
      touched: session.touched,
      options: settings === null ? {} : snapshotSettings(settings, OPTION_PATHS),
      finished,
    };
    session.step = step;
    if (command !== undefined) SHAPE_RESULTS.remember(command, session, step);
    return true;
  }

  /** Puts the layer back to the last recorded step over every pixel the session wrote. */
  #revert(session: ShapeSession): void {
    session.pixels.revert();
  }

  /**
   * The shape over the session's base under the current options and the selection clip (TL-FRAME-04).
   * The outline is a stroke of the ring, and the interior is the ring's fill. The modes decide which
   * of the two is drawn, and the outline is drawn over the fill.
   */
  #render(session: ShapeSession): LayerPatches {
    const settings = this.#host.settings();
    const { box } = session;
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    if (settings === null || width <= 0 || height <= 0) return [];
    const read = (key: string) => settings.get(`tools.${key}`);
    const aliased = read("antialiasing") === false;
    const mode = aliased ? "aliased" : "antialiased";
    const drawType = drawTypeOf(read("shapes.drawType"));
    // A turned shape is its path turned, rasterized again, so its edges stay exact (TL-SHAPE-01).
    const local = localRings(session);
    const rings =
      session.angle === 0
        ? local
        : local.map((ring) => ring.map((point) => toImage(session, point)));
    const bounds = session.layer.pixels.bounds;
    const outline: CoveragePart[] = [];
    const interior: CoveragePart[] = [];
    if (drawType !== "Interior") {
      const style: StrokeStyle = {
        width: numberOf(read("brush.size"), 2),
        dash: dashOf(read("pen.dashStyle")),
        startCap: "Flat",
        endCap: "Flat",
      };
      for (const ring of rings) {
        const [first, second] = ring;
        if (first === undefined || second === undefined) continue;
        for (const stroke of strokeShapes([...ring, first, second], style)) {
          // Only the cells a turned edge passes through are rasterized (L2).
          outline.push(...coverageParts(stroke, intersectRects(ringsRect(stroke), bounds), mode));
        }
      }
    }
    if (drawType !== "Outline") {
      const area = intersectRects(ringsRect(rings), bounds);
      if (!isEmptyRect(area)) {
        const coverage = rasterizeSelection(
          rings.map((ring) => ring.flatMap((point) => [point.x, point.y])),
          area,
          mode,
        );
        interior.push({ area, coverage });
      }
    }
    const blend = blendValue(read("blendMode"));
    const hatch = hatchValue(read("brush.fillType"), read("brush.hatchStyle"));
    const both = drawType === "Both";
    return renderCoverage(
      session.pixels.base,
      [
        {
          parts: interior,
          options: {
            antialias: false,
            blend,
            hatch,
            color: both ? session.background : session.color,
            background: both ? session.color : session.background,
          },
        },
        {
          parts: outline,
          options: {
            antialias: false,
            blend,
            hatch,
            color: session.color,
            background: session.background,
          },
        },
      ],
      {
        selection: session.document.selection,
        pixelated: read("selection.renderingQuality") === "Aliased",
      },
    ).patches;
  }

  /**
   * The pending session, if the document's latest history item is one of a shape's steps that
   * Finish did not record. Undo and redo that land on such a step make that shape pending again,
   * as it was after the step, its options included (owner request); any other latest item ends the
   * session.
   */
  #live(): ShapeSession | undefined {
    const own = this.#session?.document;
    const document = own ?? this.#host.document();
    const found = document === undefined ? undefined : SHAPE_RESULTS.at(document, this.#session);
    if (found === undefined || found.step.finished) {
      if (this.#session === undefined) return undefined;
      this.#end();
      return own !== this.#host.document() ? this.#live() : undefined;
    }
    const { owner, step } = found;
    if (owner !== this.#session || step !== owner.step) this.#adopt(owner, step);
    return owner;
  }

  /**
   * Makes `session` the pending shape as `step` left it. The layer already shows the step, so
   * nothing is written or recorded; the step is rendered again only to know its pixels.
   */
  #adopt(session: ShapeSession, step: ShapeStep): void {
    this.#frames.cancel();
    this.#nudges.cancel();
    this.#colors.cancel();
    this.#drag = undefined;
    restoreState(session, step);
    session.shape = step.shape;
    session.color = step.color;
    session.background = step.background;
    session.touched = step.touched;
    session.step = step;
    this.#session = session;
    const settings = this.#host.settings();
    if (settings !== null) {
      this.#quiet = true;
      try {
        restoreSettings(settings, step.options);
      } finally {
        this.#quiet = false;
      }
    }
    session.pixels.adopt(this.#render(session));
    this.#refresh();
  }

  #end(): void {
    this.#session = undefined;
    this.#draw = undefined;
    this.#drag = undefined;
    shapeHandles.set({});
    transformFrame.set(undefined);
  }

  /**
   * Shows the transform frame and the property handles of the shape in hand, and the status text
   * (TL-SHAPE-01, TL-MOVE-01).
   */
  #refresh(): void {
    const session = this.#draw?.session ?? this.#drag?.session ?? this.#live();
    shapeHandles.set(session === undefined ? {} : handlesOf(session));
    transformFrame.set(
      session === undefined || isDegenerateBox(session.box)
        ? undefined
        : {
            ...frameGeometry(
              boxRect(session.box),
              placementTransform(session),
              placementAnchor(session),
            ),
            // Only the handles: the frame's outline would hide a thin outline of the shape.
            outline: false,
          },
    );
    this.#host.status?.(this.#statusText());
  }

  #statusText(): string {
    const adjusting = this.#draw?.session ?? this.#drag?.session;
    const session = this.#live();
    const active = adjusting ?? session;
    if (active === undefined) return this.#host.translate("tool.help.shapes");
    const { box } = active;
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const diagonal = Math.round(Math.hypot(width, height) * 10) / 10;
    const measure = this.#host.translate("tool.status.shapeMeasure", {
      w: width,
      h: height,
      d: diagonal,
      angle: angleDegrees(active.angle),
    });
    if (adjusting !== undefined) return measure;
    return `${measure}${this.#host.translate("tool.status.shapeFinish")}`;
  }

  /** The history name of a step, with the shape's name for `{shape}`. */
  #named(session: ShapeSession, name: MessageId): string {
    return this.#host.translate(name, { shape: this.#host.translate(session.shape.label) });
  }

  /** Stores the corner size without recording it as an option change of the pending shape. */
  #persistRadius(radius: number): void {
    const settings = this.#host.settings();
    if (settings === null) return;
    this.#quiet = true;
    try {
      settings.set("tools.shapes.radius", radius);
    } finally {
      this.#quiet = false;
    }
  }

  /**
   * Recomputes the pending shape when its option changes (TL-FRAME-02). A shape-type change
   * switches the shape and records "Change to {shape}".
   */
  #optionChanged(change: SettingChange): void {
    if (this.#quiet || change.source !== "local") return;
    if (isColorChange(change)) {
      this.#colorChanged();
      return;
    }
    const session = this.#live();
    if (session === undefined) return;
    this.#settle();
    if (change.path === SHAPE_SETTING_PATH) {
      const shape = drawableShapeOf(change.value);
      if (shape === undefined || shape.id === session.shape.id) return;
      session.shape = shape;
      session.touched = true;
      this.#record(session, "history.changeToShape");
      this.#refresh();
      return;
    }
    const name = OPTION_HISTORY_NAMES[change.path];
    if (name === undefined) return;
    if (change.path === "tools.shapes.radius") {
      session.radius = numberOf(change.value, session.radius);
      session.touched = true;
    }
    this.#record(session, name);
    this.#refresh();
  }

  /**
   * Paints the shape in hand with the new colors (TL-FRAME-01). A drawing or a drag shows them on
   * its next frame and records them with its own step; a pending shape records "Change Color".
   */
  #colorChanged(): void {
    this.#nudges.flush();
    const settings = this.#host.settings();
    const inHand = this.#draw?.session ?? this.#drag?.session;
    const session = inHand ?? this.#live();
    if (settings === null || session === undefined) return;
    const { color, background } = paintColors(settings, session.button);
    if (sameColor(color, session.color) && sameColor(background, session.background)) return;
    session.color = color;
    session.background = background;
    if (inHand !== undefined) this.#showOnNextFrame(inHand);
    else this.#colors.changed();
  }

  /** The pending shape while no drawing or handle drag is in progress. */
  #idle(): ShapeSession | undefined {
    return this.#draw === undefined && this.#drag === undefined ? this.#live() : undefined;
  }

  #guard(work: () => void): void {
    try {
      work();
    } catch (cause) {
      this.#fail(cause);
    }
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/** The box a drawing gesture makes: Shift keeps the aspect ratio, and Alt draws from the center. */
function drawnBox(
  anchor: LinePoint,
  point: LinePoint,
  event: ToolPointerEvent,
  shape: ShapeDescriptor,
): DragBox {
  return dragBox(anchor, point, {
    aspect: shape.geometry.aspect ?? 1,
    constrain: event.shiftKey,
    fromCenter: event.altKey,
  });
}

/**
 * The property handles a session shows on the image: the radius and the tail, when the shape has
 * them. The transform frame shows the box.
 */
function handlesOf(session: ShapeSession): ShapeHandles {
  return {
    ...(hasHandle(session, "radius") ? { radius: toImage(session, radiusPoint(session)) } : {}),
    ...(hasHandle(session, "tail") ? { tail: toImage(session, tailPoint(session)) } : {}),
  };
}

/** The history name of a finished drag (TL-SHAPE-01, TL-HIST). */
function historyNameOf(drag: ShapeDrag): MessageId {
  if (drag.grab.kind !== "frame") return "history.editShape";
  return drag.gesture?.kind === "anchor" ? "history.moveRotationAnchor" : "history.adjustShape";
}

/** A turn as the status bar shows it: whole degrees clockwise, from 0 to 359 (TL-SHAPE-01). */
export function angleDegrees(angle: number): number {
  const degrees = (angle * 180) / Math.PI;
  return Math.round((degrees + 360) % 360) % 360;
}

/** The runtime of the Shapes tool (TL-SHAPE-01). */
export function shapeToolRuntime(host: PaintHost): ToolRuntime {
  return new ShapeRuntime(host);
}
