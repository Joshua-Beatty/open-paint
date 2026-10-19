import {
  type AffineMatrix,
  type Document,
  FloatingPixels,
  FloatingSource,
  type FloatingState,
  IDENTITY_AFFINE,
  intersectRects,
  type Point,
  type Rect,
  rect,
  rectPolygon,
  remainingAfterLift,
  type Selection,
  type Surface,
  type TransformOptions,
  type TransformSampling,
  translatePolygons,
} from "@openpaint/document";
import type { ToolDescriptor, ToolRuntime } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { measured } from "../perf/user-timing";
import { selectionBounds } from "./cursors";
import { type FrameNames, type FrameTarget, frameToolRuntime, type TargetStep } from "./frame-tool";
import { LayerSnapshot } from "./layer-patch";
import type { PaintHost } from "./paint-tools";
import { layerIndex, type StepContext } from "./tool-history";
import type { FramePoint } from "./transform-frame";

/** The TL-OPT-RESAMP values of the Move Selected Pixels "Sampling" option, as settings store them. */
const SAMPLING_BY_SETTING: Readonly<Record<string, TransformSampling>> = {
  NearestNeighbor: "nearest",
  Linear: "linear",
  MultisampleLinear: "multisample",
  Anisotropic: "anisotropic",
  HighQualityCubic: "cubic",
};

/** The TL-OPT-GAMMA "Gamma Corrected" default: resample in linear light (the setting's "Linear"). */
export function transformOptionsOf(read: (name: string) => unknown): TransformOptions {
  const sampling = SAMPLING_BY_SETTING[String(read("move.resampling"))] ?? "cubic";
  return { sampling, linearLight: read("gammaMode") !== "Companded" };
}

/** The history names of Move Selected Pixels (TL-MOVE-PIX-01). */
const PIXEL_NAMES: FrameNames = {
  move: "history.movePixels",
  resize: "history.resizePixels",
  rotate: "history.rotatePixels",
  anchor: "history.moveRotationAnchor",
  finish: "history.finishPixels",
};

/** The history names of Move Selection (TL-MOVE-SEL-01). */
const SELECTION_NAMES: FrameNames = {
  move: "history.moveSelection",
  resize: "history.resizeSelection",
  rotate: "history.rotateSelection",
  anchor: "history.moveRotationAnchor",
  finish: "history.finishSelection",
};

/** The settings that re-record a pending pixel move with a new option (TL-FRAME-02). */
const PIXEL_OPTION_NAMES: Readonly<Record<string, MessageId>> = {
  "tools.move.resampling": "history.changeSampling",
  "tools.gammaMode": "history.changeGammaMode",
};

/**
 * Where the moved pixels come from (TL-MOVE-PIX-01): a lift of the layer's selected pixels, which
 * the history gives back from the layer and selection before the move, or a pasted bitmap, which
 * is kept (once, shared by every step) with the layer under it before the paste.
 */
type PixelSource =
  | { readonly kind: "lift"; readonly area: Rect }
  | {
      readonly kind: "paste";
      readonly content: FloatingSource;
      readonly origin: Point;
      readonly area: Rect;
      readonly base: Surface;
    };

/** A pending pixel move as its history items keep it (TL-FRAME-01). */
interface PixelState {
  readonly source: PixelSource;
  readonly float: FloatingState;
}

/** A pending selection move as its history items keep it (TL-FRAME-01). */
interface SelectionState {
  /** The selection the move started from. */
  readonly base: Selection;
  readonly m: AffineMatrix;
  readonly anchor: FramePoint;
}

/**
 * Makes the floating session of a pixel move again from its state, after undo or redo landed on
 * one of its steps: the content lifted again from the layer and selection before the move (read
 * from the history) or the pasted bitmap, the base with the copies left behind drawn in again,
 * and the layer as it shows the step now.
 */
