import type { PointerPhase } from "@openpaint/tools";
import { type TouchPoint, type TouchSpan, touchSpan } from "./touch-pinch";

/**
 * What one finger does on the canvas: draw with the active tool (WEB-PTR-03), or only move the
 * view, as when a pen does the drawing.
 */
export type TouchInputMode = "draw" | "navigate";

/**
 * How long a lone touch waits before the active tool sees it. A second finger within this time
 * makes it a pinch the tool never sees, so a pinch does not start with a dot or a click.
 */
export const TOUCH_GRACE_MS = 70;
/** A tap is shorter than this, from its first finger down to its last finger up. */
export const TAP_MAX_MS = 300;
/** A tap's fingers move less than this many CSS pixels. */
export const TAP_SLOP_CSS_PIXELS = 10;

/** A touch pointer event as the gestures read it. A `PointerEvent` satisfies this structurally. */
export interface TouchEventLike {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchGestureHost<E extends TouchEventLike> {
  /** Input for the active tool, in order: a down, moves, then an up or a cancel. */
  tool(phase: PointerPhase, event: E): void;
  /** A pinch step, once per frame: the two-finger span moved from `from` to `to` (device pixels). */
  pinch(from: TouchSpan, to: TouchSpan): void;
  /** A one-finger pan by device pixels, in navigate mode. */
  pan(dx: number, dy: number): void;
  /** A short tap with two or more fingers that did not move. */
  tap(fingers: number): void;
  /** The client point in device pixels of the canvas. */
  point(clientX: number, clientY: number): TouchPoint;
  /** What one finger does now. Read when a contact starts. */
  mode(): TouchInputMode;
}

export interface TouchGestureTiming {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly schedule: (callback: () => void) => unknown;
  readonly unschedule: (handle: unknown) => void;
}

const BROWSER_TIMING: TouchGestureTiming = {
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback) => requestAnimationFrame(callback),
  unschedule: (handle) => cancelAnimationFrame(handle as number),
};

interface Finger {
  client: { x: number; y: number };
  start: { x: number; y: number };
  device: TouchPoint;
}

type State =
  /** No finger is down. */
  | { readonly kind: "idle" }
  /** One finger is down, and the tool will see it after the grace time. */
  | { readonly kind: "pending"; readonly id: number; readonly events: [PointerPhase, unknown][] }
  /** One finger draws with the tool. */
  | { readonly kind: "tool"; readonly id: number }
  /** One finger pans the view (navigate mode). */
  | { readonly kind: "pan"; readonly id: number }
  /** Two or more fingers pinch and pan the view. */
  | { readonly kind: "gesture" }
  /** The rest of a contact whose gesture ended, or one a pen interrupted: ignored until all lift. */
  | { readonly kind: "ignored" };

/**
 * Touch input on the canvas (WEB-PTR-03, UI-KEY-02). One finger uses the active tool, after a short
 * grace time in which a second finger makes the contact a gesture instead; the tool then gets the
 * held events in order, with their coalesced samples, so nothing is lost. A second finger after
 * that cancels the tool's stroke, which restores what it changed. Two or more fingers pinch-zoom
 * around their midpoint and pan with it, one view step per frame (L1). A short still tap with two
 * fingers or three fingers is reported for Undo and Redo. After a gesture, fingers left down do
 * nothing until all of them lift. In navigate mode one finger pans.
 */
export class TouchGestures<E extends TouchEventLike> {
  readonly #host: TouchGestureHost<E>;
  readonly #timing: TouchGestureTiming;
  readonly #fingers = new Map<number, Finger>();
  #state: State = { kind: "idle" };
  #timer: unknown;
  #frame: unknown;
  /** The span the last pinch step ended at. */
  #sent: TouchSpan | undefined;
  #sequence = { start: 0, fingers: 0, moved: false, interrupted: false };

  constructor(host: TouchGestureHost<E>, timing: TouchGestureTiming = BROWSER_TIMING) {
    this.#host = host;
    this.#timing = timing;
  }

  /** Whether any finger is down. */
  get active(): boolean {
    return this.#fingers.size > 0;
  }

  /** Whether the tool has a touch contact open. */
  get drawing(): boolean {
    return this.#state.kind === "tool";
  }

  down(event: E): void {
    const device = this.#host.point(event.clientX, event.clientY);
    const client = { x: event.clientX, y: event.clientY };
    this.#fingers.set(event.pointerId, { client, start: client, device });
    const state = this.#state;
    if (this.#fingers.size === 1) {
      this.#sequence = { start: this.#timing.now(), fingers: 1, moved: false, interrupted: false };
      if (state.kind === "ignored") return;
      if (this.#host.mode() === "navigate") {
        this.#state = { kind: "pan", id: event.pointerId };
        return;
      }
      this.#state = { kind: "pending", id: event.pointerId, events: [["down", event]] };
      this.#timer = this.#timing.setTimer(() => this.#startTool(), TOUCH_GRACE_MS);
      return;
    }
    this.#sequence.fingers = Math.max(this.#sequence.fingers, this.#fingers.size);
    if (state.kind === "ignored") return;
    if (state.kind === "pending") this.#clearTimer();
    if (state.kind === "tool") this.#host.tool("cancel", event);
    if (state.kind === "gesture") this.#flushPinch();
    this.#state = { kind: "gesture" };
    this.#sent = this.#span();
  }

