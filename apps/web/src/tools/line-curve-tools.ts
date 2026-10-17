import {
  type ColorRgba8,
  type Document,
  type HistoryCommand,
  intersectRects,
  type Layer,
  type Rect,
  rectFromEdges,
} from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import {
  CAP_STYLES,
  type CapStyle,
  CLICK_DEAD_ZONE_CSS_PX,
  ClickDeadZone,
  CURVE_KINDS,
  type CurveKind,
  constrainAngle,
  controlPoints,
  controlPosition,
  createLine,
  curveSamples,
  DASH_STYLES,
  type DashStyle,
  distanceToPolyline,
  type LineCurve,
  type LinePoint,
  lineMeasure,
  moveControl,
  type StrokeShape,
  type StrokeStyle,
  snapToPixelCenter,
  strokeShapes,
  translateLine,
} from "@openpaint/tools";
import { ColorEdits, isColorChange, paintColors, sameColor } from "./color-edits";
import { coverageParts } from "./coverage-cells";
import {
  CROSSHAIR_CURSOR,
  GRAB_CURSOR,
  GRABBING_CURSOR,
  MOVE_CURSOR,
  nearHandle,
  viewScaleOf,
} from "./cursors";
import { FrameCoalescer } from "./frame-coalescer";
import { type CoveragePart, type LayerPatches, renderCoverage, SessionPixels } from "./layer-patch";
import { type LineCurveHandles, lineCurveHandles } from "./line-curve-handles";
import { NudgeBurst, nudgeOffset } from "./nudge-burst";
import { blendValue, hatchValue } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import { reportToolFailure } from "./tool-failure";

/** The history name of each option change made while a line is pending (TL-FRAME-02). */
const OPTION_HISTORY_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.shapes.curveType": "history.changeCurveType",
  "tools.brush.size": "history.changeBrushSize",
  "tools.brush.fillType": "history.changeFill",
  "tools.brush.hatchStyle": "history.changeFill",
  "tools.pen.dashStyle": "history.changeDashStyle",
  "tools.pen.startCap": "history.changeStartCap",
  "tools.pen.endCap": "history.changeEndCap",
  "tools.antialiasing": "history.toggleAntialiasing",
  "tools.blendMode": "history.changeBlendMode",
  "tools.selection.renderingQuality": "history.changeSelectionQuality",
};

/** A grabbable handle: an endpoint, an interior control point by its index, or the line itself. */
type Handle = "start" | "end" | 0 | 1 | "body";

/**
 * A line or curve, drawn or still pending (TL-LINE-01). `pixels` draws each step over the layer as
 * it was before the session, so the steps never stack.
 */
interface LineSession {
  readonly document: Document;
  readonly layer: Layer;
  readonly pixels: SessionPixels;
  /** The button that drew the line, which decides which color is `color` (TL-FRAME-03). */
  readonly button: number;
  /** The fill color: primary for the left button, secondary for the right (TL-FRAME-03). */
  color: ColorRgba8;
  /** The other color, which the clear pixels of a hatch take. */
  background: ColorRgba8;
  line: LineCurve;
  curve: CurveKind;
  /** Whether a handle has been dragged since the line was drawn. Drives the status prompt. */
  touched: boolean;
  /** The history item the session recorded last. Any other applied item ends the session. */
  top: HistoryCommand | undefined;
}

/** A handle drag, which keeps the line it started from so a cancel can restore it. */
interface HandleDrag {
  readonly session: LineSession;
  readonly handle: Handle;
  readonly from: LineCurve;
  readonly fromCurve: CurveKind;
  /** The right button drags a control point as a cubic Bezier, the left as a spline (TL-LINE-01). */
  readonly rightButton: boolean;
  /** Where the press was, which a body drag moves the line from. */
  readonly press: LinePoint;
}

/** A line being drawn: its anchor is the press point on the pixel center. */
interface LineDraw {
  readonly session: LineSession;
  readonly anchor: LinePoint;
}

