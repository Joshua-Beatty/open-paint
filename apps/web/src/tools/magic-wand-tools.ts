import {
  type Document,
  maskRunPolygons,
  rect,
  Selection,
  type SelectionCombineMode,
  type SelectionPolygon,
  type Surface,
} from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import { ClickDeadZone } from "@openpaint/tools";
import {
  CROSSHAIR_CURSOR,
  GRAB_CURSOR,
  GRABBING_CURSOR,
  MOVE_CURSOR,
  nearHandle,
  selectionBounds,
} from "./cursors";
import { EditBurst } from "./edit-burst";
import { floodMask, toleranceOf } from "./flood";
import type { PaintHost } from "./paint-tools";
import type { SettingSnapshot } from "./pending-steps";
import { combineModeFor, combineModeOf, type PixelPoint } from "./select-geometry";
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

/** The history name of each option change made while a result is pending (TL-FRAME-02). */
const OPTION_HISTORY_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.tolerance": "history.changeTolerance",
  "tools.toleranceAlphaMode": "history.changeToleranceAlphaMode",
  "tools.floodMode": "history.changeFloodMode",
  "tools.sampleAllLayers": "history.changeSampling",
  "tools.selection.combineMode": "history.changeSelectionMode",
};

/** The settings a result depends on, which undo and redo restore. */
const OPTION_PATHS = Object.keys(OPTION_HISTORY_NAMES);

function pixelOf(event: ToolPointerEvent): PixelPoint {
  return { x: Math.floor(event.x), y: Math.floor(event.y) };
}

