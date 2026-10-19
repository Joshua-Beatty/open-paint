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
  rectContainsRect,
  rectFromEdges,
  type Selection,
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
import { PRIMARY_COLOR_PATH, SECONDARY_COLOR_PATH } from "../colors/use-colors";
import { CROSSHAIR_CURSOR, GRAB_CURSOR, GRABBING_CURSOR, nearHandle } from "./cursors";
import { EditBurst, isColorChange, paintColors, sameColor } from "./edit-burst";
import { floodMask, toleranceOf } from "./flood";
import { hatchAligned, LayerSnapshot } from "./layer-patch";
import { blendValue, hatchValue, selectionCoverage } from "./paint-stroke";
import type { PaintHost } from "./paint-tools";
import type { SettingSnapshot } from "./pending-steps";
import type { PixelPoint } from "./select-geometry";
import { reportToolFailure } from "./tool-failure";
import {
  layerIndex,
  PendingOptions,
  recordStep,
  type StepContext,
  type StepKind,
  type SteppedRuntime,
} from "./tool-history";
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

/** The settings a fill step depends on, which undo and redo restore, colors included. */
const OPTION_PATHS = [
  ...Object.keys(OPTION_HISTORY_NAMES),
  PRIMARY_COLOR_PATH,
  SECONDARY_COLOR_PATH,
];

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

/**
 * A pending fill as one of its history items keeps it (TL-FRAME-01): everything needed to take it
 * up again and fill it as it was.
 */
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
  /** The button that clicked, which decides which color is `color` (TL-FRAME-03). */
  readonly button: number;
  /** Shift forced Global for the click. */
  readonly forceGlobal: boolean;
  /** The selection the fill is clipped to, as it was when the fill was clicked (TL-FRAME-04). */
  readonly clip: Selection;
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
  /** The selection the fill is clipped to, kept from the click. */
  readonly clip: Selection;
  /** The state the history stands at. */
  step: BucketStep;
  /** Whether the fill's first step is recorded. */
  recorded: boolean;
  /** Names the fill's history items (`ToolStep.session`). */
  readonly key: object;
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
class PaintBucketRuntime implements SteppedRuntime {
  readonly #host: PaintHost;
  #session: BucketSession | undefined;
  #drag: { readonly session: BucketSession; seed: PixelPoint } | undefined;
  #busy = false;
  #queued:
    | {
        readonly session: BucketSession;
        readonly name: MessageId | undefined;
        readonly seed: PixelPoint;
      }
    | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Set while the runtime writes option values back, so their change events are ignored. */
  #restoring = false;
  /** The option values of the pending fill on the options bar. */
  readonly #options: PendingOptions;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;
  /**
   * Option and color changes of the pending fill: previewed per frame, a burst recorded as one step
   * named after its latest change (TL-FRAME-02).
   */
  readonly #edits: EditBurst;
  /**
   * The pixels a preview of the burst wrote over, as the last recorded step left them, so they are
   * put back before the burst is recorded.
   */
  #shown: { readonly region: Rect; readonly pixels: Surface } | undefined;

