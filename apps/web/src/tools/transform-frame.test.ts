import {
  type AffineMatrix,
  applyAffine,
  rect,
  rotationAboutAffine,
  translationAffine,
} from "@openpaint/document";
import { describe, expect, it, vi } from "vitest";
import { rotateCursor } from "./cursors";
import {
  FRAME_HANDLES,
  type FrameGesture,
  type FrameStart,
  frameCursor,
  frameGeometry,
  gestureCursor,
  gestureFor,
  gestureResult,
  handleAxis,
  hitFrame,
  MIN_SCALE,
  pixelFrameGeometry,
  pixelGestureResult,
  ROTATION_SNAP,
  resetPoint,
  snapFrameToPixels,
  transformFrame,
} from "./transform-frame";

const SOURCE = rect(0, 0, 10, 10);
const IDENTITY = translationAffine(0, 0);
const NO_MODIFIERS = { shift: false, alt: false };
const CENTER = { x: 5, y: 5 };

function startAt(press: { x: number; y: number }, anchor = CENTER, m = IDENTITY): FrameStart {
  return { m, anchor, press };
}

function at(m: ReturnType<typeof translationAffine>, p: { x: number; y: number }) {
  return applyAffine(m, p.x, p.y);
}

describe("frameGeometry", () => {
  it("puts the handles on the source's edges and corners, with the anchor at the centre", () => {
    const geometry = frameGeometry(SOURCE, IDENTITY, CENTER);
    expect(geometry.handles.nw).toEqual({ x: 0, y: 0 });
    expect(geometry.handles.n).toEqual({ x: 5, y: 0 });
    expect(geometry.handles.se).toEqual({ x: 10, y: 10 });
    expect(geometry.handles.w).toEqual({ x: 0, y: 5 });
    expect(geometry.corners).toHaveLength(4);
    expect(geometry.anchor).toEqual(CENTER);
    expect(resetPoint(geometry.anchor)).toEqual({ x: 19, y: 19 });
    // The reset button keeps its distance on screen: 14 CSS px is 3.5 image px at 400 %.
    expect(resetPoint(geometry.anchor, 4)).toEqual({ x: 8.5, y: 8.5 });
    expect(Object.keys(geometry.handles).sort()).toEqual([...FRAME_HANDLES].sort());
  });

  it("follows the transform", () => {
    const geometry = frameGeometry(SOURCE, translationAffine(3, -2), CENTER);
    expect(geometry.handles.nw).toEqual({ x: 3, y: -2 });
    expect(geometry.anchor).toEqual({ x: 8, y: 3 });
  });
});

describe("hitFrame", () => {
  /** A 40 x 40 frame, so the anchor's radius leaves room inside for the body. */
  const FRAME = rect(0, 0, 40, 40);
  const FRAME_CENTER = { x: 20, y: 20 };

  it("finds the anchor, the reset button and the handles before the frame's body", () => {
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 20.5, y: 20 }, 0)).toEqual({
      kind: "anchor",
    });
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 34, y: 34 }, 0)).toEqual({ kind: "reset" });
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 40.5, y: 40 }, 0)).toEqual({
      kind: "handle",
      handle: "se",
    });
  });

  it("moves from inside the frame and rotates from just outside it", () => {
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 10, y: 10 }, 0)).toEqual({ kind: "move" });
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: -8, y: -8 }, 0)).toEqual({
      kind: "rotate",
    });
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: -40, y: -40 }, 0)).toBeUndefined();
  });

  it("rotates from anywhere with the right button, but still grabs the handles", () => {
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 10, y: 10 }, 2)).toEqual({
      kind: "rotate",
    });
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 0, y: 0 }, 2)).toEqual({
      kind: "handle",
      handle: "nw",
    });
  });

  it("measures the handles and the rotate zone in CSS pixels at the view's zoom", () => {
    // 4 image px from the se handle: 16 CSS px at 400 %, 1 CSS px at 25 %.
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 44, y: 40 }, 0, 4)?.kind).toBe("rotate");
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 44, y: 40 }, 0, 0.25)).toEqual({
      kind: "handle",
      handle: "se",
    });
    // 12 image px outside: within the 16 CSS px rotate zone at 100 %, outside it at 400 %.
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 52, y: 20 }, 0)?.kind).toBe("rotate");
    expect(hitFrame(FRAME, IDENTITY, FRAME_CENTER, { x: 52, y: 20 }, 0, 4)).toBeUndefined();
  });
});

