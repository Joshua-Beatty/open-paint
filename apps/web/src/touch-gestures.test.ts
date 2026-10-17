import { describe, expect, it } from "vitest";
import {
  TAP_MAX_MS,
  TOUCH_GRACE_MS,
  type TouchEventLike,
  TouchGestures,
  type TouchInputMode,
} from "./touch-gestures";
import type { TouchSpan } from "./touch-pinch";

interface Fake {
  readonly gestures: TouchGestures<TouchEventLike>;
  readonly log: string[];
  readonly pinches: [TouchSpan, TouchSpan][];
  advance(ms: number): void;
  frame(): void;
  mode: TouchInputMode;
}

function fake(): Fake {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  let frames: (() => void)[] = [];
  const log: string[] = [];
  const pinches: [TouchSpan, TouchSpan][] = [];
  const state: Fake = {
    mode: "draw",
    log,
    pinches,
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
    },
    frame() {
      const run = frames;
      frames = [];
      for (const callback of run) callback();
    },
    gestures: undefined as unknown as TouchGestures<TouchEventLike>,
  };
  const gestures = new TouchGestures<TouchEventLike>(
    {
      tool: (phase, event) =>
        log.push(`${phase} ${event.pointerId} ${event.clientX},${event.clientY}`),
      pinch: (from, to) => pinches.push([from, to]),
      pan: (dx, dy) => log.push(`pan ${dx},${dy}`),
      tap: (fingers) => log.push(`tap ${fingers}`),
      point: (x, y) => ({ x: x * 2, y: y * 2 }),
      mode: () => state.mode,
    },
    {
      now: () => now,
      setTimer: (run, ms) => {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        timers = timers.filter((timer) => timer !== handle);
      },
      schedule: (callback) => {
        frames.push(callback);
        return callback;
      },
      unschedule: (handle) => {
        frames = frames.filter((callback) => callback !== handle);
      },
    },
  );
  return Object.assign(state, { gestures });
}

const touch = (pointerId: number, clientX: number, clientY: number): TouchEventLike => ({
  pointerId,
  clientX,
  clientY,
});

