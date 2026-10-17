import {
  applyCommand,
  applyWheel,
  type EngineSize,
  layoutState,
  type ViewCommand,
  type ViewLayout,
  type ViewState,
  type ViewStatus,
  viewLayout,
  type WheelInput,
} from "@openpaint/engine";

/** The engine calls that change the view. */
export interface ViewTarget {
  view(command: ViewCommand): Promise<ViewStatus>;
  wheel(input: WheelInput): Promise<ViewStatus>;
}

type Step =
  | { readonly kind: "view"; readonly command: ViewCommand }
  | { readonly kind: "wheel"; readonly input: WheelInput };

function sameLayout(a: ViewLayout | undefined, b: ViewLayout | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.mode === b.mode &&
    a.overscroll === b.overscroll &&
    a.zoom === b.zoom &&
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.documentWidth === b.documentWidth &&
    a.documentHeight === b.documentHeight
  );
}

/** Whether two wheel inputs combine into one: the same kind of scroll, or a zoom at one point. */
function mergesWith(a: WheelInput, b: WheelInput): boolean {
  if (a.deltaMode !== b.deltaMode || a.ctrlKey !== b.ctrlKey || a.shiftKey !== b.shiftKey) {
    return false;
  }
  return !a.ctrlKey || (a.x === b.x && a.y === b.y);
}

/**
 * Keeps the overlays in step with the canvas (L1). The engine owns the view and reports its layout
 * after each change, but that report reaches the main thread after the engine has presented, so
 * overlays that waited for it trailed the canvas by a frame. This predicts the layout on the main
 * thread instead, with the engine's own view functions, and publishes it when the command is sent:
 * overlays then draw the new view in the same frame the engine is asked to present it.
 *
 * The prediction starts from the engine's last reported layout and applies the commands it has not
 * answered yet, so it equals what the engine will show, and an answer that brings a different
 * layout (a new image size, a resize) corrects it. Drag pans and wheel input are combined into one
 * command per frame, so the engine also presents once per frame rather than once per event.
 */
export class ViewPredictor implements ViewTarget {
  readonly #target: ViewTarget;
  readonly #publish: (layout: ViewLayout) => void;
  readonly #schedule: (callback: () => void) => number;
  readonly #unschedule: (handle: number) => void;
  #viewport: EngineSize;
  /** The engine's last reported layout. */
  #reported: ViewLayout | undefined;
  /** Sent commands the engine has not answered yet, oldest first. */
  readonly #pending: Step[] = [];
  #layout: ViewLayout | undefined;
  /** Input gathered for the next frame. */
  #pan: { dx: number; dy: number } | undefined;
  #wheel: WheelInput | undefined;
  #frame: number | undefined;

  constructor(
    target: ViewTarget,
    publish: (layout: ViewLayout) => void,
    viewport: EngineSize,
    schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
    unschedule: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
  ) {
    this.#target = target;
    this.#publish = publish;
    this.#viewport = viewport;
    this.#schedule = schedule;
    this.#unschedule = unschedule;
  }

  /** The layout overlays should draw: the engine's, with the commands it is still applying. */
  get layout(): ViewLayout | undefined {
    return this.#layout;
  }

  /** The engine reported a layout. Between a command and its answer, the answer settles it. */
  reported(layout: ViewLayout): void {
    this.#reported = layout;
    if (this.#pending.length === 0) this.#update();
  }

  /** The canvas got a new device-pixel size, which the engine is told at the same time. */
  resize(viewport: EngineSize): void {
    this.#viewport = viewport;
    this.#update();
  }

  view(command: ViewCommand): Promise<ViewStatus> {
    this.flush();
    return this.#send({ kind: "view", command });
  }

  wheel(input: WheelInput): Promise<ViewStatus> {
    this.flush();
    return this.#send({ kind: "wheel", input });
  }

  /**
   * Pans by device pixels. The first pan of a frame is sent at once; later ones in the same frame
   * are combined and sent when the next frame starts, so the engine presents once per frame.
   */
  panPerFrame(dx: number, dy: number): void {
    if (this.#wheel !== undefined) this.flush();
    this.#pan = { dx: (this.#pan?.dx ?? 0) + dx, dy: (this.#pan?.dy ?? 0) + dy };
    this.#gathered();
  }

  /** Applies a wheel event like `panPerFrame`, combined with the ones before it when they match. */
  wheelPerFrame(input: WheelInput): void {
    const queued = this.#wheel;
    if (this.#pan !== undefined || (queued !== undefined && !mergesWith(queued, input))) {
      this.flush();
    }
    const current = this.#wheel;
    this.#wheel =
      current === undefined
        ? input
        : {
            ...input,
            deltaX: current.deltaX + input.deltaX,
            deltaY: current.deltaY + input.deltaY,
          };
    this.#gathered();
  }

  /** Sends the gathered input now. */
  flush(): void {
    const pan = this.#pan;
    const wheel = this.#wheel;
    this.#pan = undefined;
    this.#wheel = undefined;
    if (pan !== undefined) void this.#send({ kind: "view", command: { type: "pan", ...pan } });
    if (wheel !== undefined) void this.#send({ kind: "wheel", input: wheel });
  }

  /** Drops the gathered input. */
  dispose(): void {
    if (this.#frame !== undefined) this.#unschedule(this.#frame);
    this.#frame = undefined;
    this.#pan = undefined;
    this.#wheel = undefined;
  }

  /**
   * Sends gathered input at once when nothing went out in this frame yet, and otherwise when the
   * next frame starts. A frame is pending exactly while input went out in the current one.
   */
  #gathered(): void {
    if (this.#frame !== undefined) return;
    this.flush();
    this.#nextFrame();
  }

  #nextFrame(): void {
    this.#frame = this.#schedule(() => {
      this.#frame = undefined;
      if (this.#pan === undefined && this.#wheel === undefined) return;
      this.flush();
      this.#nextFrame();
    });
  }

  #send(step: Step): Promise<ViewStatus> {
    this.#pending.push(step);
    this.#update();
    const sent =
      step.kind === "view" ? this.#target.view(step.command) : this.#target.wheel(step.input);
    const settle = () => {
      const index = this.#pending.indexOf(step);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#update();
    };
    sent.then(settle, settle);
    return sent;
  }

  #update(): void {
    const reported = this.#reported;
    if (reported === undefined) return;
    const doc = { width: reported.documentWidth, height: reported.documentHeight };
    const viewport = { width: this.#viewport.width, height: this.#viewport.height };
    let state: ViewState = layoutState(reported);
    for (const step of this.#pending) {
      state =
        step.kind === "view"
          ? applyCommand(state, doc, viewport, step.command)
          : applyWheel(state, doc, viewport, this.#viewport.scale, step.input);
    }
    const layout = this.#pending.length === 0 ? reported : viewLayout(state, doc, viewport);
    if (sameLayout(layout, this.#layout)) return;
    this.#layout = layout;
    this.#publish(layout);
  }
}