function curveOf(value: unknown): CurveKind {
  return CURVE_KINDS.find((kind) => kind === value) ?? "Spline";
}

function dashOf(value: unknown): DashStyle {
  return DASH_STYLES.find((style) => style === value) ?? "Solid";
}

function capOf(value: unknown): CapStyle {
  return CAP_STYLES.find((cap) => cap === value) ?? "Flat";
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The handle under a pointer sample, if any, measured in CSS pixels. Controls count only when the
 * curve uses them. Elsewhere on the line, within `reach` image pixels (half the pen width) plus the
 * 4 CSS px click dead zone, the press picks up the whole line.
 */
function handleAt(
  session: LineSession,
  sample: ToolPointerEvent,
  reach: number,
): Handle | undefined {
  const near = (handle: LinePoint) => nearHandle(sample, handle);
  if (near(session.line.start)) return "start";
  if (near(session.line.end)) return "end";
  if (session.curve !== "Straight") {
    if (near(controlPosition(session.line, 0))) return 0;
    if (near(controlPosition(session.line, 1))) return 1;
  }
  const samples = curveSamples(controlPoints(session.line), session.curve);
  const slack = CLICK_DEAD_ZONE_CSS_PX / viewScaleOf(sample);
  return distanceToPolyline(samples, sample) <= reach + slack ? "body" : undefined;
}

/** The line with its endpoints and controls compared by value. */
function sameLine(a: LineCurve, b: LineCurve): boolean {
  const samePoint = (p: LinePoint | undefined, q: LinePoint | undefined) =>
    p === undefined || q === undefined ? p === q : p.x === q.x && p.y === q.y;
  return (
    samePoint(a.start, b.start) &&
    samePoint(a.end, b.end) &&
    a.controls.every(
      (control, i) => control.t === b.controls[i]?.t && samePoint(control.at, b.controls[i]?.at),
    )
  );
}

/** The smallest rectangle around a shape's vertices, in whole pixels. */
function shapeRect(shape: StrokeShape): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ring of shape) {
    for (const point of ring) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }
  return rectFromEdges(Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom));
}

/**
 * The runtime of the Line / Curve tool (TL-LINE-01). A drag draws a straight line with the primary
 * color (left button) or the secondary color (right button). Shift snaps the angle to 15° steps, and
 * Alt draws from the center. Endpoints snap to pixel centers, and a zero-length line is discarded.
 * The line stays editable: an endpoint drag records "Adjust", and a control drag records "Edit" and
 * makes the line a spline (left) or a Bezier (right). Option changes recompute it. Enter, Esc, the
 * Finish button, a tool switch or a click elsewhere commits it as "Finish Line / Curve". Tapping
 * Ctrl hides and shows the handles.
 */
class LineCurveRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  #session: LineSession | undefined;
  #draw: LineDraw | undefined;
  #drag: HandleDrag | undefined;
  /** The press of the drawing or handle drag stays a click, which changes nothing, inside this zone. */
  #zone: ClickDeadZone | undefined;
  #handlesHidden = false;
  #unsubscribe: (() => void) | undefined;
  /** Draws the drag's preview once per frame, at the latest pointer position only. */
  readonly #frames: FrameCoalescer;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;

  /** Color changes of the pending line: drawn per frame, recorded as one "Change Color" step. */
  readonly #colors: ColorEdits;
  /** Arrow nudges of the pending line, recorded as one "Adjust" step per burst (TL-MOVE-01). */
  readonly #nudges: NudgeBurst;

  constructor(host: PaintHost) {
    this.#host = host;
    this.#frames = new FrameCoalescer(host.scheduleFrame);
    this.#nudges = new NudgeBurst(() => {
      const session = this.#idle();
      if (session === undefined) return;
      this.#guard(() => this.#record(session, "history.adjustLineCurve"));
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
   * Moves the pending line as a whole by an arrow key, `step` whole image pixels as the move tools do
   * (TL-MOVE-01), so its endpoints stay on pixel centers. A burst records one "Adjust" step.
   */
  nudge(dx: number, dy: number, step: number): boolean {
    const session = this.#handlesHidden ? undefined : this.#idle();
    if (session === undefined) return false;
    this.#colors.flush();
    const offset = nudgeOffset(dx, dy, step);
    session.line = translateLine(session.line, offset.dx, offset.dy);
    session.touched = true;
    this.#guard(() => this.#show(session));
    this.#nudges.nudged();
    this.#refresh();
    return true;
  }

  /** Records waiting nudges and color changes, before anything else changes the line. */
  #settle(): void {
    this.#nudges.flush();
    this.#colors.flush();
  }

  activate(): void {
    this.#unsubscribe = this.#host.settings()?.onChange((change) => this.#optionChanged(change));
  }

  deactivate(): void {
    this.#settle();
    this.cancel();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#end();
  }

  /**
   * A crosshair to draw, an open hand over an endpoint or a control point (TL-FRAME-06), closed
   * while it is dragged, and the move arrows over the rest of the line, which a drag moves.
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    const drag = this.#drag;
    if (drag !== undefined) return drag.handle === "body" ? MOVE_CURSOR : GRABBING_CURSOR;
    const session = this.#draw === undefined && !this.#handlesHidden ? this.#live() : undefined;
    const hover = this.#hover;
    const handle =
      session === undefined || hover === undefined
        ? undefined
        : handleAt(session, hover, this.#reach());
    if (handle === undefined) return CROSSHAIR_CURSOR;
    return handle === "body" ? MOVE_CURSOR : GRAB_CURSOR;
  }

  /** Half the pen width, the reach of the line body around its centre line. */
  #reach(): number {
    return numberOf(this.#host.settings()?.get("tools.brush.size"), 2) / 2;
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

  /** Commits the pending line with "Finish Line / Curve". */
  commit(): void {
    this.cancel();
    this.#settle();
    const session = this.#live();
    if (session !== undefined) {
      this.#record(session, "history.finishLineCurve");
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
      drag.session.line = drag.from;
      drag.session.curve = drag.fromCurve;
      this.#revert(drag.session);
    }
    if (draw !== undefined) this.#revert(draw.session);
    this.#refresh();
  }

  /** Tapping Ctrl hides the handles, and a second tap shows them again (TL-LINE-01). */
  tapCtrl(): void {
    if (this.#live() === undefined) return;
    this.#handlesHidden = !this.#handlesHidden;
    this.#refresh();
  }

  #down(event: ToolPointerEvent): void {
    if (this.#drag !== undefined || this.#draw !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    this.#settle();
    this.#zone = new ClickDeadZone(event);
    const session = this.#live();
    if (session !== undefined && !this.#handlesHidden) {
      const handle = handleAt(session, event, this.#reach());
      if (handle !== undefined) {
        this.#drag = {
          session,
          handle,
          from: session.line,
          fromCurve: session.curve,
          rightButton: event.button === 2,
          press: { x: event.x, y: event.y },
        };
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
    const anchor = snapToPixelCenter({ x: event.x, y: event.y });
    const session: LineSession = {
      document,
      layer,
      pixels: new SessionPixels(document, layer),
      button: event.button,
      ...paintColors(settings, event.button),
      line: createLine(anchor, anchor),
      curve: curveOf(settings.get("tools.shapes.curveType")),
      touched: false,
      top: undefined,
    };
    this.#draw = { session, anchor };
    this.#refresh();
  }

  #move(event: ToolPointerEvent): void {
    if (event.predicted === true || this.#zone?.track(event) === false) return;
    const point = { x: event.x, y: event.y };
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#place(drag, point, event.shiftKey);
      this.#showOnNextFrame(drag.session);
      return;
    }
    const draw = this.#draw;
    if (draw !== undefined) {
      draw.session.line = drawnLine(draw.anchor, point, event);
      this.#showOnNextFrame(draw.session);
    }
  }

  /** Shows the session as it is at the next frame, so moves in between are never drawn. */
  #showOnNextFrame(session: LineSession): void {
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
   * Moves the dragged handle to `point`, with Shift constraining endpoints to 15° steps. A body drag
   * moves the whole line by whole pixels, so its endpoints stay on pixel centers.
   */
  #place(drag: HandleDrag, point: LinePoint, shift: boolean): void {
    const { session, handle } = drag;
    const line = session.line;
    if (handle === "body") {
      const dx = Math.round(point.x - drag.press.x);
      const dy = Math.round(point.y - drag.press.y);
      session.line = translateLine(drag.from, dx, dy);
      return;
    }
    if (handle === "start") {
      const at = shift ? constrainAngle(line.end, point) : point;
      session.line = { ...line, start: snapToPixelCenter(at) };
      return;
    }
    if (handle === "end") {
      const at = shift ? constrainAngle(line.start, point) : point;
      session.line = { ...line, end: snapToPixelCenter(at) };
      return;
    }
    session.line = moveControl(line, handle, point);
    session.curve = drag.rightButton ? "Bezier" : "Spline";
  }

  /**
   * Ends a handle drag or a drawing. The drag or draw stays in place until its item is recorded, so
   * a failed record is put back by `cancel` from the pointer's catch. A press that stayed in its
   * dead zone is a click: it moves no handle and draws nothing.
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
      if (dragged) this.#place(drag, { x: event.x, y: event.y }, event.shiftKey);
      const changed = !sameLine(session.line, drag.from) || session.curve !== drag.fromCurve;
      if (changed) {
        session.touched = true;
        const adjusts = drag.handle === "start" || drag.handle === "end" || drag.handle === "body";
        this.#record(session, adjusts ? "history.adjustLineCurve" : "history.editLineCurve");
      } else {
        this.#revert(session);
      }
      this.#drag = undefined;
      this.#refresh();
      return;
    }
    const draw = this.#draw;
    if (draw === undefined) return;
    const { session } = draw;
    if (dragged) session.line = drawnLine(draw.anchor, { x: event.x, y: event.y }, event);
    const { start, end } = session.line;
    if (start.x !== end.x || start.y !== end.y) {
      if (this.#record(session, "history.drawLineCurve")) this.#session = session;
    }
    if (this.#session !== session) this.#revert(session);
    this.#draw = undefined;
    this.#refresh();
  }

  /**
   * Renders the session and shows it on the layer, with no history item. The pixels the last step
   * wrote go back to the base, and the new line is drawn over its own tiles only.
   */
  #show(session: LineSession): void {
    session.pixels.show(this.#render(session));
  }

  /**
   * Writes the session's line as one history item named `name`. The layer is first put back to the
   * last recorded step, so the item's before-state is right, even after previews.
   */
  #record(session: LineSession, name: MessageId): boolean {
    if (!session.pixels.record(this.#host.translate(name), this.#render(session))) return false;
    session.top = session.document.history.appliedCommands.at(-1);
    return true;
  }

  /** Puts the layer back to the last recorded step over every pixel the session wrote. */
  #revert(session: LineSession): void {
    session.pixels.revert();
  }

  /**
   * The line over the session's base under the current options and the selection clip (TL-FRAME-04).
   * Each shape is rasterized over its own rectangle, and the coverages combine by maximum, since the
   * shapes overlap at their joints.
   */
  #render(session: LineSession): LayerPatches {
    const settings = this.#host.settings();
    if (settings === null) return [];
    const read = (key: string) => settings.get(`tools.${key}`);
    const aliased = read("antialiasing") === false;
    const style: StrokeStyle = {
      width: numberOf(read("brush.size"), 2),
      dash: dashOf(read("pen.dashStyle")),
      startCap: capOf(read("pen.startCap")),
      endCap: capOf(read("pen.endCap")),
    };
    const shapes = strokeShapes(curveSamples(controlPoints(session.line), session.curve), style);
    const bounds = session.layer.pixels.bounds;
    const parts: CoveragePart[] = [];
    for (const shape of shapes) {
      // A diagonal stroke is rasterized only over the cells it passes through (L2).
      const area = intersectRects(shapeRect(shape), bounds);
      parts.push(...coverageParts(shape, area, aliased ? "aliased" : "antialiased"));
    }
    return renderCoverage(
      session.pixels.base,
      [
        {
          parts,
          options: {
            antialias: false,
            blend: blendValue(read("blendMode")),
            hatch: hatchValue(read("brush.fillType"), read("brush.hatchStyle")),
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
   * The pending session, if the document's latest history item is still its own. Undo, redo and
   * other edits end the session, so the history stays the only record of what happened.
   */
  #live(): LineSession | undefined {
    const session = this.#session;
    if (session === undefined) return undefined;
    if (session.document.history.appliedCommands.at(-1) !== session.top) {
      this.#end();
      return undefined;
    }
    return session;
  }

  #end(): void {
    this.#session = undefined;
    this.#draw = undefined;
    this.#drag = undefined;
    this.#handlesHidden = false;
    lineCurveHandles.set({});
  }

  /** Shows the handles of the line in hand, and the status text (TL-LINE-01). */
  #refresh(): void {
    const session = this.#draw?.session ?? this.#drag?.session ?? this.#live();
    if (session === undefined || this.#handlesHidden) {
      lineCurveHandles.set({});
    } else {
      const [, first, second] = controlPoints(session.line);
      const handles: LineCurveHandles = {
        start: session.line.start,
        end: session.line.end,
        curve: session.curve,
        ...(session.curve === "Straight" ? {} : { controls: [first, second] as const }),
      };
      lineCurveHandles.set(handles);
    }
    this.#host.status?.(this.#statusText());
  }

  #statusText(): string {
    const adjusting = this.#draw?.session ?? this.#drag?.session;
    const session = this.#live();
    if (adjusting !== undefined) return this.#measureText(adjusting);
    if (session !== undefined) {
      if (!session.touched) return this.#host.translate("tool.status.lineDragHandles");
      if (session.curve !== "Straight") return this.#host.translate("tool.status.lineCurve");
      return `${this.#measureText(session)}${this.#host.translate("tool.status.lineFinish")}`;
    }
    return this.#host.translate("tool.help.lineCurve");
  }

  #measureText(session: LineSession): string {
    const { dx, dy, length, angle } = lineMeasure(session.line.start, session.line.end);
    return this.#host.translate("tool.status.lineMeasure", { dx, dy, length, angle });
  }

  #optionChanged(change: SettingChange): void {
    if (change.source !== "local") return;
    if (isColorChange(change)) {
      this.#colorChanged();
      return;
    }
    const name = OPTION_HISTORY_NAMES[change.path];
    const session = this.#live();
    if (session === undefined || name === undefined) return;
    this.#settle();
    if (change.path === "tools.shapes.curveType") {
      session.curve = curveOf(change.value);
      session.touched = true;
    }
    this.#record(session, name);
    this.#refresh();
  }

  /**
   * Paints the line in hand with the new colors (TL-FRAME-01). A drawing or a drag shows them on
   * its next frame and records them with its own step; a pending line records "Change Color".
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

  /** The pending line while no drawing or handle drag is in progress. */
  #idle(): LineSession | undefined {
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

/** The line a drawing gesture makes: Alt draws from the anchor's center, and Shift constrains the angle. */
function drawnLine(anchor: LinePoint, point: LinePoint, event: ToolPointerEvent): LineCurve {
  const tip = event.shiftKey ? constrainAngle(anchor, point) : point;
  if (event.altKey) {
    return createLine(
      snapToPixelCenter({ x: 2 * anchor.x - tip.x, y: 2 * anchor.y - tip.y }),
      snapToPixelCenter(tip),
    );
  }
  return createLine(snapToPixelCenter(anchor), snapToPixelCenter(tip));
}

/** The runtime of the Line / Curve tool (TL-LINE-01). */
export function lineCurveToolRuntime(host: PaintHost): ToolRuntime {
  return new LineCurveRuntime(host);
}
