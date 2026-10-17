import {
  type ColorRgba8,
  type Document,
  EMPTY_RECT,
  flattenRegion,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rect,
  rectFromEdges,
  Surface,
  TiledPixelStore,
  translateRect,
  unionRects,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { bucketFillCpu } from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import { ColorEdits, isColorChange, paintColors, sameColor } from "./color-edits";
import { CROSSHAIR_CURSOR, GRAB_CURSOR, GRABBING_CURSOR, nearHandle } from "./cursors";
import { floodMask, toleranceOf } from "./flood";
import { hatchAligned } from "./layer-patch";
import { blendValue, hatchValue, selectionCoverage } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import {
  PendingSteps,
  restoreSettings,
  type SettingSnapshot,
  snapshotSettings,
} from "./pending-steps";
import type { PixelPoint } from "./select-geometry";
import { reportToolFailure } from "./tool-failure";
import { wandHandles } from "./wand-handles";

/** The history name of each option change made while a fill is pending (TL-FRAME-02). */
const OPTION_HISTORY_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.brush.fillType": "history.changeFill",
  "tools.brush.hatchStyle": "history.changeFill",
  "tools.blendMode": "history.changeBlendMode",
  "tools.antialiasing": "history.toggleAntialiasing",
  "tools.selection.renderingQuality": "history.changeSelectionQuality",
  "tools.tolerance": "history.changeTolerance",
  "tools.toleranceAlphaMode": "history.changeToleranceAlphaMode",
  "tools.floodMode": "history.changeFloodMode",
  "tools.sampleAllLayers": "history.changeSampling",
};

/** The settings a fill step depends on, which undo and redo restore. */
const OPTION_PATHS = Object.keys(OPTION_HISTORY_NAMES);

type PixelEdit = Parameters<Document["editLayerPixels"]>[3];

function pixelOf(event: ToolPointerEvent): PixelPoint {
  return { x: Math.floor(event.x), y: Math.floor(event.y) };
}

/** Whether a sample is on the origin handle of `seed` (TL-FRAME-06), measured in CSS pixels. */
function onOrigin(event: ToolPointerEvent, seed: PixelPoint): boolean {
  return nearHandle(event, { x: seed.x + 0.5, y: seed.y + 0.5 });
}

function insideImage(point: PixelPoint, document: Document): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < document.width && point.y < document.height;
}

/** The smallest rectangle around the stencil's set pixels, or the empty rectangle when none is set. */
function stencilBounds(mask: Uint8Array, width: number, height: number): Rect {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return right === 0 ? EMPTY_RECT : rectFromEdges(left, top, right, bottom);
}

/** The part of a `width`-wide stencil that lies under `area`. */
function cropMask(mask: Uint8Array, width: number, area: Rect): Uint8Array {
  const out = new Uint8Array(area.width * area.height);
  for (let y = 0; y < area.height; y++) {
    const from = (area.y + y) * width + area.x;
    out.set(mask.subarray(from, from + area.width), y * area.width);
  }
  return out;
}

/**
 * The flattened image before the session (TL-OPT-FLOOD), composited once when first needed. While
 * no step has painted, the layer still holds its base; otherwise the base stands in for it.
 */
function imageBaseOf(session: BucketSession): Surface {
  if (session.imageBase !== undefined) return session.imageBase;
  const { document, layer, layerBase } = session;
  const bounds = rect(0, 0, document.width, document.height);
  if (isEmptyRect(session.step.painted)) {
    session.imageBase = document.composite();
    return session.imageBase;
  }
  const base = new TiledPixelStore(document.width, document.height);
  try {
    base.writeRegion(layerBase, 0, 0);
    const visible = document.layers
      .filter((candidate) => candidate.visible)
      .map((candidate) =>
        candidate === layer
          ? { blendMode: candidate.blendMode, opacity: candidate.opacity, pixels: base }
          : candidate,
      );
    session.imageBase = flattenRegion(visible, bounds);
  } finally {
    base.dispose();
  }
  return session.imageBase;
}

/** The state of a fill after one of its steps (TL-FRAME-01). */
interface BucketStep {
  /** The flood's origin, moved by the origin handle (TL-BUCKET-01). */
  readonly seed: PixelPoint;
  /** The area the steps have changed so far. Empty until the first step lands. */
  readonly painted: Rect;
  /** The option values of the step, written back when undo or redo lands on it. */
  readonly options: SettingSnapshot;
  /** The fill colors of the step, which undo and redo give back to the pending fill. */
  readonly color: ColorRgba8;
  readonly background: ColorRgba8;
  /** Whether Finish recorded this step. A finished fill is no longer pending. */
  readonly finished: boolean;
}

