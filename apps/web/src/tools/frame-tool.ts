import {
  type AffineMatrix,
  composeAffine,
  IDENTITY_AFFINE,
  isEmptyRect,
  type Rect,
  sameAffine,
  translationAffine,
} from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { SettingChange } from "@openpaint/storage";
import { ClickDeadZone } from "@openpaint/tools";
import { viewScaleOf } from "./cursors";
import { FrameCoalescer } from "./frame-coalescer";
import { NudgeBurst, nudgeOffset } from "./nudge-burst";
import type { PaintHost } from "./paint-tools";
import { reportToolFailure } from "./tool-failure";
import {
  type FrameGesture,
  type FramePoint,
  type FrameStart,
  frameCursor,
  frameGeometry,
  gestureCursor,
  gestureFor,
  gestureResult,
  hitFrame,
  transformFrame,
} from "./transform-frame";

export { NUDGE_LARGE_STEP, NUDGE_MERGE_MS, NUDGE_STEP } from "./nudge-burst";

/**
 * What a frame tool moves: the selected pixels of a layer, or the selection outline. The runtime
 * draws the frame over it and turns each gesture into a preview or a recorded step.
 */
export interface FrameTarget {
  /** The rectangle the frame is drawn on, in the target's own coordinates. */
  readonly source: Rect;
  readonly transform: AffineMatrix;
  readonly anchor: FramePoint;
  /** False once an undo, a redo or another edit has changed the document behind the target. */
  readonly live: boolean;
  /** True while changes are drawn but not recorded (Dirty, TL-FRAME-01). */
  readonly pending: boolean;
  /** Draws the transform and the anchor. Nothing is recorded. */
  preview(m: AffineMatrix, anchor: FramePoint): void;
  /** Copies the content behind a Ctrl-drag, so the source stays (TL-MOVE-PIX-01). */
  stamp?(): void;
  /** Records the pending changes as one history item named `name`. */
  commit(name: string): boolean;
  /** Drops the pending changes. Nothing is recorded. */
  cancel(): void;
  /** Records one item named `name` and ends the target. */
  finish(name: string): boolean;
  /** Records the current transform again under a new option (TL-FRAME-02). */
  rerender?(name: string): void;
}

/** The history names of a frame tool (TL-MOVE-PIX-01, TL-MOVE-SEL-01), as catalog keys. */
export interface FrameNames {
  readonly move: MessageId;
  readonly resize: MessageId;
  readonly rotate: MessageId;
  readonly anchor: MessageId;
  readonly finish: MessageId;
}

export interface FrameToolOptions {
  readonly host: PaintHost;
  readonly names: FrameNames;
  /** Makes a target from the document, when the tool has none yet. Undefined when nothing can be moved. */
  readonly start: () => FrameTarget | undefined;
  /** While the tool is active, hands it targets from outside, such as a paste. */
  readonly connect?: (adopt: (target: FrameTarget) => void) => () => void;
  /** The settings that re-record the target with a new option, keyed by the setting's path. */
  readonly optionNames?: Readonly<Record<string, MessageId>>;
  /**
   * The rectangle a press would start the frame on while the tool has no target, so the cursor
   * shows what the press will do. Undefined when a press would find nothing to move.
   */
  readonly idleSource?: () => Rect | undefined;
}

/** A gesture in progress, from the press to the release. */
interface Drag {
  readonly gesture: FrameGesture;
  readonly name: MessageId;
  readonly ctrl: boolean;
  /** Until the pointer leaves this zone around the press, the press is a click and moves nothing. */
  readonly zone: ClickDeadZone;
  stamped: boolean;
  moved: boolean;
}

function pointOf(event: ToolPointerEvent): FramePoint {
  return { x: event.x, y: event.y };
}

/**
 * The runtime of a frame tool (TL-MOVE-01). A press on the frame starts a move, a scale, a rotation
 * or an anchor drag. Each drag records one history step when it ends, and the target is drawn live
 * while the drag runs. A press whose pointer stays within its click dead zone changes nothing.
 * Arrow keys nudge the target, and nudges that follow each other merge. Enter, Esc and a tool switch finish the target with its "Finish" step.
 */