  move(event: E): void {
    const finger = this.#fingers.get(event.pointerId);
    if (finger === undefined) return;
    const previous = finger.device;
    finger.client = { x: event.clientX, y: event.clientY };
    finger.device = this.#host.point(event.clientX, event.clientY);
    const travel = Math.hypot(finger.client.x - finger.start.x, finger.client.y - finger.start.y);
    if (travel >= TAP_SLOP_CSS_PIXELS) this.#sequence.moved = true;
    const state = this.#state;
    if (state.kind === "pending" && state.id === event.pointerId)
      state.events.push(["move", event]);
    else if (state.kind === "tool" && state.id === event.pointerId) this.#host.tool("move", event);
    else if (state.kind === "pan" && state.id === event.pointerId) {
      this.#host.pan(finger.device.x - previous.x, finger.device.y - previous.y);
    } else if (state.kind === "gesture" && this.#frame === undefined) {
      this.#frame = this.#timing.schedule(() => {
        this.#frame = undefined;
        this.#flushPinch();
      });
    }
  }

  up(event: E): void {
    this.#release("up", event);
  }

  cancel(event: E): void {
    this.#release("cancel", event);
  }

  /**
   * A pen or mouse took over the canvas (palm rejection): a touch stroke is cancelled, and the
   * fingers still down are ignored until they lift.
   */
  interrupt(event: E): void {
    const state = this.#state;
    if (state.kind === "pending") this.#clearTimer();
    if (state.kind === "tool") this.#host.tool("cancel", event);
    this.#stopFrame();
    this.#sequence.interrupted = true;
    this.#state = this.#fingers.size > 0 ? { kind: "ignored" } : { kind: "idle" };
  }

  /** Stops the timers, for when the canvas goes away. */
  dispose(): void {
    this.#clearTimer();
    this.#stopFrame();
    this.#fingers.clear();
    this.#state = { kind: "idle" };
  }

  #release(phase: "up" | "cancel", event: E): void {
    if (!this.#fingers.has(event.pointerId)) return;
    const state = this.#state;
    if (state.kind === "gesture") this.#flushPinch();
    this.#fingers.delete(event.pointerId);
    const left = this.#fingers.size;
    switch (state.kind) {
      case "pending":
        if (state.id !== event.pointerId) break;
        this.#clearTimer();
        if (phase === "up") {
          this.#replay(state);
          this.#host.tool("up", event);
        }
        this.#state = { kind: "idle" };
        break;
      case "tool":
        if (state.id !== event.pointerId) break;
        this.#host.tool(phase, event);
        this.#state = left > 0 ? { kind: "ignored" } : { kind: "idle" };
        break;
      case "pan":
        if (state.id === event.pointerId)
          this.#state = left > 0 ? { kind: "ignored" } : { kind: "idle" };
        break;
      case "gesture":
        if (left >= 2) this.#sent = this.#span();
        else {
          this.#stopFrame();
          this.#sent = undefined;
          this.#state = left > 0 ? { kind: "ignored" } : { kind: "idle" };
        }
        break;
      case "ignored":
      case "idle":
        if (left === 0) this.#state = { kind: "idle" };
        break;
    }
    if (left === 0 && phase === "up") this.#maybeTap();
  }

  #maybeTap(): void {
    const { start, fingers, moved, interrupted } = this.#sequence;
    if (fingers < 2 || moved || interrupted || this.#timing.now() - start > TAP_MAX_MS) return;
    this.#host.tap(fingers);
  }

  #startTool(): void {
    this.#timer = undefined;
    const state = this.#state;
    if (state.kind !== "pending") return;
    this.#state = { kind: "tool", id: state.id };
    this.#replay(state);
  }

  #replay(state: Extract<State, { kind: "pending" }>): void {
    for (const [phase, event] of state.events) this.#host.tool(phase, event as E);
  }

  /** Sends the pinch step from the last sent span to the fingers' span now. */
  #flushPinch(): void {
    const from = this.#sent;
    const to = this.#span();
    if (from === undefined || to === undefined) return;
    if (from.x !== to.x || from.y !== to.y || from.distance !== to.distance) {
      this.#host.pinch(from, to);
    }
    this.#sent = to;
  }

  /** The span of the first two fingers down. */
  #span(): TouchSpan | undefined {
    const [first, second] = this.#fingers.values();
    return first === undefined || second === undefined
      ? undefined
      : touchSpan(first.device, second.device);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#timing.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #stopFrame(): void {
    if (this.#frame === undefined) return;
    this.#timing.unschedule(this.#frame);
    this.#frame = undefined;
  }
}