describe("frame cursors (TL-MOVE-01, TL-FRAME-06)", () => {
  const FRAME = rect(0, 0, 40, 20);
  const cursorAt = (m: AffineMatrix, p: { x: number; y: number }) =>
    frameCursor(hitFrame(FRAME, m, { x: 20, y: 10 }, p, 0), FRAME, m, p);

  it("gives each handle the resize cursor of its direction, corners on the diagonal", () => {
    const geometry = frameGeometry(FRAME, IDENTITY, { x: 20, y: 10 });
    expect(cursorAt(IDENTITY, geometry.handles.nw)).toBe("nwse-resize");
    expect(cursorAt(IDENTITY, geometry.handles.ne)).toBe("nesw-resize");
    expect(cursorAt(IDENTITY, geometry.handles.n)).toBe("ns-resize");
    expect(cursorAt(IDENTITY, geometry.handles.w)).toBe("ew-resize");
  });

  it("turns the resize cursors with a rotated frame", () => {
    // Turned 45° counter-clockwise: the east edge faces up and right.
    const turned = rotationAboutAffine(20, 10, -Math.PI / 4);
    const geometry = frameGeometry(FRAME, turned, { x: 20, y: 10 });
    expect(handleAxis(turned, "e").x).toBeCloseTo(Math.SQRT1_2);
    expect(cursorAt(turned, geometry.handles.e)).toBe("nesw-resize");
    expect(cursorAt(turned, geometry.handles.n)).toBe("nwse-resize");
    expect(cursorAt(turned, geometry.handles.ne)).toBe("ns-resize");
  });

  it("shows the move arrows inside, a hand on the anchor, a button on reset and a rotate arrow outside", () => {
    const geometry = frameGeometry(FRAME, IDENTITY, { x: 20, y: 10 });
    expect(cursorAt(IDENTITY, { x: 8, y: 6 })).toBe("move");
    expect(cursorAt(IDENTITY, geometry.anchor)).toBe("grab");
    expect(cursorAt(IDENTITY, resetPoint(geometry.anchor))).toBe("pointer");
    expect(cursorAt(IDENTITY, { x: 50, y: 10 })).toContain("data:image/svg+xml");
    expect(cursorAt(IDENTITY, { x: 90, y: 10 })).toBeUndefined();
  });

  it("keeps a gesture's cursor while it is dragged", () => {
    const start = startAt({ x: 8, y: 6 });
    expect(gestureCursor({ kind: "move", start }, FRAME, IDENTITY, { x: 30, y: 30 })).toBe("move");
    expect(gestureCursor({ kind: "anchor", start }, FRAME, IDENTITY, { x: 3, y: 3 })).toBe(
      "grabbing",
    );
    expect(
      gestureCursor({ kind: "scale", start, handle: "s" }, FRAME, IDENTITY, { x: 0, y: 90 }),
    ).toBe("ns-resize");
    expect(gestureCursor({ kind: "rotate", start }, FRAME, IDENTITY, { x: 60, y: 10 })).toBe(
      rotateCursor(40, 0),
    );
  });
});