/** The stencil a step filled: the flood's mask, its set pixels' bounds, and the pixels it wrote. */
interface BucketFill {
  readonly step: BucketStep;
  readonly mask: Uint8Array;
  readonly area: Rect;
  readonly written: Rect;
}

/**
 * A Paint Bucket fill that is still pending, or Dirty (TL-FRAME-01). It stays editable until it is
 * committed, or until a history item that is not one of its steps becomes the latest (another
 * edit, or undo or redo past the session's start).
 */
interface BucketSession {
  readonly document: Document;
  readonly layer: Layer;
  /** The button that clicked, which decides which color is color (TL-FRAME-03). */
  readonly button: number;
  /** The fill color: primary for the left button, secondary for the right (TL-FRAME-03). */
  color: ColorRgba8;
  /** The other color, which the clear pixels of a hatch take. */
  background: ColorRgba8;
  /**
   * The stencil the latest step filled, and where, so a color change fills it again without a new
   * flood. It belongs to step only.
   */
  fill: BucketFill | undefined;
  /** The layer before the session. Every step fills a copy of it, so the steps never stack. */
  readonly layerBase: Surface;
  /**
   * The flattened image before the session, which "Image" sampling reads (TL-OPT-FLOOD). It is
   * composited the first time a flood samples the image, not on every click (L8).
   */
  imageBase: Surface | undefined;
  /** Shift forced Global for the click. Later recomputes keep it. */
  readonly forceGlobal: boolean;
  readonly steps: PendingSteps<BucketStep>;
  /** The state the history stands at. */
  step: BucketStep;
  /** Stops the listener that follows undo and redo. */
  readonly stopListening: () => void;
}

/**
 * The runtime of the Paint Bucket (TL-BUCKET-01). A click floods the pixels within the tolerance of
 * the clicked pixel, contiguous or Global (Shift forces Global for that click), and fills them with
 * the primary color (left button) or the secondary color (right button). Each click, option change
 * and origin move records one history step on the layer, named after the change. Dragging the
 * origin handle re-seeds the flood as "Move Origin". Enter, Esc, the Finish button or a click
 * elsewhere commits the fill with "Finish Paint Bucket". Undo and redo move the pending fill to the
 * state of the step they land on, options included, so it stays Dirty. A flood runs in the WASM
 * worker, and while it runs the spinner shows and pointer input waits.
 */
class PaintBucketRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  #session: BucketSession | undefined;
  #drag: { readonly session: BucketSession; seed: PixelPoint } | undefined;
  #busy = false;
  #queued:
    | { readonly session: BucketSession; readonly name: MessageId; readonly seed: PixelPoint }
    | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Set while the runtime writes option values back, so their change events are ignored. */
  #restoring = false;
  /** Set while the runtime changes the document, so its own changes are not read as undo or redo. */
  #writing = false;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;
  /** Color changes of the pending fill: drawn per frame, recorded as one "Change Color" step. */
  readonly #colors: ColorEdits;
  /** The session whose fill shows a color change that is not recorded yet. */
  #recolored: BucketSession | undefined;

  constructor(host: PaintHost) {
    this.#host = host;
    this.#colors = new ColorEdits({
      ...(host.scheduleFrame && { scheduleFrame: host.scheduleFrame }),
      preview: () => this.#guard(() => this.#previewColors()),
      record: () => this.#guard(() => this.#recordColors()),
    });
  }

  activate(): void {
    this.#unsubscribe = this.#host.settings()?.onChange((change) => this.#optionChanged(change));
  }

  deactivate(): void {
    this.#colors.flush();
    this.cancel();
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

  /** A crosshair to fill, and an open hand over the origin handle, closed while it is dragged. */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    if (this.#drag !== undefined) return GRABBING_CURSOR;
    const session = this.#live();
    const hover = this.#hover;
    if (session !== undefined && hover !== undefined && onOrigin(hover, session.step.seed)) {
      return GRAB_CURSOR;
    }
    return CROSSHAIR_CURSOR;
  }

  hasPending(): boolean {
    return this.#live() !== undefined;
  }

  /** Commits the pending fill with "Finish Paint Bucket". A flood still running waits for the next key. */
  commit(): void {
    if (this.#drag !== undefined) this.cancel();
    this.#colors.flush();
    if (this.#busy) return;
    const session = this.#live();
    if (session === undefined) return;
    const { step } = session;
    if (isEmptyRect(step.painted)) return;
    this.#record(
      session,
      this.#host.translate("history.finishPaintBucket"),
      step.painted,
      () => undefined,
      { ...step, finished: true },
    );
  }

  /** Stops an origin drag. The fill is not changed and nothing is recorded. */
  cancel(): void {
    if (this.#drag === undefined) return;
    this.#drag = undefined;
    this.#showHandles();
  }

  #down(event: ToolPointerEvent): void {
    if (this.#busy || this.#drag !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    this.#colors.flush();
    const session = this.#live();
    if (session !== undefined) {
      const seed = session.step.seed;
      if (onOrigin(event, seed)) {
        this.#drag = { session, seed };
        this.#showHandles();
        return;
      }
    }
    this.#click(event);
  }

  #click(event: ToolPointerEvent): void {
    const settings = this.#host.settings();
    const document = this.#host.document();
    if (settings === null || document === undefined) return;
    const seed = pixelOf(event);
    if (!insideImage(seed, document)) return;
    this.commit();
    this.#end();
    const layer = document.activeLayer;
    if (layer === undefined) return;
    const colors = paintColors(settings, event.button);
    const { width, height } = document;
    const initial: BucketStep = {
      seed,
      painted: EMPTY_RECT,
      options: snapshotSettings(settings, OPTION_PATHS),
      ...colors,
      finished: false,
    };
    const session: BucketSession = {
      document,
      layer,
      button: event.button,
      ...colors,
      fill: undefined,
      layerBase: layer.pixels.readRegion({ x: 0, y: 0, width, height }),
      imageBase: undefined,
      forceGlobal: event.shiftKey,
      steps: new PendingSteps(document.history.appliedCommands.at(-1), initial),
      step: initial,
      stopListening: document.subscribe(() => this.#sync()),
    };
    this.#session = session;
    this.#refresh(session, "history.paintBucket", seed);
  }

  /**
   * Floods `seed` under the current settings, then fills the stencil as one history step named
   * `name`. A request that comes while a flood runs waits for it, and the latest one runs after.
   */
  #refresh(session: BucketSession, name: MessageId, seed: PixelPoint): void {
    if (this.#busy) {
      this.#queued = { session, name, seed };
      return;
    }
    const settings = this.#host.settings();
    if (settings === null) return;
    const read = (key: string) => settings.get(`tools.${key}`);
    this.#busy = true;
    const base = session.step;
    this.#showHandles();
    const source = read("sampleAllLayers") === true ? imageBaseOf(session) : session.layerBase;
    const global = session.forceGlobal || read("floodMode") === "Global";
    floodMask(source, {
      seed,
      tolerance: toleranceOf(read("tolerance")),
      straight: read("toleranceAlphaMode") === "Straight",
      global,
    })
      .then((mask) => {
        // A newer request for this session paints the settled state, and an undo or redo that
        // moved the session makes this flood stale, so this one records nothing.
        if (this.#live() !== session || session.step !== base || this.#queued?.session === session)
          return;
        this.#paint(session, mask, name, seed);
      })
      .catch((cause: unknown) => this.#fail(cause))
      .finally(() => {
        this.#busy = false;
        const queued = this.#queued;
        this.#queued = undefined;
        if (queued !== undefined && this.#live() === queued.session) {
          this.#refresh(queued.session, queued.name, queued.seed);
        } else {
          this.#showHandles();
        }
      });
  }

  /**
   * Fills the stencil over the session's base as one history item named `name`. The item covers
   * the area of every earlier step too, so undo restores each one in turn. Selection clipping
   * (TL-FRAME-04) and the fill options are read here.
   */
  #paint(session: BucketSession, mask: Uint8Array, name: MessageId, seed: PixelPoint): void {
    const settings = this.#host.settings();
    if (settings === null) return;
    const { document, layerBase } = session;
    const area = stencilBounds(mask, document.width, document.height);
    if (isEmptyRect(area)) return;
    const { work, output } = this.#fill(session, mask, area);
    const painted = isEmptyRect(session.step.painted)
      ? area
      : unionRects(session.step.painted, area);
    const written = intersectRects(work, painted);
    const step: BucketStep = {
      seed,
      painted,
      options: snapshotSettings(settings, OPTION_PATHS),
      color: session.color,
      background: session.background,
      finished: false,
    };
    this.#record(
      session,
      this.#host.translate(name),
      painted,
      (pixels) => {
        pixels.writeRegion(layerBase, painted.x, painted.y, painted);
        pixels.writeRegion(output, written.x, written.y, translateRect(written, -work.x, -work.y));
      },
      step,
    );
    if (session.step === step) session.fill = { step, mask, area, written };
  }

  /**
   * The stencil's rectangle filled over the session's base with the session's colors and the fill
   * options, clipped to the selection (TL-FRAME-04).
   */
  #fill(
    session: BucketSession,
    mask: Uint8Array,
    area: Rect,
    colors: { readonly color: ColorRgba8; readonly background: ColorRgba8 } = session,
  ): { readonly work: Rect; readonly output: Surface } {
    const settings = this.#host.settings();
    const read = (key: string) => settings?.get(`tools.${key}`);
    const { document, layerBase } = session;
    // Only the stencil's rectangle is filled (L2). The antialiasing feather reads one pixel around
    // each stencil pixel, and the hatch repeats from the layer origin, so the work area grows by
    // one pixel and starts on the hatch grid, which gives the same pixels as a whole-layer fill.
    const antialias = read("antialiasing") !== false;
    const work = hatchAligned(
      rectFromEdges(area.x - 1, area.y - 1, area.x + area.width + 1, area.y + area.height + 1),
      layerBase.bounds,
    );
    const original = new Surface(work.width, work.height);
    original.copyFrom(layerBase, work, 0, 0);
    const filled = bucketFillCpu(original, cropMask(mask, document.width, work), {
      antialias,
      blend: blendValue(read("blendMode")),
      hatch: hatchValue(read("brush.fillType"), read("brush.hatchStyle")),
      color: colors.color,
      background: colors.background,
    });
    const coverage = selectionCoverage(
      document.selection,
      work,
      read("selection.renderingQuality") === "Aliased",
    );
    const output = coverage === undefined ? filled : clipToCoverage(original, filled, coverage);
    return { work, output };
  }

  /** Applies `edit` to `area` as one history item, and records `step` as the state it ends. */
  #record(
    session: BucketSession,
    name: string,
    area: Rect,
    edit: PixelEdit,
    step: BucketStep,
  ): void {
    this.#write(() => session.document.editLayerPixels(name, session.layer, area, edit));
    const command = session.document.history.appliedCommands.at(-1);
    if (command === undefined) return;
    session.steps.record(command, step);
    session.step = step;
    this.#showHandles();
  }

  #move(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || event.predicted === true) return;
    drag.seed = pixelOf(event);
    this.#showHandles();
  }

  /** Re-seeds the flood at the release point, as one "Move Origin" step, if the origin moved. */
  #up(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    const session = this.#live();
    const seed = pixelOf(event);
    const moved = seed.x !== drag.session.step.seed.x || seed.y !== drag.session.step.seed.y;
    if (
      session === undefined ||
      session !== drag.session ||
      !moved ||
      !insideImage(seed, session.document)
    ) {
      this.#showHandles();
      return;
    }
    this.#refresh(session, "history.moveOrigin", seed);
  }

  #optionChanged(change: SettingChange): void {
    if (this.#restoring || change.source !== "local") return;
    if (isColorChange(change)) {
      this.#colorChanged();
      return;
    }
    const name = OPTION_HISTORY_NAMES[change.path];
    const session = this.#live();
    if (session === undefined || name === undefined) return;
    this.#colors.flush();
    this.#refresh(session, name, session.step.seed);
  }

  /**
   * Fills the pending stencil with the new colors (TL-FRAME-01). A flood in flight paints with them
   * when it lands; otherwise the fill shows them on the next frame and records "Change Color".
   */
  #colorChanged(): void {
    const settings = this.#host.settings();
    const session = this.#live();
    if (settings === null || session === undefined) return;
    const { color, background } = paintColors(settings, session.button);
    if (sameColor(color, session.color) && sameColor(background, session.background)) return;
    session.color = color;
    session.background = background;
    if (!this.#busy) this.#colors.changed();
  }

  /** The stencil of the step the session stands at, when it is known without a new flood. */
  #currentFill(session: BucketSession): BucketFill | undefined {
    const fill = session.fill;
    return fill !== undefined && fill.step === session.step ? fill : undefined;
  }

  /** Shows the stencil in the session's colors, with no history item. */
  #previewColors(): void {
    const session = this.#live();
    if (session === undefined || this.#busy) return;
    const fill = this.#currentFill(session);
    if (fill === undefined) return;
    this.#show(session, fill, session);
    this.#recolored = session;
  }

  /**
   * Records the color change as one step. The layer first goes back to the step's own colors, so
   * the item's before-state is the recorded one. Colors changed back to the step's record nothing.
   */
  #recordColors(): void {
    const session = this.#live();
    if (session === undefined) return;
    const fill = this.#currentFill(session);
    if (this.#busy || fill === undefined) {
      this.#refresh(session, "history.changeColor", session.step.seed);
      return;
    }
    if (this.#recolored === session) {
      this.#recolored = undefined;
      this.#show(session, fill, session.step, true);
    }
    const { step } = session;
    if (sameColor(session.color, step.color) && sameColor(session.background, step.background)) {
      return;
    }
    this.#paint(session, fill.mask, "history.changeColor", step.seed);
  }

  /**
   * Writes the stencil filled in colors over the pixels it covers, as a preview, or, with
   * estore, as the recorded state coming back.
   */
  #show(
    session: BucketSession,
    fill: BucketFill,
    colors: { readonly color: ColorRgba8; readonly background: ColorRgba8 },
    restore = false,
  ): void {
    const { work, output } = this.#fill(session, fill.mask, fill.area, colors);
    const { written } = fill;
    const write = (pixels: Layer["pixels"]) => {
      pixels.writeRegion(output, written.x, written.y, translateRect(written, -work.x, -work.y));
    };
    this.#write(() => {
      if (restore) session.document.restoreLayerPixels(session.layer, write);
      else session.document.previewLayerPixels(session.layer, write);
    });
  }

  #guard(work: () => void): void {
    try {
      work();
    } catch (cause) {
      this.#fail(cause);
    }
  }

  /** Follows the history after an undo, redo or other change. Our own writes are not followed. */
  #sync(): void {
    if (this.#writing) return;
    this.#current();
  }

  /** Runs `action` as a document change of this runtime. */
  #write(action: () => void): void {
    this.#writing = true;
    try {
      action();
    } finally {
      this.#writing = false;
    }
  }

  /**
   * The session, if the document's latest history item is one of its steps. Undo and redo move
   * it to that step's state, with the option values of the step. A session whose latest item is
   * anything else has ended.
   */
  #current(): BucketSession | undefined {
    const session = this.#session;
    if (session === undefined) return undefined;
    const state = session.steps.locate(session.document.history.appliedCommands.at(-1));
    if (state === undefined) {
      this.#end();
      return undefined;
    }
    if (state !== session.step) this.#adopt(session, state);
    return session;
  }

  /** The pending session, unless it is committed (a finished fill is not pending). */
  #live(): BucketSession | undefined {
    const session = this.#current();
    return session?.step.finished === true ? undefined : session;
  }

  #adopt(session: BucketSession, state: BucketStep): void {
    session.step = state;
    session.color = state.color;
    session.background = state.background;
    const settings = this.#host.settings();
    if (settings !== null) {
      this.#restoring = true;
      try {
        restoreSettings(settings, state.options);
      } finally {
        this.#restoring = false;
      }
    }
    this.#showHandles();
  }

  #end(): void {
    this.#colors.cancel();
    this.#recolored = undefined;
    this.#session?.stopListening();
    this.#session = undefined;
    this.#drag = undefined;
    wandHandles.set({});
  }

  #showHandles(): void {
    const session = this.#session;
    if (session === undefined || session.step.finished) {
      wandHandles.set({});
      return;
    }
    wandHandles.set({
      seed: this.#drag?.seed ?? session.step.seed,
      busy: this.#busy ? session.step.seed : undefined,
    });
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/** The runtime of the Paint Bucket (TL-BUCKET-01). */
export function paintBucketToolRuntime(host: PaintHost): ToolRuntime {
  return new PaintBucketRuntime(host);
}
