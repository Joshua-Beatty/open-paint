import {
  type ColorRgba8,
  type Document,
  intersectRects,
  type Layer,
  type Rect,
  type Selection,
  type ToolStep,
} from "@openpaint/document";
import {
  GRADIENT_REPEATS,
  GRADIENT_SHAPES,
  type GradientOptions,
  type GradientRepeat,
  type GradientShape,
} from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import { ClickDeadZone } from "@openpaint/tools";
import { type ColorSettings, PRIMARY_COLOR_PATH, SECONDARY_COLOR_PATH } from "../colors/use-colors";
import { CROSSHAIR_CURSOR, GRAB_CURSOR, GRABBING_CURSOR, MOVE_CURSOR, nearHandle } from "./cursors";
import { EditBurst, isColorChange, paintColors, sameColor } from "./edit-burst";
import { FrameCoalescer } from "./frame-coalescer";
import { type GradientHandles, gradientHandles, type HandlePoint } from "./gradient-handles";
import {
  type GradientLanes,
  GradientRenderer,
  type GradientTile,
  InlineGradientLanes,
} from "./gradient-tiles";
import { LayerSnapshot } from "./layer-patch";
import { blendValue, selectionCoverage } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import type { SettingSnapshot } from "./pending-steps";
import { reportToolFailure } from "./tool-failure";
import {
  layerIndex,
  PendingOptions,
  recordStep,
  type StepContext,
  type StepKind,
  type SteppedRuntime,
} from "./tool-history";

/** The dither seed. One drawing keeps it, so every re-render dithers the same way (TL-ALG-GRAD). */
const DITHER_SEED = 0x4f50_454e;

/** The Shift angle step of TL-GRAD-01: 15 degrees. */
const SHIFT_STEP = Math.PI / 12;

/** The history name of each option change made while a gradient is pending (TL-FRAME-02). */
const OPTION_HISTORY_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.gradient.type": "history.changeGradientType",
  "tools.gradient.repeatType": "history.changeRepeatType",
  "tools.gradient.alphaOnly": "history.toggleAlphaMode",
  "tools.antialiasing": "history.toggleAntialiasing",
  "tools.blendMode": "history.changeBlendMode",
  "tools.selection.renderingQuality": "history.changeSelectionQuality",
};

/** The settings a gradient step depends on, which undo and redo write back, colors included. */
const OPTION_PATHS = [
  ...Object.keys(OPTION_HISTORY_NAMES),
  PRIMARY_COLOR_PATH,
  SECONDARY_COLOR_PATH,
];

/**
 * A pending gradient as one of its history items keeps it (TL-FRAME-01): its handles, colors and
 * options.
 */
interface GradientSnapshot {
  readonly start: HandlePoint;
  readonly end: HandlePoint;
  readonly primary: ColorRgba8;
  readonly secondary: ColorRgba8;
  readonly reversed: boolean;
  readonly options: SettingSnapshot;
}

/**
 * The end point, with its angle from `start` snapped to 15° steps while Shift is held (TL-GRAD-01).
 * The length is kept.
 */
export function constrainEnd(start: HandlePoint, end: HandlePoint, shift: boolean): HandlePoint {
  if (!shift) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return end;
  const angle = Math.round(Math.atan2(dy, dx) / SHIFT_STEP) * SHIFT_STEP;
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

/** The live measurements of a gradient line, in whole pixels and degrees (TL-GRAD-01). */
export function gradientMeasure(start: HandlePoint, end: HandlePoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    dx: Math.round(dx),
    dy: Math.round(dy),
    length: Math.round(Math.hypot(dx, dy)),
    angle: Math.round((degrees + 360) % 360) % 360,
  };
}

function primaryAndSecondary(settings: ColorSettings): {
  readonly primary: ColorRgba8;
  readonly secondary: ColorRgba8;
} {
  const { color, background } = paintColors(settings, 0);
  return { primary: color, secondary: background };
}