  constructor(host: PaintHost) {
    this.#host = host;
    this.#options = new PendingOptions(OPTION_PATHS, (action) => {
      const restoring = this.#restoring;
      this.#restoring = true;
      try {
        action();
      } finally {
        this.#restoring = restoring;
      }
    });
    this.#edits = new EditBurst({
      ...(host.scheduleFrame && { scheduleFrame: host.scheduleFrame }),
      preview: () => this.#guard(() => this.#previewEdits()),
      record: (name) => this.#guard(() => this.#recordEdits(name as MessageId)),
    });
  }

  activate(): void {
    this.#unsubscribe = this.#host.settings()?.onChange((change) => this.#optionChanged(change));
  }

  deactivate(): void {
    this.#edits.flush();
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
    this.#edits.flush();
    if (this.#busy) return;
    const session = this.#live();
    if (session === undefined) return;
    const { step } = session;
    if (isEmptyRect(step.painted)) {
      this.#end();
      return;
    }
    this.#record(
      session,
      this.#host.translate("history.finishPaintBucket"),
      step.painted,
      () => undefined,
      step,
      "finish",
    );
    this.#end();
  }

  pendingSession(): object | undefined {
    const session = this.#session;
    return session?.recorded === true ? session.key : undefined;
  }

  /**
   * Takes up the fill a history item kept, or lets go of the pending one (TL-FRAME-01), even after
   * a tool switch. The layer already shows the fill, so nothing is written or recorded. A fill of
   * another session floods the layer as it was before that session's first item, read from the
   * history.
   */
  async restoreStep(state: unknown, context: StepContext | undefined): Promise<void> {
    this.#edits.cancel();
    this.#shown = undefined;
    this.#drag = undefined;
    this.#queued = undefined;
    const step = state as BucketStep | undefined;
    const settings = this.#host.settings();
    if (step === undefined || context === undefined) {
      if (context !== undefined) this.#options.leave(settings);
      else this.#options.edited();
      this.#end();
      return;
    }
    let session = this.#session;
    const fromIdle = session?.recorded !== true;
    if (
      session === undefined ||
      session.key !== context.session ||
      session.layer !== context.layer
    ) {
      const { tiles } = await context.before();
      const { document, layer } = context;
      session = {
        document,
        layer,
        button: step.button,
        color: step.color,
        background: step.background,
        fill: undefined,
        layerBase: new LayerSnapshot(layer.pixels, tiles).read(
          rect(0, 0, document.width, document.height),
        ),
        imageBase: undefined,
        forceGlobal: step.forceGlobal,
        clip: step.clip,
        step,
        recorded: true,
        key: context.session,
      };
    }
    session.step = step;
    session.recorded = true;
    session.color = step.color;
    session.background = step.background;
    this.#session = session;
    this.#options.enter(settings, step.options, fromIdle);
    this.#showHandles();
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
    this.#edits.flush();
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
      options: this.#options.snapshot(settings),
      ...colors,
      button: event.button,
      forceGlobal: event.shiftKey,
      clip: document.selection,
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
      clip: document.selection,
      step: initial,
      recorded: false,
      key: {},
    };
    this.#session = session;
    this.#refresh(session, "history.paintBucket", seed);
  }

  /**
   * Floods `seed` under the current settings, then fills the stencil as one history step named
   * `name`. A request that comes while a flood runs waits for it, and the latest one runs after.
   */
  #refresh(session: BucketSession, name: MessageId | undefined, seed: PixelPoint): void {
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
        // Without a name the flood is a preview of options still changing (`#previewEdits`).
        if (name === undefined) this.#showFill(session, mask);
        else this.#paint(session, mask, name, seed);
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
      options: this.#options.snapshot(settings),
      color: session.color,
      background: session.background,
      button: session.button,
      forceGlobal: session.forceGlobal,
      clip: session.clip,
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
      session.recorded ? "edit" : "draw",
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
      session.clip,
      work,
      read("selection.renderingQuality") === "Aliased",
    );
    const output = coverage === undefined ? filled : clipToCoverage(original, filled, coverage);
    return { work, output };
  }

  /**
   * Applies `edit` to `area` as one history item that keeps the fill's state on either side, and
   * makes `step` the state it ends.
   */
  #record(
    session: BucketSession,
    name: string,
    area: Rect,
    edit: PixelEdit,
    step: BucketStep,
    kind: StepKind,
  ): void {
    const { document, layer } = session;
    recordStep(
      document,
      {
        tool: "paintBucket",
        layer: layerIndex(document, layer),
        kind,
        session: session.key,
        before: kind === "draw" ? undefined : session.step,
        after: kind === "finish" ? undefined : step,
      },
      () => document.editLayerPixels(name, layer, area, edit),
    );
    session.step = step;
    session.recorded = true;
    this.#options.edited();
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
    this.#edits.changed(name);
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
    this.#edits.changed("history.changeColor");
  }

  /** The stencil of the step the session stands at, when it is known without a new flood. */
  #currentFill(session: BucketSession): BucketFill | undefined {
    const fill = session.fill;
    return fill !== undefined && fill.step === session.step ? fill : undefined;
  }

  /**
   * Shows the pending fill under the changed options and colors, with no history item: the stencil
   * the step filled in the new colors when only colors changed, or a new flood otherwise.
   */
  #previewEdits(): void {
    const session = this.#live();
    if (session === undefined) return;
    const fill = this.#currentFill(session);
    if (fill !== undefined && this.#onlyColors(session)) {
      this.#showFill(session, fill.mask, fill.area);
      return;
    }
    this.#refresh(session, undefined, session.step.seed);
  }

  /**
   * Records the burst as one step named `name`. The layer first goes back to the recorded step,
   * so the item's before-state is right. A burst that changed nothing records nothing.
   */
  #recordEdits(name: MessageId): void {
    const session = this.#live();
    if (session === undefined) return;
    this.#unshow(session);
    const fill = this.#currentFill(session);
    if (fill !== undefined && this.#onlyColors(session)) {
      const { step } = session;
      if (sameColor(session.color, step.color) && sameColor(session.background, step.background)) {
        return;
      }
      this.#paint(session, fill.mask, name, step.seed);
      return;
    }
    this.#refresh(session, name, session.step.seed);
  }

  /** Whether the options a fill depends on are those of the step it stands at. */
  #onlyColors(session: BucketSession): boolean {
    const settings = this.#host.settings();
    const now = this.#options.snapshot(settings);
    const then = session.step.options;
    return Object.keys(OPTION_HISTORY_NAMES).every(
      (path) => JSON.stringify(now[path]) === JSON.stringify(then[path]),
    );
  }

  /**
   * Shows the fill of `mask` over the session's base, with no history item, as `#paint` would
   * record it. The pixels it writes over are kept first, so `#unshow` can put them back.
   */
  #showFill(session: BucketSession, mask: Uint8Array, known?: Rect): void {
    const { document, layer, layerBase } = session;
    const area = known ?? stencilBounds(mask, document.width, document.height);
    if (isEmptyRect(area)) return;
    const { work, output } = this.#fill(session, mask, area);
    const { painted } = session.step;
    const region = isEmptyRect(painted) ? area : unionRects(painted, area);
    const written = intersectRects(work, region);
    const shown = this.#shown;
    if (shown === undefined) {
      this.#shown = { region, pixels: layer.pixels.readRegion(region) };
    } else if (!rectContainsRect(shown.region, region)) {
      const grown = unionRects(shown.region, region);
      const pixels = layer.pixels.readRegion(grown);
      pixels.copyFrom(
        shown.pixels,
        shown.pixels.bounds,
        shown.region.x - grown.x,
        shown.region.y - grown.y,
      );
      this.#shown = { region: grown, pixels };
    }
    document.previewLayerPixels(layer, (pixels) => {
      pixels.writeRegion(layerBase, region.x, region.y, region);
      pixels.writeRegion(output, written.x, written.y, translateRect(written, -work.x, -work.y));
    });
  }

  /** Puts back what the burst's previews wrote over. */
  #unshow(session: BucketSession): void {
    const shown = this.#shown;
    this.#shown = undefined;
    if (shown === undefined) return;
    session.document.restoreLayerPixels(session.layer, (pixels) => {
      pixels.writeRegion(shown.pixels, shown.region.x, shown.region.y);
    });
  }
  #guard(work: () => void): void {
    try {
      work();
    } catch (cause) {
      this.#fail(cause);
    }
  }

  /** The pending session. */
  #live(): BucketSession | undefined {
    return this.#session;
  }
  #end(): void {
    this.#edits.cancel();
    this.#shown = undefined;
    this.#session = undefined;
    this.#drag = undefined;
    wandHandles.set({});
  }

  #showHandles(): void {
    const session = this.#session;
    if (session === undefined) {
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