describe("gestureResult", () => {
  it("moves by whole pixels, so moved pixels keep their values", () => {
    const gesture = gestureFor({ kind: "move" }, startAt({ x: 5, y: 5 })) as FrameGesture;
    const result = gestureResult(SOURCE, gesture, { x: 7.4, y: 5.6 }, NO_MODIFIERS);
    expect(result.m).toEqual(translationAffine(2, 1));
  });

  it("rotates about the anchor, snapping to 15 degree steps with Shift", () => {
    const start = startAt({ x: 10, y: 5 });
    const gesture: FrameGesture = { kind: "rotate", start };
    const plain = gestureResult(SOURCE, gesture, { x: 5, y: 10 }, NO_MODIFIERS);
    const turned = at(plain.m, { x: 10, y: 5 });
    expect(turned.x).toBeCloseTo(5, 9);
    expect(turned.y).toBeCloseTo(10, 9);

    const snapped = gestureResult(
      SOURCE,
      gesture,
      { x: 5 + 5 * Math.cos(0.33), y: 5 + 5 * Math.sin(0.33) },
      { shift: true, alt: false },
    );
    const angle = Math.atan2(
      at(snapped.m, { x: 10, y: 5 }).y - 5,
      at(snapped.m, { x: 10, y: 5 }).x - 5,
    );
    expect(angle / ROTATION_SNAP).toBeCloseTo(Math.round(angle / ROTATION_SNAP), 9);
  });

  it("scales a corner from the opposite corner", () => {
    const gesture: FrameGesture = { kind: "scale", start: startAt({ x: 10, y: 10 }), handle: "se" };
    const result = gestureResult(SOURCE, gesture, { x: 20, y: 10 }, NO_MODIFIERS);
    expect(at(result.m, { x: 10, y: 10 })).toEqual({ x: 20, y: 10 });
    expect(at(result.m, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps the aspect ratio of a corner with Shift", () => {
    const gesture: FrameGesture = { kind: "scale", start: startAt({ x: 10, y: 10 }), handle: "se" };
    const result = gestureResult(SOURCE, gesture, { x: 20, y: 10 }, { shift: true, alt: false });
    expect(at(result.m, { x: 10, y: 10 })).toEqual({ x: 20, y: 20 });
  });

  it("scales an edge along its axis, and keeps the opposite edge in place", () => {
    const gesture: FrameGesture = { kind: "scale", start: startAt({ x: 10, y: 5 }), handle: "e" };
    const result = gestureResult(SOURCE, gesture, { x: 20, y: 5 }, NO_MODIFIERS);
    expect(at(result.m, { x: 10, y: 5 })).toEqual({ x: 20, y: 5 });
    expect(at(result.m, { x: 10, y: 0 })).toEqual({ x: 20, y: 0 });
    expect(at(result.m, { x: 0, y: 5 })).toEqual({ x: 0, y: 5 });
  });

  it("scales uniformly about the centre with Alt", () => {
    const gesture: FrameGesture = { kind: "scale", start: startAt({ x: 10, y: 10 }), handle: "se" };
    const result = gestureResult(SOURCE, gesture, { x: 20, y: 10 }, { shift: false, alt: true });
    expect(at(result.m, { x: 10, y: 10 })).toEqual({ x: 20, y: 20 });
    expect(at(result.m, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it("never collapses the content to zero size", () => {
    const gesture: FrameGesture = { kind: "scale", start: startAt({ x: 10, y: 10 }), handle: "se" };
    const result = gestureResult(SOURCE, gesture, { x: 0, y: 0 }, NO_MODIFIERS);
    const corner = at(result.m, { x: 10, y: 10 });
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.x).toBeLessThan(10 * MIN_SCALE * 10);
  });

  it("moves the anchor to the pointer without changing the transform", () => {
    const moved = translationAffine(4, 0);
    const gesture: FrameGesture = { kind: "anchor", start: startAt({ x: 5, y: 5 }, CENTER, moved) };
    const result = gestureResult(SOURCE, gesture, { x: 9, y: 7 }, NO_MODIFIERS);
    expect(result.m).toBe(moved);
    expect(result.anchor).toEqual({ x: 5, y: 7 });
  });
});

describe("transformFrame", () => {
  it("tells its subscribers when the frame changes", () => {
    const listener = vi.fn();
    const stop = transformFrame.subscribe(listener);
    transformFrame.set(frameGeometry(SOURCE, IDENTITY, CENTER));
    expect(transformFrame.state?.anchor).toEqual(CENTER);
    transformFrame.set(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("pixel frames of the move tools (owner request: selections are pixel based)", () => {
  const FRAME = rect(3, 4, 13, 9);
  const MIDDLE = { x: 3 + 13 / 2, y: 4 + 9 / 2 };
  const scaleBy = (
    handle: (typeof FRAME_HANDLES)[number],
    press: { x: number; y: number },
    p: { x: number; y: number },
    modifiers = NO_MODIFIERS,
    m = IDENTITY,
    anchor = MIDDLE,
  ) =>
    pixelGestureResult(
      FRAME,
      { kind: "scale", start: startAt(press, anchor, m), handle },
      p,
      modifiers,
    );
  const isWhole = (p: { x: number; y: number }) => Number.isInteger(p.x) && Number.isInteger(p.y);
  const turnBy = (degrees: number, anchor = MIDDLE, m = IDENTITY, modifiers = NO_MODIFIERS) => {
    const pivot = applyAffine(m, anchor.x, anchor.y);
    const press = { x: pivot.x + 40, y: pivot.y };
    const t = (degrees * Math.PI) / 180;
    const p = { x: pivot.x + 40 * Math.cos(t), y: pivot.y + 40 * Math.sin(t) };
    return pixelGestureResult(
      FRAME,
      { kind: "rotate", start: startAt(press, anchor, m) },
      p,
      modifiers,
    );
  };

  it("resizes in whole-pixel steps, even when the pointer moves less than a pixel at a time", () => {
    // At 800 % a 3.5 CSS px pointer step is 0.4375 image pixels.
    const press = { x: 16, y: 13 };
    const seen: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const p = { x: press.x + (i * 3.5) / 8, y: press.y + (i * 3.5) / 8 };
      const { m, anchor } = scaleBy("se", press, p);
      const geometry = pixelFrameGeometry(FRAME, m, anchor);
      for (const corner of geometry.corners) expect(isWhole(corner)).toBe(true);
      expect(geometry.handles.nw).toEqual({ x: 3, y: 4 });
      // The dragged corner is at the pixel corner nearest the pointer.
      expect(geometry.handles.se).toEqual({ x: Math.round(p.x), y: Math.round(p.y) });
      seen.push(geometry.handles.se.x);
    }
    for (let i = 1; i < seen.length; i++) {
      expect([0, 1]).toContain((seen[i] ?? 0) - (seen[i - 1] ?? 0));
    }
  });

  it("keeps edge handles on pixel edges and the centre anchor at the frame's centre", () => {
    const { handles, anchor } = pixelFrameGeometry(FRAME, IDENTITY, MIDDLE);
    expect(handles.n).toEqual({ x: 9.5, y: 4 });
    expect(handles.e).toEqual({ x: 16, y: 8.5 });
    expect(anchor).toEqual(MIDDLE);
  });

  it("resizes about the centre with Alt, keeping it, and never below one pixel", () => {
    const { m } = scaleBy("e", { x: 16, y: 8.5 }, { x: 18.3, y: 8.5 }, { shift: false, alt: true });
    const geometry = pixelFrameGeometry(FRAME, m, MIDDLE);
    expect(geometry.handles.w.x).toBe(1);
    expect(geometry.handles.e.x).toBe(18);
    const collapsed = scaleBy("e", { x: 16, y: 8.5 }, { x: 3.2, y: 8.5 }).m;
    const thin = pixelFrameGeometry(FRAME, collapsed, MIDDLE);
    expect(thin.handles.w.x).toBe(3);
    expect(thin.handles.e.x).toBe(4);
    const flipped = scaleBy("e", { x: 16, y: 8.5 }, { x: -2.6, y: 8.5 }).m;
    const mirror = pixelFrameGeometry(FRAME, flipped, MIDDLE);
    expect(mirror.handles.w.x).toBe(3);
    expect(mirror.handles.e.x).toBe(-3);
  });

  it("moves by whole pixels", () => {
    const start = startAt({ x: 8, y: 8 });
    const { m } = pixelGestureResult(
      FRAME,
      { kind: "move", start },
      { x: 10.6, y: 7.4 },
      NO_MODIFIERS,
    );
    expect(m).toEqual(translationAffine(3, -1));
  });

  it("rotates freely, drawing the rotated frame's corners on pixel corners", () => {
    const { m, anchor } = turnBy(20);
    expect(Math.atan2(m.b, m.a)).toBeCloseTo((20 * Math.PI) / 180, 9);
    const geometry = pixelFrameGeometry(FRAME, m, anchor);
    for (const corner of geometry.corners) expect(isWhole(corner)).toBe(true);
    // The anchor stays the turn's centre.
    expect(geometry.anchor.x).toBeCloseTo(MIDDLE.x, 9);
    expect(geometry.anchor.y).toBeCloseTo(MIDDLE.y, 9);
  });

  it("turns about a moved anchor's pixel corner, and lands on pixels at a quarter turn", () => {
    const anchor = { x: 6.3, y: 7.8 };
    // Shift snaps the turn to 15 degree steps, so a drag near a quarter turn makes one exactly.
    const { m, anchor: after } = turnBy(88, anchor, IDENTITY, { shift: true, alt: false });
    expect(after).toEqual({ x: 6, y: 8 });
    expect(m.a).toBe(0);
    expect(m.d).toBe(0);
    for (const value of [m.b, m.c, m.e, m.f]) expect(Number.isInteger(value)).toBe(true);
    const geometry = pixelFrameGeometry(FRAME, m, after);
    expect(geometry.anchor).toEqual({ x: 6, y: 8 });
    for (const corner of geometry.corners) expect(isWhole(corner)).toBe(true);
  });

  it("keeps a rotated frame's sides whole pixels long when resized", () => {
    const turned = turnBy(30).m;
    const { m } = scaleBy("e", { x: 0, y: 0 }, { x: 20.2, y: 14.1 }, NO_MODIFIERS, turned);
    const width = FRAME.width * Math.hypot(m.a, m.b);
    const height = FRAME.height * Math.hypot(m.c, m.d);
    expect(width).toBeCloseTo(Math.round(width), 9);
    expect(height).toBeCloseTo(9, 9);
  });

  it("drags the anchor to the nearest pixel corner, or to the centre when that is nearer", () => {
    const drag = (p: { x: number; y: number }) =>
      pixelGestureResult(
        FRAME,
        { kind: "anchor", start: startAt({ x: 9.5, y: 8.5 }, MIDDLE) },
        p,
        NO_MODIFIERS,
      ).anchor;
    expect(drag({ x: 12.3, y: 6.6 })).toEqual({ x: 12, y: 7 });
    expect(drag({ x: 9.4, y: 8.6 })).toEqual(MIDDLE);
  });

  it("snaps a frame left between pixels, as an older selection's, onto pixels when next transformed", () => {
    const m = { a: 1.03, b: 0, c: 0, d: 0.97, e: 0.4, f: -0.2 };
    const snapped = snapFrameToPixels(FRAME, m);
    const corners = pixelFrameGeometry(FRAME, snapped, MIDDLE).corners;
    const exact = frameGeometry(FRAME, snapped, MIDDLE).corners;
    expect(exact).toEqual(corners);
  });
});
