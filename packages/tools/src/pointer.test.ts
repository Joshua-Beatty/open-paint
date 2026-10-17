import { describe, expect, it } from "vitest";
import {
  effectivePressure,
  type ImageMapper,
  isPenEraser,
  type PointerSource,
  toolSamples,
} from "./pointer";

function source(clientX: number, clientY: number, extra: Partial<PointerSource> = {}) {
  return {
    clientX,
    clientY,
    button: 0,
    pressure: 0.5,
    pointerType: "mouse",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...extra,
  } satisfies PointerSource;
}

/** Image pixels are the client point offset by (10, 20) and halved. */
const toImage: ImageMapper = (x, y) => ({ x: (x - 10) / 2, y: (y - 20) / 2 });

describe("toolSamples", () => {
  it("maps a down or up event to one sample in image pixels", () => {
    const samples = toolSamples("down", source(30, 40, { button: 2 }), toImage);
    expect(samples).toEqual([
      {
        type: "down",
        x: 10,
        y: 10,
        button: 2,
        pressure: 1,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        clientX: 30,
        clientY: 40,
      },
    ]);
  });

  it("carries the view's zoom when the mapper knows it, for screen-space hit tests", () => {
    const zoomed: ImageMapper = (x, y) => ({ x: x / 4, y: y / 4, scale: 4 });
    const [sample] = toolSamples("move", source(40, 80), zoomed);
    expect(sample).toMatchObject({ x: 10, y: 20, viewScale: 4 });
  });

  it("expands a move into its coalesced samples, in order", () => {
    const moved = {
      ...source(30, 40),
      getCoalescedEvents: () => [source(12, 22), source(14, 24), source(16, 26)],
    };
    const samples = toolSamples("move", moved, toImage);
    expect(samples.map((sample) => [sample.x, sample.y])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(samples.every((sample) => sample.predicted === undefined)).toBe(true);
  });

  it("falls back to the event itself when no coalesced samples exist", () => {
    const samples = toolSamples("move", source(30, 40), toImage);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ type: "move", x: 10, y: 10 });
  });

  it("adds predicted samples marked as preview-only after the real ones", () => {
    const moved = {
      ...source(30, 40),
      getPredictedEvents: () => [source(40, 60)],
    };
    const samples = toolSamples("move", moved, toImage);
    expect(samples).toHaveLength(2);
    expect(samples[0]?.predicted).toBeUndefined();
    expect(samples[1]).toMatchObject({ x: 15, y: 20, predicted: true });
  });

  it("drops samples that fall outside a laid-out view", () => {
    expect(toolSamples("down", source(30, 40), () => undefined)).toEqual([]);
  });

  it("carries the modifier keys through", () => {
    const [sample] = toolSamples(
      "down",
      source(30, 40, { shiftKey: true, altKey: true, ctrlKey: true }),
      toImage,
    );
    expect(sample).toMatchObject({ shiftKey: true, altKey: true, ctrlKey: true });
  });
});

describe("effectivePressure", () => {
  it("uses the reported pressure of a pen that presses", () => {
    expect(effectivePressure({ pointerType: "pen", pressure: 0.3 })).toBe(0.3);
  });

  it("uses full pressure for mouse input and for a pen that reports none", () => {
    expect(effectivePressure({ pointerType: "mouse", pressure: 0.5 })).toBe(1);
    expect(effectivePressure({ pointerType: "pen", pressure: 0 })).toBe(1);
    expect(effectivePressure({ pointerType: "touch", pressure: 0.2 })).toBe(1);
  });
});

describe("isPenEraser", () => {
  it("is true for the pen's eraser end on press (button 5) and while it is held (buttons 32)", () => {
    expect(isPenEraser({ pointerType: "pen", button: 5, buttons: 32 })).toBe(true);
    expect(isPenEraser({ pointerType: "pen", button: -1, buttons: 32 })).toBe(true);
  });

  it("is false for the pen tip, the pen's barrel buttons and other pointers", () => {
    expect(isPenEraser({ pointerType: "pen", button: 0, buttons: 1 })).toBe(false);
    expect(isPenEraser({ pointerType: "pen", button: 2, buttons: 2 })).toBe(false);
    expect(isPenEraser({ pointerType: "pen", button: -1, buttons: 0 })).toBe(false);
    expect(isPenEraser({ pointerType: "mouse", button: 5, buttons: 32 })).toBe(false);
    expect(isPenEraser({ pointerType: "touch", button: 0, buttons: 0 })).toBe(false);
  });
});