class FrameRuntime implements ToolRuntime {
  readonly #options: FrameToolOptions;
  #target: FrameTarget | undefined;
  #drag: Drag | undefined;
  /** Arrow nudges that follow each other, recorded as one "move" step. */
  readonly #nudges: NudgeBurst;
  #disconnect: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Draws a drag at most once per frame, at the newest pointer position. */
  readonly #frames: FrameCoalescer;
  /** The last pointer sample, which the cursor is chosen for. */
  #hover: ToolPointerEvent | undefined;

  constructor(options: FrameToolOptions) {
    this.#options = options;
    this.#frames = new FrameCoalescer(options.host.scheduleFrame);
    this.#nudges = new NudgeBurst(() => {
      const target = this.#current();
      if (target?.pending !== true) return;
      target.commit(this.#name(this.#options.names.move));
      this.#show();
    });
  }

  activate(): void {
    this.#unsubscribe = this.#options.host
      .settings()
      ?.onChange((change) => this.#optionChanged(change));
    this.#disconnect = this.#options.connect?.((target) => this.adopt(target));
  }

  deactivate(): void {
    this.commit();
    this.#disconnect?.();
    this.#unsubscribe?.();
    this.#disconnect = undefined;
    this.#unsubscribe = undefined;
    this.#end();
  }

  /** Takes over a target from outside. A pending result of the current target is committed first. */
  adopt(target: FrameTarget): void {
    this.commit();
    this.#target = target;
    this.#show();
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
    return this.#current() !== undefined;
  }

  /**
   * The cursor for what a press at the pointer does, or what the drag in progress does
   * (TL-MOVE-01): it reads the frame without changing the tool's state.
   */
  cursor(view: ToolViewState): string | undefined {
    const hover = this.#hover;
    if (view.panning || hover === undefined) return undefined;
    const p = pointOf(hover);
    const target = this.#target?.live === true ? this.#target : undefined;
    const drag = this.#drag;
    if (drag !== undefined && target !== undefined) {
      return gestureCursor(drag.gesture, target.source, target.transform, p);
    }
    const scale = viewScaleOf(hover);
    if (target !== undefined) {
      const hit = hitFrame(target.source, target.transform, target.anchor, p, 0, scale);
      return frameCursor(hit, target.source, target.transform, p);
    }
    const source = this.#options.idleSource?.();
    if (source === undefined || isEmptyRect(source)) return undefined;
    const center = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const hit = hitFrame(source, IDENTITY_AFFINE, center, p, 0, scale);
    return frameCursor(hit, source, IDENTITY_AFFINE, p);
  }

  /** Finishes the target (TL-FRAME-01 "Finish"). Pending nudges and a drag in progress are settled first. */
  commit(): void {
    if (this.#drag !== undefined) this.cancel();
    this.#flushNudge();
    const target = this.#current();
    if (target === undefined) return;
    target.finish(this.#name(this.#options.names.finish));
    this.#end();
  }

  /** Drops the drag in progress and restores the target it started with. Nothing is recorded. */
  cancel(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#frames.cancel();
    this.#drag = undefined;
    this.#current()?.cancel();
    this.#show();
  }

  /**
   * Moves the target by an arrow key, `step` image pixels (`nudgeStep`, TL-MOVE-01). Consecutive
   * nudges merge into one step, which is recorded once no nudge follows for NUDGE_MERGE_MS.
   */
  nudge(dx: number, dy: number, step: number): boolean {
    if (this.#drag !== undefined) return false;
    const target = this.#current() ?? this.#start();
    if (target === undefined) return false;
    const offset = nudgeOffset(dx, dy, step);
    const m = composeAffine(translationAffine(offset.dx, offset.dy), target.transform);
    target.preview(m, target.anchor);
    this.#nudges.nudged();
    this.#show();
    return true;
  }

  #start(): FrameTarget | undefined {
    const target = this.#options.start();
    if (target !== undefined) this.#target = target;
    return target;
  }

  /** The target, if it is still live. A target the document no longer holds ends the tool's state. */
  #current(): FrameTarget | undefined {
    const target = this.#target;
    if (target === undefined) return undefined;
    if (!target.live) {
      this.#end();
      return undefined;
    }
    return target;
  }

  #end(): void {
    this.#target = undefined;
    this.#drag = undefined;
    this.#frames.cancel();
    this.#nudges.cancel();
    transformFrame.set(undefined);
  }

  #show(): void {
    const target = this.#current();
    transformFrame.set(
      target === undefined
        ? undefined
        : frameGeometry(target.source, target.transform, target.anchor),
    );
  }

  #name(key: MessageId): MessageId {
    return this.#options.host.translate(key) as MessageId;
  }

  #down(event: ToolPointerEvent): void {
    if (this.#drag !== undefined || (event.button !== 0 && event.button !== 2)) return;
    this.#flushNudge();
    const target = this.#current() ?? this.#start();
    if (target === undefined) return;
    this.#show();
    const press = pointOf(event);
    const start: FrameStart = { m: target.transform, anchor: target.anchor, press };
    const hit = hitFrame(
      target.source,
      target.transform,
      target.anchor,
      press,
      event.button,
      viewScaleOf(event),
    );
    if (hit?.kind === "reset") {
      const center = {
        x: target.source.x + target.source.width / 2,
        y: target.source.y + target.source.height / 2,
      };
      target.preview(target.transform, center);
      target.commit(this.#name(this.#options.names.anchor));
      this.#show();
      return;
    }
    const gesture = hit === undefined ? undefined : gestureFor(hit, start);
    if (gesture === undefined) {
      this.#show();
      return;
    }
    this.#drag = {
      gesture,
      name: this.#nameOf(gesture),
      ctrl: event.ctrlKey,
      zone: new ClickDeadZone(event),
      stamped: false,
      moved: false,
    };
  }

  #nameOf(gesture: FrameGesture): MessageId {
    const { names } = this.#options;
    switch (gesture.kind) {
      case "move":
        return names.move;
      case "scale":
        return names.resize;
      case "rotate":
        return names.rotate;
      case "anchor":
        return names.anchor;
    }
  }

  #move(event: ToolPointerEvent): void {
    if (this.#drag === undefined || event.predicted === true) return;
    if (!this.#drag.zone.track(event)) return;
    this.#frames.request(() => {
      try {
        this.#apply(pointOf(event), event);
      } catch (cause) {
        this.cancel();
        this.#fail(cause);
      }
    });
  }

  #up(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#frames.cancel();
    if (drag.zone.track(event)) this.#apply(pointOf(event), event);
    this.#drag = undefined;
    const target = this.#current();
    if (target === undefined) return;
    if (drag.moved) target.commit(this.#name(drag.name));
    else target.cancel();
    this.#show();
  }

  /** Draws the drag's transform at the pointer, stamping a copy first on the first real move. */
  #apply(p: FramePoint, event: ToolPointerEvent): void {
    const drag = this.#drag;
    const target = this.#current();
    if (drag === undefined || target === undefined) return;
    const source = target.source;
    const result = gestureResult(source, drag.gesture, p, {
      shift: event.shiftKey,
      alt: event.altKey,
    });
    const changed =
      drag.gesture.kind === "anchor"
        ? result.anchor.x !== drag.gesture.start.anchor.x ||
          result.anchor.y !== drag.gesture.start.anchor.y
        : !sameAffine(result.m, drag.gesture.start.m);
    if (!changed && !drag.moved) return;
    if (changed && !drag.stamped && drag.ctrl && drag.gesture.kind === "move") {
      target.stamp?.();
      drag.stamped = true;
    }
    drag.moved = drag.moved || changed;
    target.preview(result.m, result.anchor);
    this.#show();
  }

  /** Records the nudges that are waiting to merge, as one "move" step. */
  #flushNudge(): void {
    this.#nudges.flush();
  }

  #optionChanged(change: SettingChange): void {
    if (change.source !== "local") return;
    const key = this.#options.optionNames?.[change.path];
    const target = this.#current();
    if (key === undefined || target?.rerender === undefined || this.#drag !== undefined) return;
    target.rerender(this.#name(key));
    this.#show();
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#options.host, cause);
  }
}

/** Creates the runtime of a frame tool. The tools differ only in their target and their names. */
export function frameToolRuntime(options: FrameToolOptions): ToolRuntime & {
  adopt(target: FrameTarget): void;
  nudge(dx: number, dy: number, step: number): boolean;
} {
  return new FrameRuntime(options);
}