describe("TouchGestures", () => {
  it("holds a lone touch for the grace time, then gives the tool every event in order", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.gestures.move(touch(1, 12, 10));
    expect(f.log).toEqual([]);
    f.advance(TOUCH_GRACE_MS);
    expect(f.log).toEqual(["down 1 10,10", "move 1 12,10"]);
    f.gestures.move(touch(1, 20, 10));
    f.gestures.up(touch(1, 20, 10));
    expect(f.log).toEqual(["down 1 10,10", "move 1 12,10", "move 1 20,10", "up 1 20,10"]);
  });

  it("gives a quick tap to the tool at once when the finger lifts", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.gestures.up(touch(1, 10, 10));
    expect(f.log).toEqual(["down 1 10,10", "up 1 10,10"]);
    f.advance(TOUCH_GRACE_MS);
    expect(f.log).toHaveLength(2);
  });

  it("never shows the tool a touch that a second finger joins within the grace time", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.gestures.down(touch(2, 30, 10));
    f.advance(TOUCH_GRACE_MS);
    f.gestures.move(touch(2, 50, 10));
    f.frame();
    f.gestures.up(touch(1, 10, 10));
    f.gestures.up(touch(2, 50, 10));
    expect(f.log).toEqual([]);
    expect(f.pinches).toHaveLength(1);
  });

  it("cancels the tool's stroke when a second finger lands after the grace time", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.advance(TOUCH_GRACE_MS);
    f.gestures.move(touch(1, 15, 10));
    f.gestures.down(touch(2, 40, 10));
    f.gestures.move(touch(1, 20, 10));
    f.gestures.up(touch(2, 40, 10));
    // The finger left behind does not draw again.
    f.gestures.move(touch(1, 30, 10));
    f.gestures.up(touch(1, 30, 10));
    expect(f.log).toEqual(["down 1 10,10", "move 1 15,10", "cancel 2 40,10"]);
  });

  it("pinches once per frame from the last sent span, in device pixels", () => {
    const f = fake();
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 10, 0));
    f.gestures.move(touch(2, 20, 0));
    f.gestures.move(touch(2, 30, 0));
    expect(f.pinches).toEqual([]);
    f.frame();
    expect(f.pinches).toEqual([
      [
        { x: 10, y: 0, distance: 20 },
        { x: 30, y: 0, distance: 60 },
      ],
    ]);
    f.gestures.move(touch(1, 10, 0));
    f.frame();
    expect(f.pinches[1]).toEqual([
      { x: 30, y: 0, distance: 60 },
      { x: 40, y: 0, distance: 40 },
    ]);
  });

  it("sends the last movement before a finger lifts, and starts again from the new pair", () => {
    const f = fake();
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 10, 0));
    f.gestures.down(touch(3, 0, 10));
    f.gestures.move(touch(2, 20, 0));
    f.gestures.up(touch(1, 0, 0));
    expect(f.pinches).toHaveLength(1);
    f.frame();
    expect(f.pinches).toHaveLength(1);
    f.gestures.move(touch(3, 0, 20));
    f.frame();
    expect(f.pinches[1]?.[0]).toEqual({ x: 20, y: 10, distance: Math.hypot(40, 20) });
  });

  it("reports a still two-finger tap and a three-finger tap", () => {
    const f = fake();
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 50, 0));
    f.advance(100);
    f.gestures.up(touch(1, 0, 0));
    f.gestures.up(touch(2, 50, 0));
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 50, 0));
    f.gestures.down(touch(3, 90, 0));
    f.gestures.up(touch(1, 0, 0));
    f.gestures.up(touch(2, 50, 0));
    f.gestures.up(touch(3, 90, 0));
    expect(f.log).toEqual(["tap 2", "tap 3"]);
  });

  it("reports no tap when the fingers moved or stayed down too long", () => {
    const f = fake();
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 50, 0));
    f.gestures.move(touch(2, 70, 0));
    f.gestures.up(touch(1, 0, 0));
    f.gestures.up(touch(2, 70, 0));
    f.gestures.down(touch(1, 0, 0));
    f.gestures.down(touch(2, 50, 0));
    f.advance(TAP_MAX_MS + 1);
    f.gestures.up(touch(1, 0, 0));
    f.gestures.up(touch(2, 50, 0));
    expect(f.log).toEqual([]);
  });

  it("pans with one finger in navigate mode, and never reaches the tool", () => {
    const f = fake();
    f.mode = "navigate";
    f.gestures.down(touch(1, 10, 10));
    f.advance(TOUCH_GRACE_MS);
    f.gestures.move(touch(1, 15, 12));
    f.gestures.up(touch(1, 15, 12));
    expect(f.log).toEqual(["pan 10,4"]);
  });

  it("cancels a touch stroke and ignores the fingers when a pen takes over", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.advance(TOUCH_GRACE_MS);
    f.gestures.interrupt(touch(9, 0, 0));
    f.gestures.move(touch(1, 20, 10));
    f.gestures.up(touch(1, 20, 10));
    expect(f.log).toEqual(["down 1 10,10", "cancel 9 0,0"]);
    expect(f.gestures.active).toBe(false);
    f.gestures.down(touch(1, 10, 10));
    f.gestures.up(touch(1, 10, 10));
    expect(f.log).toHaveLength(4);
  });

  it("drops a pending touch that a pen interrupts", () => {
    const f = fake();
    f.gestures.down(touch(1, 10, 10));
    f.gestures.interrupt(touch(9, 0, 0));
    f.advance(TOUCH_GRACE_MS);
    f.gestures.up(touch(1, 10, 10));
    expect(f.log).toEqual([]);
  });
});