export async function restoreFloating(
  state: PixelState,
  context: StepContext,
): Promise<FloatingPixels> {
  const { document, layer } = context;
  const before = await context.before();
  const layerBefore = new LayerSnapshot(layer.pixels, before.tiles);
  const { source, float } = state;
  let content: FloatingSource;
  let origin: Point;
  let startBase: Surface;
  if (source.kind === "lift") {
    const lift = source.area;
    const selection = before.selection;
    const lifted = layerBefore.read(lift);
    const coverage =
      selection.isEmpty || selection.coversRect(lift) ? undefined : selection.mask(lift);
    const outline = selection.isEmpty
      ? [rectPolygon(rect(0, 0, lift.width, lift.height))]
      : translatePolygons(selection.effectivePolygons(), -lift.x, -lift.y);
    content = new FloatingSource(lifted, coverage, outline, selection.quality);
    origin = { x: lift.x, y: lift.y };
    startBase = remainingAfterLift(lifted, coverage);
  } else {
    content = source.content;
    origin = source.origin;
    startBase = source.base;
  }
  const { area } = float;
  const start = source.area;
  let base = layerBefore.read(area);
  base.copyFrom(startBase, startBase.bounds, start.x - area.x, start.y - area.y);
  for (const stamp of float.stamps) {
    base = content.compose(base, area, area, stamp.transform, stamp.options);
  }
  return new FloatingPixels({
    document,
    layer,
    pixels: content.pixels,
    coverage: content.coverage,
    origin,
    outline: content.outline,
    area,
    base,
    committed: layer.pixels.readRegion(area),
    selection: document.selection,
    anchor: float.anchor,
    transform: float.transform,
    stamps: float.stamps,
    options: float.options,
  });
}

/**
 * Hands a floating session from the paste command to the Move Selected Pixels tool. A session
 * offered while no tool listens waits until one connects.
 */
export class FloatingHandoff {
  #pending: FloatingPixels | undefined;
  #listener: ((session: FloatingPixels) => void) | undefined;

