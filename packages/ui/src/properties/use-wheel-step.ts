import { type RefObject, useEffect, useRef } from "react";

/** One wheel notch in CSS px (WEB-PTR-05): 100 px, or 3 lines. */
const NOTCH_PX = 100;
const LINE_PX = NOTCH_PX / 3;
/** A delta this large is a whole mouse-wheel notch; smaller ones (trackpads) add up to a notch. */
const MOUSE_NOTCH_PX = 50;

/** A wheel event's delta in CSS px, the vertical axis first (Shift+wheel arrives as horizontal). */
export function wheelDeltaPx(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): number {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return delta * LINE_PX;
  if (event.deltaMode === 2) return delta * NOTCH_PX * 3;
  return delta;
}

/**
 * Turns a run of wheel deltas into whole steps: each mouse notch is one step, and trackpad deltas
 * add up until they make a notch. Wheel up (a negative delta) steps up.
 */
export class WheelStepper {
  private carried = 0;

  steps(deltaPx: number): number {
    if (Math.abs(deltaPx) >= MOUSE_NOTCH_PX) {
      this.carried = 0;
      return -Math.sign(deltaPx);
    }
    this.carried += deltaPx;
    if (Math.abs(this.carried) < NOTCH_PX) return 0;
    const whole = Math.trunc(this.carried / NOTCH_PX);
    this.carried -= whole * NOTCH_PX;
    return -whole;
  }
}

/**
 * Steps a number control with the mouse wheel while the pointer is over it (TL-OPT-BRUSH: the
 * size box steps like its −/+ buttons). `onStep` gets the signed number of steps and whether Ctrl
 * was held, which makes each step five times larger. The page does not scroll or zoom meanwhile.
 * The listener is native and not passive, since React's wheel listeners cannot prevent the default.
 */
export function useWheelStep<T extends HTMLElement>(
  onStep: (steps: number, large: boolean) => void,
  disabled: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const latest = useRef(onStep);
  latest.current = onStep;
  useEffect(() => {
    const element = ref.current;
    if (element === null || disabled) return;
    const stepper = new WheelStepper();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const steps = stepper.steps(wheelDeltaPx(event));
      if (steps !== 0) latest.current(steps, event.ctrlKey);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [disabled]);
  return ref;
}