function midpoint(start: HandlePoint, end: HandlePoint): HandlePoint {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

type HandleKind = "start" | "end" | "move";

/**
 * The handle under a pointer sample, if any, measured in CSS pixels. The start nub wins over the
 * end nub, and both over the move handle.
 */
function handleAt(session: GradientSession, sample: ToolPointerEvent): HandleKind | undefined {
  if (nearHandle(sample, session.start)) return "start";
  if (nearHandle(sample, session.end)) return "end";
  if (nearHandle(sample, midpoint(session.start, session.end))) return "move";
  return undefined;
}

function shapeOf(value: unknown): GradientShape {
  return GRADIENT_SHAPES.find((shape) => shape === value) ?? "LinearClamped";
}

function repeatOf(value: unknown): GradientRepeat {
  return GRADIENT_REPEATS.find((repeat) => repeat === value) ?? "NoRepeat";
}

/**
 * The start and end colors of a gradient (TL-GRAD-01). The start takes the primary color, and the
 * right button or a handle reverses the two. In transparency mode the colors carry the alpha ramp
 * (TL-ALG-GRAD): the start alpha is the primary's alpha and the end alpha is 255 minus the
 * secondary's, and reversing the colors reverses the ramp too.
 */
function gradientColors(
  session: GradientSession,
  alphaOnly: boolean,
): { readonly startColor: ColorRgba8; readonly endColor: ColorRgba8 } {
  const [startColor, endColor] = session.reversed
    ? [session.secondary, session.primary]
    : [session.primary, session.secondary];
  if (!alphaOnly) return { startColor, endColor };
  return session.reversed
    ? {
        startColor: { ...startColor, a: 255 - startColor.a },
        endColor: { ...endColor, a: endColor.a },
      }
    : {
        startColor: { ...startColor, a: startColor.a },
        endColor: { ...endColor, a: 255 - endColor.a },
      };
}

/**
 * A gradient that is drawn, or still pending (TL-FRAME-01). It stays editable until it is committed,
 * or until the document's history moves past its last step (undo, redo, another edit).
 */
interface GradientSession {
  readonly document: Document;
  readonly layer: Layer;
  /** The layer before the gradient was drawn, copied a tile at a time as it is read (L9). */
  readonly base: LayerSnapshot;
  /** The primary and secondary colors, which follow color changes while the gradient is pending. */
  primary: ColorRgba8;
  secondary: ColorRgba8;
  /** Whether the colors are reversed: the right button, or a right-click on a handle. */
  reversed: boolean;
  start: HandlePoint;
  end: HandlePoint;
  /** Renders the gradient in tiles, over the layer or the selection's bounds (TL-FRAME-04). */
  render: GradientRender | undefined;
  /**
   * The layer as the last recorded step left it, copied a tile at a time just before a preview
   * writes there; undefined before the first step, when the base stands in for it.
   */
  recorded: LayerSnapshot | undefined;
  /** Whether render tiles were written since the layer last showed the recorded state. */
  shown: boolean;
  /** What the last recorded step rendered (`renderKey`), or undefined before the first. */
  recordedKey: string | undefined;
  /** Set while a record waits for its render: tiles are then written past the document's hold. */
  held: boolean;
  /** The layer's pixels when the gradient was drawn; a resize or a deleted layer replaces them. */
  readonly store: Layer["pixels"];
  /** The gradient as its latest history item keeps it, undefined until the drawing is recorded. */
  state: GradientSnapshot | undefined;
  /** Names the gradient's history items (`ToolStep.session`). */
  readonly key: object;
}

/** A tile renderer with the selection clip it was made for, and the options it rendered last. */
interface GradientRender {
  readonly renderer: GradientRenderer;
  readonly area: Rect;
  readonly selection: Selection;
  readonly pixelated: boolean;
  key: string | undefined;
  generation: number;
}

/** A handle drag, which keeps the points it started from so a cancel can restore them. */
interface HandleDrag {
  readonly session: GradientSession;
  readonly kind: HandleKind;
  readonly grab: HandlePoint;
  readonly from: { readonly start: HandlePoint; readonly end: HandlePoint };
}

/**
 * The runtime of the Gradient tool (TL-GRAD-01). A drag draws a gradient from the start point to
 * the end point, with the primary color at the start and the secondary at the end (the right button
 * reverses them). The drag previews live without history. Release records "Gradient", and the
 * result stays pending. Its nubs and move handle edit it as "Edit Gradient" and "Move Gradient".
 * A right-click on a handle swaps the colors, and Enter, Esc, the Finish button or a click elsewhere
 * commits the gradient as "Finish Gradient".
 *
 * The gradient is rendered in tiles by `GradientRenderer`, in workers when the host has them (L7),
 * so a preview frame costs the main thread only the tiles that land. A record waits until every
 * tile of its render has landed; meanwhile the document is held and `settling` holds the input.
 */
class GradientRuntime implements SteppedRuntime {
  readonly #host: PaintHost;
  readonly #lanes: GradientLanes;
  #session: GradientSession | undefined;
  #draw: GradientSession | undefined;
  #drag: HandleDrag | undefined;
  /** The press of the drawing or handle drag stays a click, which changes nothing, inside this zone. */
  #zone: ClickDeadZone | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Draws the drag's preview once per frame, at the latest pointer position only. */
  readonly #frames: FrameCoalescer;
  /** Records still waiting for their render, in order. */
  #settling: Promise<void> | undefined;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;

  /** Color changes of the pending gradient: drawn per frame, recorded as one "Change Color" step. */
  readonly #edits: EditBurst;
  /** The option values of the pending gradient on the options bar. */
  readonly #options: PendingOptions;
  /** Set while the runtime writes settings back itself, so the writes are not recorded as option changes. */
  #quiet = false;

  constructor(host: PaintHost) {
    this.#host = host;
    this.#lanes = host.gradientLanes?.() ?? new InlineGradientLanes();
    this.#frames = new FrameCoalescer(host.scheduleFrame);
    this.#options = new PendingOptions(OPTION_PATHS, (action) => this.#quietly(action));
    this.#edits = new EditBurst({
      ...(host.scheduleFrame && { scheduleFrame: host.scheduleFrame }),
      preview: () => {
        const session = this.#idle();
        if (session === undefined) return;
        try {
          this.#renderFor(session);
        } catch (cause) {
          this.#restoreRecorded(session);
          this.#fail(cause);
        }
      },
      record: (name) => {
        const session = this.#idle();
        if (session === undefined) return;
        this.#record(session, name as MessageId);
        this.#refresh();
      },
    });
  }

  activate(): void {
    this.#unsubscribe = this.#host.settings()?.onChange((change) => this.#optionChanged(change));
  }

  deactivate(): void {
    this.#edits.flush();
    this.#revert();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#end();
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

  /**
   * A crosshair to draw, an open hand over a nub and the move arrows over the move handle
   * (TL-FRAME-06), and a closed hand while a nub is dragged.
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    const drag = this.#drag;
    if (drag !== undefined) return drag.kind === "move" ? MOVE_CURSOR : GRABBING_CURSOR;
    const session = this.#draw === undefined ? this.#live() : undefined;
    const kind =
      session === undefined || this.#hover === undefined
        ? undefined
        : handleAt(session, this.#hover);
    if (kind === undefined) return CROSSHAIR_CURSOR;
    return kind === "move" ? MOVE_CURSOR : GRAB_CURSOR;
  }

  hasPending(): boolean {
    return this.#settling !== undefined || this.#live() !== undefined;
  }

  settling(): Promise<void> | undefined {
    return this.#settling;
  }

  /** Commits the pending gradient with "Finish Gradient". */
  commit(): void {
    this.#revert();
    this.#edits.flush();
    const session = this.#live();
    if (session !== undefined) {
      this.#record(session, "history.finishGradient", "finish");
      this.#end();
    }
    this.#refresh();
  }

  /** Stops a drawing or a handle drag, and restores the layer. Nothing is recorded. */
  cancel(): void {
    this.#revert();
    this.#refresh();
  }

  #down(event: ToolPointerEvent): void {
    if (this.#drag !== undefined || this.#draw !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    this.#edits.flush();
    this.#zone = new ClickDeadZone(event);
    const session = this.#live();
    if (session !== undefined) {
      const kind = handleAt(session, event);
      if (kind !== undefined) {
        if (event.button === 2) {
          session.reversed = !session.reversed;
          this.#record(session, "history.reverseColors");
          this.#refresh();
          return;
        }
        this.#drag = {
          session,
          kind,
          grab: { x: event.x, y: event.y },
          from: { start: session.start, end: session.end },
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
    const point = { x: event.x, y: event.y };
    this.#draw = {
      document,
      layer,
      base: new LayerSnapshot(layer.pixels),
      ...primaryAndSecondary(settings),
      reversed: event.button === 2,
      start: point,
      end: point,
      render: undefined,
      recorded: undefined,
      shown: false,
      recordedKey: undefined,
      held: false,
      store: layer.pixels,
      state: undefined,
      key: {},
    };
    this.#refresh();
  }

  #move(event: ToolPointerEvent): void {
    if (event.predicted === true) return;
    this.#place(event);
  }

  /**
   * Moves the drawn end, or the dragged handle, to the event's point, and previews the result.
   * Inside the press's dead zone nothing moves, so a click draws no gradient.
   */
  #place(event: ToolPointerEvent): void {
    if (this.#zone?.track(event) === false) return;
    const point = { x: event.x, y: event.y };
    const drag = this.#drag;
    if (drag !== undefined) {
      const { session } = drag;
      if (drag.kind === "move") {
        const dx = point.x - drag.grab.x;
        const dy = point.y - drag.grab.y;
        session.start = { x: drag.from.start.x + dx, y: drag.from.start.y + dy };
        session.end = { x: drag.from.end.x + dx, y: drag.from.end.y + dy };
      } else if (drag.kind === "start") {
        session.start = point;
      } else {
        session.end = constrainEnd(session.start, point, event.shiftKey);
      }
      this.#previewOnNextFrame(session);
      return;
    }
    const draw = this.#draw;
    if (draw !== undefined) {
      draw.end = constrainEnd(draw.start, point, event.shiftKey);
      this.#previewOnNextFrame(draw);
    }
  }

  /** Previews the session as it is at the next frame, so moves in between are never drawn. */
  #previewOnNextFrame(session: GradientSession): void {
    this.#frames.request(() => {
      if (session !== this.#draw && session !== this.#drag?.session) return;
      try {
        this.#renderFor(session);
        this.#refresh();
      } catch (cause) {
        this.cancel();
        this.#fail(cause);
      }
    });
  }

  #up(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#place(event);
      this.#frames.cancel();
      this.#drag = undefined;
      const { session } = drag;
      if (session !== this.#live()) {
        this.#refresh();
        return;
      }
      const moved =
        session.start.x !== drag.from.start.x ||
        session.start.y !== drag.from.start.y ||
        session.end.x !== drag.from.end.x ||
        session.end.y !== drag.from.end.y;
      if (moved) {
        this.#record(
          session,
          drag.kind === "move" ? "history.moveGradient" : "history.editGradient",
        );
      }
      this.#refresh();
      return;
    }
    const draw = this.#draw;
    if (draw === undefined) return;
    this.#place(event);
    this.#frames.cancel();
    this.#draw = undefined;
    if (draw.start.x === draw.end.x && draw.start.y === draw.end.y) {
      this.#restoreRecorded(draw);
      this.#dispose(draw);
      this.#refresh();
      return;
    }
    this.#session = draw;
    this.#record(draw, "history.gradient", "draw");
    this.#refresh();
  }

  /**
   * Records the gradient as one history item named `name`, once its render has landed. Records
   * asked for while an earlier one waits are made after it, in order.
   */
  #record(session: GradientSession, name: MessageId, kind: StepKind = "edit"): void {
    const waiting = this.#settling;
    if (waiting === undefined) {
      const pending = this.#recordNow(session, name, kind);
      if (pending !== undefined) this.#track(pending);
      return;
    }
    this.#track(waiting.then(() => this.#recordNow(session, name, kind)));
  }

  /** Keeps `work` as the settling promise until it ends; a failure puts the layer back. */
  #track(work: Promise<void>): void {
    const settled: Promise<void> = work
      .catch((cause: unknown) => {
        for (const session of [this.#session, this.#draw]) {
          if (session !== undefined) this.#restoreRecorded(session);
        }
        this.#fail(cause);
      })
      .finally(() => {
        if (this.#settling === settled) this.#settling = undefined;
        this.#refresh();
      });
    this.#settling = settled;
  }

  /**
   * Records at once when the render of the current options has landed. Otherwise holds the
   * document, so no other edit lands on pixels that are not in the history yet, and returns a
   * promise that records once the render is complete.
   */
  #recordNow(session: GradientSession, name: MessageId, kind: StepKind): Promise<void> | undefined {
    const now = this.#snapshot(session);
    const step: ToolStep = {
      tool: "gradient",
      layer: layerIndex(session.document, session.layer),
      kind,
      session: session.key,
      before: kind === "draw" ? undefined : kind === "finish" ? now : session.state,
      after: kind === "finish" ? undefined : now,
    };
    const unchanged =
      !session.shown &&
      session.render !== undefined &&
      session.recordedKey !== undefined &&
      session.recordedKey === this.#renderKey(session);
    // The layer already shows what the last step recorded, so nothing needs rendering.
    if (unchanged && session.render !== undefined) {
      this.#write(session, name, session.render, step);
      return undefined;
    }
    const render = this.#renderFor(session);
    if (render === undefined) return undefined;
    render.renderer.flush();
    if (render.renderer.isComplete(render.generation)) {
      this.#write(session, name, render, step);
      return undefined;
    }
    const release = session.document.history.hold();
    session.held = true;
    const finish = () => {
      session.held = false;
      release();
    };
    return render.renderer.whenComplete(render.generation).then(
      () => {
        finish();
        this.#write(session, name, render, step);
      },
      (cause: unknown) => {
        finish();
        throw cause;
      },
    );
  }

  /** Writes the landed render as one history item; the layer already shows it. */
  #write(session: GradientSession, name: MessageId, render: GradientRender, step: ToolStep): void {
    const { document, layer } = session;
    const { area } = render;
    const before = session.recorded ?? session.base;
    recordStep(document, step, () =>
      document.recordLayerPixels(this.#host.translate(name), layer, area, before.tileAt),
    );
    session.recorded = new LayerSnapshot(layer.pixels);
    session.recordedKey = this.#renderKey(session);
    session.shown = false;
    session.state = (step.after ?? step.before) as GradientSnapshot;
    this.#options.edited();
    if (session !== this.#session && session !== this.#draw) this.#dispose(session);
  }

  /** The gradient as a history item keeps it, with the current option values. */
  #snapshot(session: GradientSession): GradientSnapshot {
    return {
      start: session.start,
      end: session.end,
      primary: session.primary,
      secondary: session.secondary,
      reversed: session.reversed,
      options: this.#options.snapshot(this.#host.settings()),
    };
  }

  /** Puts back the layer state of the last recorded step, or of the drawing's start. */
  #revert(): void {
    this.#frames.cancel();
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#drag = undefined;
      drag.session.start = drag.from.start;
      drag.session.end = drag.from.end;
      this.#restoreRecorded(drag.session);
    }
    const draw = this.#draw;
    if (draw !== undefined) {
      this.#draw = undefined;
      this.#restoreRecorded(draw);
      this.#dispose(draw);
    }
  }

  /** Drops the render in flight and shows the recorded state again, if tiles were written since. */
  #restoreRecorded(session: GradientSession): void {
    const render = session.render;
    if (render === undefined) return;
    render.renderer.cancel();
    render.key = undefined;
    if (!session.shown) return;
    const state = session.recorded ?? session.base;
    session.document.restoreLayerPixels(session.layer, (pixels) =>
      state.restore(pixels, render.area),
    );
    session.shown = false;
  }

  /** Frees the session's workers' copies once nothing will render it again. */
  #dispose(session: GradientSession): void {
    session.render?.renderer.dispose();
    session.render = undefined;
  }

  /**
   * Starts rendering the gradient of the session's current options, unless that render is already
   * under way or done, and returns it. With a selection only its bounds can change, so only they
   * are rendered, clipped to it (L2); the clip is kept while the selection and its quality stay.
   */
  #renderFor(session: GradientSession): GradientRender | undefined {
    const settings = this.#host.settings();
    const options = this.#optionsOf(session);
    if (settings === null || options === undefined) return session.render;
    const { selection } = session.document;
    const pixelated = settings.get("tools.selection.renderingQuality") === "Aliased";
    let render = session.render;
    if (render === undefined || render.selection !== selection || render.pixelated !== pixelated) {
      render?.renderer.dispose();
      const bounds = session.layer.pixels.bounds;
      const area = selection.isEmpty ? bounds : intersectRects(selection.bounds(), bounds);
      const coverage = selection.isEmpty
        ? undefined
        : selectionCoverage(selection, area, pixelated);
      render = {
        renderer: new GradientRenderer({
          lanes: this.#lanes,
          base: session.base,
          store: session.layer.pixels,
          area,
          coverage,
          write: (tiles) => this.#writeTiles(session, tiles),
          ...(this.#host.scheduleFrame && { scheduleFrame: this.#host.scheduleFrame }),
        }),
        area,
        selection,
        pixelated,
        key: undefined,
        generation: 0,
      };
      session.render = render;
    }
    const key = JSON.stringify(options);
    if (render.key !== key || !render.renderer.isLive(render.generation)) {
      render.key = key;
      render.generation = render.renderer.render(options, this.#host.visibleArea?.());
    }
    return render;
  }

  /** The gradient options of the session under the current settings. */
  #optionsOf(session: GradientSession): GradientOptions | undefined {
    const settings = this.#host.settings();
    if (settings === null) return undefined;
    const read = (key: string) => settings.get(`tools.${key}`);
    const alphaOnly = read("gradient.alphaOnly") === true;
    return {
      shape: shapeOf(read("gradient.type")),
      repeat: repeatOf(read("gradient.repeatType")),
      start: session.start,
      end: session.end,
      ...gradientColors(session, alphaOnly),
      alphaOnly,
      antialias: read("antialiasing") !== false,
      blend: blendValue(read("blendMode")),
      seed: DITHER_SEED,
    };
  }

  /** What a render of the session would show: its options and its selection clip. */
  #renderKey(session: GradientSession): string | undefined {
    const options = this.#optionsOf(session);
    const settings = this.#host.settings();
    if (options === undefined || settings === null) return undefined;
    const quality = settings.get("tools.selection.renderingQuality");
    return `${JSON.stringify(options)}|${String(quality)}|${session.document.selection.isEmpty ? "" : "clip"}`;
  }

  /** Writes landed tiles into the layer. A record's own tiles pass the hold it keeps. */
  #writeTiles(session: GradientSession, tiles: readonly GradientTile[]): void {
    // The recorded state is copied where it is about to be overwritten, for a revert or the next
    // step's before-state.
    const state = session.recorded ?? session.base;
    for (const tile of tiles) state.keep(tile.area);
    const write = (pixels: Layer["pixels"]) => {
      for (const tile of tiles) pixels.writeRegion(tile.output, tile.area.x, tile.area.y);
    };
    if (session.held) session.document.restoreLayerPixels(session.layer, write);
    else session.document.previewLayerPixels(session.layer, write);
    session.shown = true;
  }

  /**
   * The pending session, if the document's latest history item is one of a gradient's steps that
   * Finish did not record. Undo and redo that land on such a step make that gradient pending
   * again, as it was after the step, its options included (owner request); any other latest item
   * ends the session.
   */
  #live(): GradientSession | undefined {
    return this.#session;
  }

  pendingSession(): object | undefined {
    return this.#session?.key;
  }

  /**
   * Takes up the gradient a history item kept, or lets go of the pending one (TL-FRAME-01). The
   * layer already shows the gradient, so nothing is written or recorded; the next change renders
   * it afresh. A gradient of another session renders over the layer as it was before that
   * session's first item, read from the history.
   */
  async restoreStep(state: unknown, context: StepContext | undefined): Promise<void> {
    this.#frames.cancel();
    this.#edits.cancel();
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag !== undefined) drag.session.render?.renderer.cancel();
    const draw = this.#draw;
    this.#draw = undefined;
    if (draw !== undefined) this.#dispose(draw);
    const snapshot = state as GradientSnapshot | undefined;
    const settings = this.#host.settings();
    if (snapshot === undefined || context === undefined) {
      if (context !== undefined) this.#options.leave(settings);
      else this.#options.edited();
      this.#end();
      this.#refresh();
      return;
    }
    let session = this.#session;
    const fromIdle = session === undefined;
    if (
      session === undefined ||
      session.key !== context.session ||
      session.layer !== context.layer ||
      session.layer.pixels !== session.store
    ) {
      const { tiles } = await context.before();
      if (session !== undefined) this.#dispose(session);
      const { layer } = context;
      session = {
        document: context.document,
        layer,
        base: new LayerSnapshot(layer.pixels, tiles),
        primary: snapshot.primary,
        secondary: snapshot.secondary,
        reversed: snapshot.reversed,
        start: snapshot.start,
        end: snapshot.end,
        render: undefined,
        recorded: undefined,
        shown: false,
        recordedKey: undefined,
        held: false,
        store: layer.pixels,
        state: snapshot,
        key: context.session,
      };
    }
    this.#dispose(session);
    session.start = snapshot.start;
    session.end = snapshot.end;
    session.primary = snapshot.primary;
    session.secondary = snapshot.secondary;
    session.reversed = snapshot.reversed;
    session.state = snapshot;
    this.#session = session;
    this.#options.enter(settings, snapshot.options, fromIdle);
    session.recorded = new LayerSnapshot(session.layer.pixels);
    session.recordedKey = this.#renderKey(session);
    session.shown = false;
    this.#refresh();
  }

  /** Runs `action`, which writes settings, without taking the writes as option changes. */
  #quietly(action: () => void): void {
    const quiet = this.#quiet;
    this.#quiet = true;
    try {
      action();
    } finally {
      this.#quiet = quiet;
    }
  }

  #end(): void {
    const session = this.#session;
    this.#session = undefined;
    this.#draw = undefined;
    this.#drag = undefined;
    if (session !== undefined && this.#settling === undefined) this.#dispose(session);
    gradientHandles.set({});
  }

  /** Shows the handles of the pending gradient, and sets the status text (TL-GRAD-01). */
  #refresh(): void {
    const session = this.#live();
    const handles: GradientHandles =
      session === undefined
        ? {}
        : { start: session.start, end: session.end, move: midpoint(session.start, session.end) };
    gradientHandles.set(handles);
    this.#host.status?.(this.#statusText());
  }

  #statusText(): string {
    const adjusting = this.#draw ?? this.#drag?.session;
    if (adjusting !== undefined) {
      return this.#host.translate(
        "tool.status.gradientAdjust",
        gradientMeasure(adjusting.start, adjusting.end),
      );
    }
    if (this.#live() !== undefined) return this.#host.translate("tool.status.gradientPending");
    return this.#host.translate("tool.help.gradient");
  }

  #optionChanged(change: SettingChange): void {
    if (this.#quiet || change.source !== "local") return;
    if (isColorChange(change)) {
      this.#colorChanged();
      return;
    }
    const name = OPTION_HISTORY_NAMES[change.path];
    const inHand = this.#draw ?? this.#drag?.session;
    const session = inHand ?? this.#live();
    if (session === undefined || name === undefined) return;
    // A burst of changes records one step, named after the latest (TL-FRAME-02).
    if (inHand !== undefined) this.#previewOnNextFrame(inHand);
    else this.#edits.changed(name);
    this.#refresh();
  }

  /**
   * Renders the gradient in hand with the new colors (TL-FRAME-01). A drawing or a drag shows them
   * on its next frame and records them with its own step; a pending gradient records "Change Color".
   */
  #colorChanged(): void {
    const settings = this.#host.settings();
    const inHand = this.#draw ?? this.#drag?.session;
    const session = inHand ?? this.#live();
    if (settings === null || session === undefined) return;
    const { primary, secondary } = primaryAndSecondary(settings);
    if (sameColor(primary, session.primary) && sameColor(secondary, session.secondary)) return;
    session.primary = primary;
    session.secondary = secondary;
    if (inHand !== undefined) this.#previewOnNextFrame(inHand);
    else this.#edits.changed("history.changeColor");
  }

  /** The pending gradient while no drawing or handle drag is in progress. */
  #idle(): GradientSession | undefined {
    return this.#draw === undefined && this.#drag === undefined ? this.#live() : undefined;
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/** The runtime of the Gradient tool (TL-GRAD-01). */
export function gradientToolRuntime(host: PaintHost): ToolRuntime {
  return new GradientRuntime(host);
}