  offer(session: FloatingPixels): void {
    if (this.#listener !== undefined) this.#listener(session);
    else this.#pending = session;
  }

  connect(listener: (session: FloatingPixels) => void): () => void {
    this.#listener = listener;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) listener(pending);
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }
}

/**
 * A floating session as a frame target. The options are read on every preview. `source` is where
 * its pixels came from, which its history items keep.
 */
function pixelTarget(
  document: Document,
  session: FloatingPixels,
  options: () => TransformOptions,
  source: PixelSource,
  key: object = {},
): FrameTarget {
  const step = (record: TargetStep) => (float: FloatingState) =>
    record({ source, float } satisfies PixelState);
  return {
    key,
    layer: () => layerIndex(document, session.layer),
    get source() {
      return rect(0, 0, session.size.width, session.size.height);
    },
    get transform() {
      return session.transform;
    },
    get anchor() {
      return session.anchor;
    },
    get live() {
      return session.live;
    },
    get pending() {
      return session.pending;
    },
    preview(m: AffineMatrix, anchor: FramePoint) {
      measured("move preview", () => {
        session.setAnchor(anchor);
        session.preview(m, options());
      });
    },
    stamp: () => {
      session.stamp();
    },
    commit: (name, record) => measured("move commit", () => session.commit(name, step(record))),
    cancel: () => {
      session.cancel();
    },
    finish: (name, record) => session.finish(name, step(record)),
    rerender: () => {
      session.preview(session.transform, options());
    },
    settling: () => session.settling(),
  };
}

/**
 * The selection outline as a frame target (TL-MOVE-SEL-01). The frame starts over the selection's
 * bounds, and each change moves the outline by the transform. Undo or another edit ends the target,
 * since the document's selection is then a different object.
 */
function selectionTarget(
  document: Document,
  restored?: SelectionState,
  key: object = {},
): FrameTarget | undefined {
  const base = restored?.base ?? document.selection;
  if (base.isEmpty) return undefined;
  const source = base.bounds();
  let committed: { readonly m: AffineMatrix; readonly anchor: FramePoint } = restored ?? {
    m: IDENTITY_AFFINE,
    anchor: { x: source.x + source.width / 2, y: source.y + source.height / 2 },
  };
  let committedSelection: Selection = document.selection;
  let current = committed;
  let result: Selection = committedSelection;
  let pending = false;
  const live = () => document.selection === result;
  const state = (): SelectionState => ({ base, m: current.m, anchor: current.anchor });
  const replace = (name: string, record: TargetStep) => {
    // The item's "before" selection is the committed one, not the preview left on screen.
    document.restoreSelection(committedSelection);
    document.history.withStep(record(state()), () => document.replaceSelection(result, name));
  };
  return {
    key,
    layer: () => {
      const layer = document.activeLayer;
      return layer === undefined ? 0 : layerIndex(document, layer);
    },
    source,
    get transform() {
      return current.m;
    },
    get anchor() {
      return current.anchor;
    },
    get live() {
      return live();
    },
    get pending() {
      return pending;
    },
    preview(m, anchor) {
      if (!live()) return;
      current = { m, anchor };
      pending = true;
      result = base.transform(m).commit();
      document.previewSelection(result);
    },
    commit(name, record) {
      if (!live() || !pending) return false;
      replace(name, record);
      committed = current;
      committedSelection = result;
      pending = false;
      return true;
    },
    cancel() {
      if (!live() || !pending) return;
      current = committed;
      result = committedSelection;
      pending = false;
      document.restoreSelection(committedSelection);
    },
    finish(name, record) {
      if (!live()) return false;
      replace(name, record);
      committed = current;
      committedSelection = result;
      pending = false;
      return true;
    },
  };
}

/**
 * The runtime of Move Selected Pixels (TL-MOVE-PIX-01). With nothing selected, a drag first
 * records "Select All" as its own item, then lifts and moves the whole canvas.
 */
export function movePixelsToolRuntime(host: PaintHost, handoff: FloatingHandoff): ToolRuntime {
  const options = (): TransformOptions => {
    const settings = host.settings();
    return settings === null
      ? { sampling: "cubic", linearLight: true }
      : transformOptionsOf((name) => settings.get(`tools.${name}`));
  };
  /** Previews on the engine's GPU when it can draw them, resampled steps computed off this thread. */
  const equip = (session: FloatingPixels) => {
    session.setResampler(host.transformResampler?.());
    session.setDisplay(host.floatDisplay?.(session));
    session.setComposer(host.floatComposer?.());
  };
  return frameToolRuntime({
    host,
    tool: "moveSelectedPixels",
    names: PIXEL_NAMES,
    optionPaths: Object.keys(PIXEL_OPTION_NAMES),
    start: () => {
      const document = host.document();
      if (document?.activeLayer === undefined) return undefined;
      if (document.selection.isEmpty) document.selectAll();
      const session = measured("move lift", () => document.liftSelectedPixels());
      if (session === undefined) return undefined;
      equip(session);
      return pixelTarget(document, session, options, { kind: "lift", area: session.start.area });
    },
    startsOnDrag: () => host.document()?.selection.isEmpty === true,
    restore: async (state, context) => {
      const pixels = state as PixelState;
      const session = await restoreFloating(pixels, context);
      equip(session);
      return pixelTarget(context.document, session, options, pixels.source, context.session);
    },
    connect: (adopt) =>
      handoff.connect((session) => {
        equip(session);
        const document = host.document();
        if (document === undefined) return;
        const { content, origin, area, base } = session.start;
        adopt(
          pixelTarget(document, session, options, { kind: "paste", content, origin, area, base }),
        );
      }),
    optionNames: PIXEL_OPTION_NAMES,
    idleSource: () => {
      const document = host.document();
      if (document?.activeLayer === undefined) return undefined;
      const canvas = rect(0, 0, document.width, document.height);
      const { selection } = document;
      return selection.isEmpty ? canvas : intersectRects(selectionBounds(selection), canvas);
    },
    // The area a press lifts, shown only with a selection: the whole-canvas move needs no handles.
    idleFrame: () => {
      const document = host.document();
      if (document?.activeLayer === undefined || document.selection.isEmpty) return undefined;
      const canvas = rect(0, 0, document.width, document.height);
      return intersectRects(selectionBounds(document.selection), canvas);
    },
  });
}

/** The selection's bounds, which Move Selection's frame starts on, or undefined without one. */
function selectedBounds(host: PaintHost): Rect | undefined {
  const selection = host.document()?.selection;
  return selection === undefined || selection.isEmpty ? undefined : selectionBounds(selection);
}

/** The runtime of Move Selection (TL-MOVE-SEL-01). It moves the outline only, never the pixels. */
export function moveSelectionToolRuntime(host: PaintHost): ToolRuntime {
  return frameToolRuntime({
    host,
    tool: "moveSelection",
    names: SELECTION_NAMES,
    start: () => {
      const document = host.document();
      return document === undefined ? undefined : selectionTarget(document);
    },
    restore: async (state, context) =>
      selectionTarget(context.document, state as SelectionState, context.session),
    idleSource: () => selectedBounds(host),
    idleFrame: () => selectedBounds(host),
  });
}

/** The runtime of a move tool, or undefined for the other tools (TL-FRAME-07). */
export function movementToolRuntime(
  tool: ToolDescriptor,
  host: PaintHost,
  handoff: FloatingHandoff,
): ToolRuntime | undefined {
  if (tool.id === "moveSelectedPixels") return movePixelsToolRuntime(host, handoff);
  if (tool.id === "moveSelection") return moveSelectionToolRuntime(host);
  return undefined;
}
