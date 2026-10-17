import {
  type AffineMatrix,
  type Document,
  type FloatingPixels,
  IDENTITY_AFFINE,
  intersectRects,
  rect,
  type Selection,
  type TransformOptions,
  type TransformSampling,
} from "@openpaint/document";
import type { ToolDescriptor, ToolRuntime } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { measured } from "../perf/user-timing";
import { selectionBounds } from "./cursors";
import { type FrameNames, type FrameTarget, frameToolRuntime } from "./frame-tool";
import type { PaintHost } from "./paint-tools";
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

/** A floating session as a frame target. The options are read on every preview. */
function pixelTarget(session: FloatingPixels, options: () => TransformOptions): FrameTarget {
  return {
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
    commit: (name) => measured("move commit", () => session.commit(name)),
    cancel: () => {
      session.cancel();
    },
    finish: (name) => session.finish(name),
    rerender: (name) => {
      if (session.preview(session.transform, options())) session.commit(name);
    },
    settling: () => session.settling(),
  };
}

/**
 * The selection outline as a frame target (TL-MOVE-SEL-01). The frame starts over the selection's
 * bounds, and each change moves the outline by the transform. Undo or another edit ends the target,
 * since the document's selection is then a different object.
 */
function selectionTarget(document: Document): FrameTarget | undefined {
  const base = document.selection;
  if (base.isEmpty) return undefined;
  const source = base.bounds();
  let committed: { readonly m: AffineMatrix; readonly anchor: FramePoint } = {
    m: IDENTITY_AFFINE,
    anchor: { x: source.x + source.width / 2, y: source.y + source.height / 2 },
  };
  let committedSelection: Selection = base;
  let current = committed;
  let result: Selection = base;
  let pending = false;
  const live = () => document.selection === result;
  return {
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
    commit(name) {
      if (!live() || !pending) return false;
      document.replaceSelection(result, name);
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
    finish(name) {
      if (!live()) return false;
      document.replaceSelection(result, name);
      committed = current;
      committedSelection = result;
      pending = false;
      return true;
    },
  };
}

/**
 * The runtime of Move Selected Pixels (TL-MOVE-PIX-01). With nothing selected, a drag selects the
 * whole canvas and moves it, recorded with the move as one "Move Pixels" item.
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
    names: PIXEL_NAMES,
    start: () => {
      const session = measured("move lift", () => host.document()?.liftSelectedPixels());
      if (session === undefined) return undefined;
      equip(session);
      return pixelTarget(session, options);
    },
    connect: (adopt) =>
      handoff.connect((session) => {
        equip(session);
        adopt(pixelTarget(session, options));
      }),
    optionNames: PIXEL_OPTION_NAMES,
    idleSource: () => {
      const document = host.document();
      if (document?.activeLayer === undefined) return undefined;
      const canvas = rect(0, 0, document.width, document.height);
      const { selection } = document;
      return selection.isEmpty ? canvas : intersectRects(selectionBounds(selection), canvas);
    },
  });
}

/** The runtime of Move Selection (TL-MOVE-SEL-01). It moves the outline only, never the pixels. */
export function moveSelectionToolRuntime(host: PaintHost): ToolRuntime {
  return frameToolRuntime({
    host,
    names: SELECTION_NAMES,
    start: () => {
      const document = host.document();
      return document === undefined ? undefined : selectionTarget(document);
    },
    idleSource: () => {
      const selection = host.document()?.selection;
      return selection === undefined || selection.isEmpty ? undefined : selectionBounds(selection);
    },
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