/** The centre of a selection's bounds, where the move handle sits, or undefined when empty. */
function handleCenter(selection: Selection): PixelPoint | undefined {
  if (selection.isEmpty) return undefined;
  const bounds = selectionBounds(selection);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** The handle of a result under a sample (TL-FRAME-06), measured in CSS pixels. */
function wandHandleAt(event: ToolPointerEvent, step: WandStep): "origin" | "move" | undefined {
  const { seed } = step;
  if (nearHandle(event, { x: seed.x + 0.5, y: seed.y + 0.5 })) return "origin";
  const center = handleCenter(step.result);
  if (center !== undefined && nearHandle(event, center)) return "move";
  return undefined;
}

/** The selection moved by `offset` pixels. */
function translated(selection: Selection, offset: PixelPoint): Selection {
  return selection.transform({ a: 1, b: 0, c: 0, d: 1, e: offset.x, f: offset.y }).commit();
}

function translatedPolygons(
  polygons: readonly SelectionPolygon[],
  offset: PixelPoint,
): readonly SelectionPolygon[] {
  if (offset.x === 0 && offset.y === 0) return polygons;
  return translated(new Selection(polygons), offset).polygons;
}

/** The pixels a flood last sampled, kept while what they were read from is unchanged. */
interface FloodSource {
  readonly key: string;
  readonly surface: Surface;
}

/**
 * What the flood samples, as a key that changes whenever its pixels do: the active layer's store
 * version, or every layer's pixels and compositing properties for "Sample all layers".
 */
function sourceKey(document: Document, sampleAll: boolean): string | undefined {
  const layer = document.activeLayer;
  if (!sampleAll)
    return layer === undefined ? undefined : `layer ${layer.id} ${layer.pixels.version}`;
  return document.layers
    .map((l) => `${l.id}:${l.visible}:${l.opacity}:${l.blendMode}:${l.pixels.version}`)
    .join(" ");
}

/**
 * The flood of one seed over the active layer, or the flattened image with "Sample all layers". The
 * result is the polygons of the mask, or undefined when there is no layer to sample. The sampled
 * pixels are kept in `session`, so changing an option does not copy or composite the image again,
 * since a wand session changes only the selection (L9).
 */
function flood(
  session: WandSession,
  seed: PixelPoint,
  global: boolean,
  read: (name: string) => unknown,
): Promise<SelectionPolygon[] | undefined> {
  const { document } = session;
  const { width, height } = document;
  const sampleAll = read("sampleAllLayers") === true;
  const key = sourceKey(document, sampleAll);
  if (key === undefined) return Promise.resolve(undefined);
  let surface = session.source?.key === key ? session.source.surface : undefined;
  if (surface === undefined) {
    surface = sampleAll
      ? document.composite()
      : document.activeLayer?.pixels.readRegion(rect(0, 0, width, height));
    if (surface === undefined) return Promise.resolve(undefined);
    session.source = { key, surface };
  }
  return floodMask(surface, {
    seed,
    tolerance: toleranceOf(read("tolerance")),
    straight: read("toleranceAlphaMode") === "Straight",
    global,
  }).then((mask) => maskRunPolygons(mask, width, height));
}

/** The state of a result after one of its steps (TL-FRAME-01). */
interface WandStep {
  /** The flood's origin, moved by the origin handle (TL-SEL-WAND-01). */
  readonly seed: PixelPoint;
  /** The selection before the session's first click, moved by the move handle. Results combine with it. */
  readonly base: Selection;
  /** The translation the move handle gave the flood's shape. */
  readonly offset: PixelPoint;
  /** The mode of the result, from the modifiers of its click or the toolbar. */
  readonly mode: SelectionCombineMode;
  /** The selection this step sets. */
  readonly result: Selection;
  /** The option values of the step, written back when undo or redo lands on it. */
  readonly options: SettingSnapshot;
  /** Shift forced Global for the click. */
  readonly forceGlobal: boolean;
}

/** The pending result of one click and its later changes (TL-FRAME-01). */
interface WandSession {
  readonly document: Document;
  /** Shift forced Global for the click. Later recomputes keep it. */
  readonly forceGlobal: boolean;
  /** The state the history stands at. */
  step: WandStep;
  /** Whether the result's first step is recorded. */
  recorded: boolean;
  /** Names the result's history items (`ToolStep.session`). */
  readonly key: object;
  /** The pixels the last flood sampled. */
  source: FloodSource | undefined;
}

/** A recompute request: the origin and mode that a flood's result uses. */
interface WandRequest {
  readonly seed: PixelPoint;
  readonly mode: SelectionCombineMode;
}

/**
 * One drag of a handle, from the press to the release. A press that stays in its click dead zone
 * changes nothing, so clicking a handle does not re-seed or move the result by a pixel.
 */
type WandDrag =
  | {
      readonly kind: "origin";
      readonly session: WandSession;
      readonly zone: ClickDeadZone;
      seed: PixelPoint;
    }
  | {
      readonly kind: "move";
      readonly session: WandSession;
      readonly zone: ClickDeadZone;
      /** The selection when the drag started. The preview moves it, and a cancel restores it. */
      readonly pre: Selection;
      readonly press: PixelPoint;
      total: PixelPoint;
    };

/**
 * The runtime of the Magic Wand (TL-SEL-WAND-01). A click floods the pixels within the tolerance of
 * the clicked pixel, contiguous or Global (Shift forces Global for that click), and records one
 * history step named "Magic Wand". The result then stays pending: changing the tolerance, the flood
 * mode, the alpha mode, the sampling or the Selection Mode recomputes it as one step each. Dragging
 * the origin handle re-seeds it, and dragging the move handle moves it. Enter, Esc or a click
 * elsewhere commits the result with "Finish Magic Wand". Undo and redo move the pending result to
 * the state of the step they land on, options included, so it stays Dirty. A flood runs in the WASM
 * worker, and while it runs the spinner shows and pointer input waits.
 */
class MagicWandRuntime implements SteppedRuntime {
  readonly #host: PaintHost;
  #session: WandSession | undefined;
  #drag: WandDrag | undefined;
  #busy = false;
  #queued:
    | {
        readonly session: WandSession;
        readonly name: MessageId | undefined;
        readonly request: WandRequest;
      }
    | undefined;
  /**
   * Option changes of the pending result: previewed per change, a burst recorded as one step named
   * after its latest change (TL-FRAME-02).
   */
  readonly #edits: EditBurst;
  /** The Selection Mode a burst of option changes has chosen, if it changed it. */
  #burstMode: SelectionCombineMode | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Set while the runtime writes option values back, so their change events are ignored. */
  #restoring = false;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;
  /** The option values of the pending result on the options bar. */
  readonly #options: PendingOptions;

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
      preview: () => this.#burst(undefined),
      record: (name) => this.#burst(name as MessageId),
    });
  }

  /** Floods the pending result under the burst's options: a preview, or the step named `name`. */
  #burst(name: MessageId | undefined): void {
    const session = this.#live();
    if (session === undefined) return;
    const mode = this.#burstMode ?? session.step.mode;
    if (name !== undefined) this.#burstMode = undefined;
    this.#refresh(session, name, { seed: session.step.seed, mode });
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

  /**
   * A crosshair to pick a pixel, an open hand over the origin handle and the move arrows over the
   * move handle (TL-FRAME-06), with a closed hand while the origin is dragged.
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    const drag = this.#drag;
    if (drag !== undefined) return drag.kind === "move" ? MOVE_CURSOR : GRABBING_CURSOR;
    const session = this.#live();
    const hover = this.#hover;
    const handle =
      session === undefined || hover === undefined ? undefined : wandHandleAt(hover, session.step);
    if (handle === "origin") return GRAB_CURSOR;
    if (handle === "move") return MOVE_CURSOR;
    return CROSSHAIR_CURSOR;
  }

  hasPending(): boolean {
    return this.#live() !== undefined;
  }

  /** Commits the pending result with "Finish Magic Wand". A flood still running waits for the next key. */
  commit(): void {
    if (this.#drag !== undefined) this.cancel();
    this.#edits.flush();
    if (this.#busy) return;
    const session = this.#live();
    if (session === undefined) return;
    if (session.recorded) {
      this.#record(
        session,
        this.#host.translate("history.finishMagicWand"),
        session.step,
        "finish",
      );
    }
    this.#end();
  }

  pendingSession(): object | undefined {
    const session = this.#session;
    return session?.recorded === true ? session.key : undefined;
  }

  /**
   * Takes up the result a history item kept, or lets go of the pending one (TL-FRAME-01), even
   * after a tool switch. The selection already shows the result, so nothing is recorded.
   */
  restoreStep(state: unknown, context: StepContext | undefined): void {
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag?.kind === "move") drag.session.document.restoreSelection(drag.pre);
    this.#queued = undefined;
    const step = state as WandStep | undefined;
    const settings = this.#host.settings();
    if (step === undefined || context === undefined) {
      if (context !== undefined) this.#options.leave(settings);
      else this.#options.edited();
      this.#end();
      return;
    }
    let session = this.#session;
    const fromIdle = session?.recorded !== true;
    if (session === undefined || session.key !== context.session) {
      session = {
        document: context.document,
        forceGlobal: step.forceGlobal,
        step,
        recorded: true,
        key: context.session,
        source: undefined,
      };
    }
    session.step = step;
    session.recorded = true;
    this.#session = session;
    this.#options.enter(settings, step.options, fromIdle);
    this.#showHandles();
  }

  /** Stops a handle drag and restores the selection it started with. Nothing is recorded. */
  cancel(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    if (drag.kind === "move") drag.session.document.restoreSelection(drag.pre);
    this.#showHandles();
  }

  #down(event: ToolPointerEvent): void {
    if (this.#busy || this.#drag !== undefined) return;
    if (event.button !== 0 && event.button !== 2) return;
    this.#edits.flush();
    const session = this.#live();
    if (session !== undefined) {
      const seed = session.step.seed;
      const handle = wandHandleAt(event, session.step);
      if (handle === "origin") {
        this.#drag = { kind: "origin", session, zone: new ClickDeadZone(event), seed };
        this.#showHandles();
        return;
      }
      if (handle === "move") {
        this.#drag = {
          kind: "move",
          session,
          zone: new ClickDeadZone(event),
          pre: session.step.result,
          press: pixelOf(event),
          total: { x: 0, y: 0 },
        };
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
    if (seed.x < 0 || seed.y < 0 || seed.x >= document.width || seed.y >= document.height) return;
    this.commit();
    this.#end();
    const read = (name: string) => settings.get(`tools.${name}`);
    const mode = combineModeFor(event, combineModeOf(read("selection.combineMode")));
    const initial: WandStep = {
      seed,
      base: document.selection,
      offset: { x: 0, y: 0 },
      mode,
      result: document.selection,
      options: this.#options.snapshot(settings),
      forceGlobal: event.shiftKey,
    };
    const session: WandSession = {
      document,
      forceGlobal: event.shiftKey,
      step: initial,
      recorded: false,
      key: {},
      source: undefined,
    };
    this.#session = session;
    this.#refresh(session, "history.magicWand", { seed, mode });
  }

  /**
   * Floods the request's seed under the current settings and sets the selection to the flood
   * combined with the session's base, as one history step named `name`. A request that comes while
   * a flood runs waits for it, and the latest one runs after.
   */
  #refresh(session: WandSession, name: MessageId | undefined, request: WandRequest): void {
    if (this.#busy) {
      this.#queued = { session, name, request };
      return;
    }
    const settings = this.#host.settings();
    if (settings === null) return;
    const read = (key: string) => settings.get(`tools.${key}`);
    this.#busy = true;
    const started = session.step;
    this.#showHandles();
    const global = session.forceGlobal || read("floodMode") === "Global";
    flood(session, request.seed, global, read)
      .then((polygons) => {
        // A newer request for this session paints the settled state, and an undo or redo that
        // moved the session makes this flood stale, so this one records nothing.
        if (
          polygons === undefined ||
          this.#live() !== session ||
          session.step !== started ||
          this.#queued?.session === session
        )
          return;
        const result = started.base.combine(
          translatedPolygons(polygons, started.offset),
          request.mode,
        );
        // Without a name the flood is a preview of options still changing.
        if (name === undefined) {
          session.document.previewSelection(result);
          this.#showHandles();
          return;
        }
        this.#record(
          session,
          this.#host.translate(name),
          {
            seed: request.seed,
            base: started.base,
            offset: started.offset,
            mode: request.mode,
            result,
            options: this.#options.snapshot(settings),
            forceGlobal: session.forceGlobal,
          },
          session.recorded ? "edit" : "draw",
        );
      })
      .catch((cause: unknown) => this.#fail(cause))
      .finally(() => {
        this.#busy = false;
        const queued = this.#queued;
        this.#queued = undefined;
        if (queued !== undefined && this.#live() === queued.session) {
          this.#refresh(queued.session, queued.name, queued.request);
        } else {
          this.#showHandles();
        }
      });
  }

  /**
   * Sets the selection to `step.result` as one history item that keeps the result's state on either
   * side, and makes `step` the state it ends.
   */
  #record(session: WandSession, name: string, step: WandStep, kind: StepKind): void {
    const { document } = session;
    // The item's "before" selection is the recorded one, not a preview left on screen.
    if (session.recorded) document.restoreSelection(session.step.result);
    const layer = document.activeLayer;
    recordStep(
      document,
      {
        tool: "magicWand",
        layer: layer === undefined ? 0 : layerIndex(document, layer),
        kind,
        session: session.key,
        before: kind === "draw" ? undefined : session.step,
        after: kind === "finish" ? undefined : step,
      },
      () => document.replaceSelection(step.result, name),
    );
    session.step = step;
    session.recorded = true;
    this.#options.edited();
    this.#showHandles();
  }

  #move(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || event.predicted === true || !drag.zone.track(event)) return;
    const point = pixelOf(event);
    if (drag.kind === "origin") {
      drag.seed = point;
    } else {
      drag.total = { x: point.x - drag.press.x, y: point.y - drag.press.y };
      drag.session.document.previewSelection(translated(drag.pre, drag.total));
    }
    this.#showHandles();
  }

  #up(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    const point = pixelOf(event);
    const dragged = drag.zone.track(event);
    if (drag.kind === "origin") {
      if (dragged) drag.seed = point;
      this.#finishOrigin(drag);
    } else {
      if (dragged) drag.total = { x: point.x - drag.press.x, y: point.y - drag.press.y };
      this.#finishMove(drag);
    }
  }

  /** Re-seeds the flood at the new origin, as one "Move Origin" step, if the origin moved. */
  #finishOrigin(drag: Extract<WandDrag, { kind: "origin" }>): void {
    const session = this.#live();
    const moved =
      session !== undefined &&
      session === drag.session &&
      (drag.seed.x !== session.step.seed.x || drag.seed.y !== session.step.seed.y);
    if (session === undefined || !moved) {
      this.#showHandles();
      return;
    }
    this.#refresh(session, "history.moveOrigin", { seed: drag.seed, mode: session.step.mode });
  }

  /**
   * Moves the pending selection by the drag, as one "Move Selection" step. The flood's origin and
   * base move with it, so later recomputes keep the new place.
   */
  #finishMove(drag: Extract<WandDrag, { kind: "move" }>): void {
    const { session, pre, total } = drag;
    session.document.restoreSelection(pre);
    if (total.x !== 0 || total.y !== 0) {
      const step = session.step;
      this.#record(
        session,
        this.#host.translate("history.moveSelection"),
        {
          ...step,
          base: translated(step.base, total),
          offset: { x: step.offset.x + total.x, y: step.offset.y + total.y },
          result: translated(pre, total),
        },
        session.recorded ? "edit" : "draw",
      );
    }
    this.#showHandles();
  }

  #optionChanged(change: SettingChange): void {
    if (this.#restoring || change.source !== "local") return;
    const name = OPTION_HISTORY_NAMES[change.path];
    const session = this.#live();
    if (session === undefined || name === undefined) return;
    if (change.path === "tools.selection.combineMode")
      this.#burstMode = combineModeOf(change.value);
    this.#edits.changed(name);
  }

  /** The pending session. */
  #live(): WandSession | undefined {
    return this.#session;
  }
  #end(): void {
    this.#edits.cancel();
    this.#burstMode = undefined;
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
    const drag = this.#drag;
    const seed = drag?.kind === "origin" ? drag.seed : session.step.seed;
    wandHandles.set({
      seed,
      move: handleCenter(session.document.selection),
      busy: this.#busy ? session.step.seed : undefined,
    });
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/** The runtime of the Magic Wand (TL-SEL-WAND-01). */
export function magicWandToolRuntime(host: PaintHost): ToolRuntime {
  return new MagicWandRuntime(host);
}
